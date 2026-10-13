/**
 * The command line. Every command reads and writes the one store; nothing
 * here sends email or touches a CRM.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Store } from './db.ts';
import type { Account, Profile, Signal, Tier } from './types.ts';
import { TIERS } from './types.ts';
import { pool } from './util.ts';
import { parseImport, resolveDomain } from './accounts.ts';
import { collectHiring } from './collect/hiring.ts';
import { collectStack } from './collect/stack.ts';
import { collectNews } from './collect/news.ts';
import { ledger, scoreByJudge, scoreByRules } from './score.ts';
import { writeDraft } from './draft.ts';
import { evalMarkdown, evaluate } from './evals.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.SIGNALPIPE_HOME ?? REPO;
const DB = process.env.SIGNALPIPE_DB ?? join(HOME, 'data', 'signalpipe.db');
const PROFILE = process.env.SIGNALPIPE_PROFILE ?? join(HOME, 'profile', 'profile.json');
const OUT = join(HOME, 'out');
const DEFAULT_MODEL = 'sonnet';

const HELP = `signalpipe — watch accounts for buying signals, score them with cited evidence, draft outreach, measure the judgment

  signalpipe import <accounts.json>          add accounts ([{name, domain?, ats?, slug?, tags?}]; jobpipe's companies.json works)
  signalpipe domains [--retry]               find missing website domains (kept only when the homepage names the account)
  signalpipe accounts                        list accounts and what is known about them
  signalpipe collect [--only hiring,stack,news] [--account A] [--concurrency 6]
                                             gather signals from job boards, homepages and news
  signalpipe score [--judge] [--limit N] [--account A] [--model M]
                                             rules score everything; --judge also asks Claude (cited reasons only)
  signalpipe top [--method rules|judge] [--tier hot] [--n 20]
  signalpipe show <account>                  the evidence ledger, scores and draft for one account
  signalpipe draft <account> [--model M]     write an outreach draft from cited signals (never sent)
  signalpipe label-sheet [--n 30]            accounts to label, with signals but no scores (blind)
  signalpipe label <account> <hot|warm|cold> [--note TEXT]
  signalpipe eval                            compare rules and judge against your labels; writes out/evals/

Env: SIGNALPIPE_HOME, SIGNALPIPE_DB, SIGNALPIPE_PROFILE`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args: string[], name: string) => args.includes(name);

function loadProfile(): Profile {
  if (!existsSync(PROFILE)) {
    throw new Error(`no profile at ${PROFILE}. Copy one from examples/ (e.g. examples/gtm-engineer-job-search/profile.json) to profile/profile.json and edit it.`);
  }
  return JSON.parse(readFileSync(PROFILE, 'utf8'));
}

function mustAccount(store: Store, key: string | undefined): Account {
  if (!key) throw new Error('name an account');
  const a = store.account(key);
  if (!a) throw new Error(`no account "${key}"`);
  return a;
}

function writeOut(rel: string, text: string): string {
  const path = join(OUT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

async function cmdCollect(store: Store, args: string[]) {
  const profile = loadProfile();
  const only = new Set((flag(args, '--only') ?? 'hiring,stack,news').split(','));
  const accounts = flag(args, '--account') ? [mustAccount(store, flag(args, '--account'))] : store.accounts();
  const now = new Date().toISOString();
  const run = store.startRun(`collect:${[...only].join('+')}`);
  let fresh = 0, seen = 0, failed = 0;
  const errors: string[] = [];
  await pool(accounts, Number(flag(args, '--concurrency') ?? 6), async (a) => {
    const tasks: [string, () => Promise<Signal[]>][] = [];
    if (only.has('hiring')) tasks.push(['hiring', async () => (await collectHiring(a, profile, now)).signals]);
    if (only.has('stack')) tasks.push(['stack', () => collectStack(a, now)]);
    if (only.has('news')) tasks.push(['news', () => collectNews(a, profile.signals.news.lookbackDays, now)]);
    for (const [kind, task] of tasks) {
      try {
        for (const s of await task()) (store.recordSignal(s) ? fresh++ : seen++);
      } catch (err) {
        failed++;
        errors.push(`${a.name} ${kind}: ${(err as Error).message}`);
      }
    }
  });
  store.finishRun(run, fresh + seen, failed, errors);
  console.log(`collected from ${accounts.length} accounts: ${fresh} new signals, ${seen} still current, ${failed} failed fetches`);
  for (const e of errors.slice(0, 15)) console.log(`  ! ${e}`);
  if (errors.length > 15) console.log(`  … ${errors.length - 15} more (see the runs table)`);
}

async function cmdScore(store: Store, args: string[]) {
  const profile = loadProfile();
  const now = new Date().toISOString();
  const accounts = flag(args, '--account') ? [mustAccount(store, flag(args, '--account'))] : store.accounts();
  for (const a of accounts) store.saveScore(scoreByRules(a, store.signals(a.id, { currentOnly: true }), profile, now));
  console.log(`rules: scored ${accounts.length} accounts`);
  if (!has(args, '--judge')) return;

  const model = flag(args, '--model') ?? DEFAULT_MODEL;
  const limit = Number(flag(args, '--limit') ?? 25);
  // Judge the accounts with something to judge, strongest rules score first.
  const queue = accounts
    .map((a) => ({ a, rules: store.score(a.id, 'rules')!, signals: store.signals(a.id, { currentOnly: true }) }))
    .filter((x) => x.signals.length)
    .sort((x, y) => y.rules.score - x.rules.score)
    .slice(0, limit);
  let done = 0, failed = 0;
  await pool(queue, 3, async ({ a, signals }) => {
    try {
      const s = await scoreByJudge(a, signals, profile, model, now);
      if (!s) { failed++; console.log(`  ! ${a.name}: judge reply was not usable JSON`); return; }
      store.saveScore(s);
      done++;
      console.log(`  ${a.name}: ${s.tier} ${s.score}${s.citationsBad ? ` (${s.citationsBad} uncited reason${s.citationsBad > 1 ? 's' : ''} dropped)` : ''}`);
    } catch (err) {
      failed++;
      console.log(`  ! ${a.name}: ${(err as Error).message}`);
    }
  });
  console.log(`judge (${model}): ${done} scored, ${failed} failed`);
}

function cmdTop(store: Store, args: string[]) {
  const method = (flag(args, '--method') ?? 'judge') as 'rules' | 'judge';
  const tier = flag(args, '--tier');
  const n = Number(flag(args, '--n') ?? 20);
  let scores = store.scores(method);
  if (!scores.length && method === 'judge') { console.log('no judge scores yet; showing rules (run `score --judge`)'); scores = store.scores('rules'); }
  if (tier) scores = scores.filter((s) => s.tier === tier);
  for (const s of scores.slice(0, n)) {
    const a = store.account(s.accountId)!;
    console.log(`${String(s.score).padStart(3)} ${s.tier.padEnd(4)} ${a.name}`);
    if (s.angle) console.log(`         angle: ${s.angle}`);
    for (const r of s.reasons.slice(0, 3)) console.log(`         · ${r.claim}${r.points !== undefined ? ` (+${r.points})` : ''} [${r.signals.slice(0, 3).join(', ')}${r.signals.length > 3 ? `, +${r.signals.length - 3}` : ''}]`);
  }
}

function cmdShow(store: Store, args: string[]) {
  const a = mustAccount(store, args[1]);
  const signals = store.signals(a.id);
  console.log(`# ${a.name}${a.domain ? ` — ${a.domain} (${a.domainBasis})` : ''}${a.ats ? ` — ${a.ats}:${a.atsSlug}` : ''}\n`);
  console.log(`## Signals (${signals.length})`);
  console.log(signals.length ? ledger(signals) : '(none)');
  for (const method of ['rules', 'judge'] as const) {
    const s = store.score(a.id, method);
    if (!s) continue;
    console.log(`\n## ${method}: ${s.tier} ${s.score}${s.model ? ` (${s.model})` : ''}`);
    for (const r of s.reasons) console.log(`- ${r.claim} [${r.basis}] ${r.signals.join(', ')}`);
    if (s.unknowns.length) console.log(`unknowns: ${s.unknowns.join('; ')}`);
    if (s.angle) console.log(`angle: ${s.angle}`);
  }
  const l = store.labels().find((x) => x.accountId === a.id);
  if (l) console.log(`\nyour label: ${l.tier}${l.note ? ` — ${l.note}` : ''}`);
  const d = store.draft(a.id);
  if (d) console.log(`\n## Draft\nSubject: ${d.subject}\n\n${d.body}\n\n(cites ${d.signals.join(', ')})`);
}

async function cmdDraft(store: Store, args: string[]) {
  const profile = loadProfile();
  const a = mustAccount(store, args[1]);
  const signals = store.signals(a.id, { currentOnly: true });
  if (!signals.length) throw new Error(`${a.name} has no signals to write from; run collect first`);
  const d = await writeDraft(a, signals, store.score(a.id, 'judge'), profile, flag(args, '--model') ?? DEFAULT_MODEL, new Date().toISOString());
  if (!d) throw new Error('the draft cited no known signals, so it was thrown away; try again');
  store.saveDraft(d);
  const cited = signals.filter((s) => d.signals.includes(s.id));
  const path = writeOut(`drafts/${a.id}.md`, `# ${a.name}\n\nSubject: ${d.subject}\n\n${d.body}\n\n---\nGrounded in:\n${cited.map((s) => `- ${s.claim} (${s.sourceUrl})`).join('\n')}\n`);
  console.log(`Subject: ${d.subject}\n\n${d.body}\n\nsaved ${path} (not sent)`);
}

/** Short lines for a person: the claim and the site it came from, three per label. */
function sheetLines(signals: Signal[]): string[] {
  const groups = new Map<string, Signal[]>();
  for (const s of signals) groups.set(s.label, [...(groups.get(s.label) ?? []), s]);
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  return [...groups.values()].flatMap((g) => [
    ...g.slice(0, 3).map((s) => `- ${s.claim}${s.eventAt ? ` · ${s.eventAt.slice(0, 10)}` : ''} · ${host(s.sourceUrl)}`),
    ...(g.length > 3 ? [`  (+${g.length - 3} more like this)`] : []),
  ]);
}

function cmdLabelSheet(store: Store, args: string[]) {
  const n = Number(flag(args, '--n') ?? 30);
  const labeled = new Set(store.labels().map((l) => l.accountId));
  // Spread the sheet across the rules tiers so it isn't all cold accounts,
  // but never show the tiers themselves: labels must be blind to the scores.
  const pools = TIERS.map((t) => store.scores('rules').filter((s) => s.tier === t && !labeled.has(s.accountId)));
  const picked: string[] = [];
  for (let i = 0; picked.length < n && pools.some((p) => i < p.length); i++) {
    for (const p of pools) if (p[i] && picked.length < n) picked.push(p[i].accountId);
  }
  picked.sort();
  const body = picked.map((id) => {
    const a = store.account(id)!;
    const sig = store.signals(id, { currentOnly: true });
    return `## ${a.name}${a.domain ? ` (${a.domain})` : ''}\n\n${sig.length ? sheetLines(sig).join('\n') : '- (no signals)'}\n\nYour call: \`signalpipe label ${id} hot|warm|cold\`\n`;
  }).join('\n');
  const path = writeOut('label-sheet.md', `# Label sheet (${picked.length} accounts)\n\nFor each account: would you reach out this week (hot), keep watching (warm), or skip for now (cold)? Use your own judgment and anything you know; scores are hidden on purpose.\n\n${body}`);
  console.log(`wrote ${path} with ${picked.length} accounts`);
}

function cmdLabel(store: Store, args: string[]) {
  const a = mustAccount(store, args[1]);
  const tier = args[2] as Tier;
  if (!TIERS.includes(tier)) throw new Error('label must be hot, warm or cold');
  store.saveLabel({ accountId: a.id, tier, note: flag(args, '--note') ?? null, labeledAt: new Date().toISOString() });
  console.log(`${a.name}: ${tier}`);
}

function cmdEval(store: Store) {
  const labels = store.labels();
  if (!labels.length) throw new Error('no labels yet; run label-sheet, then label accounts');
  const results = (['rules', 'judge'] as const).map((m) => evaluate(m, labels, store.scores(m))).filter((r) => r.n);
  const names = new Map(store.accounts().map((a) => [a.id, a.name]));
  const date = new Date().toISOString().slice(0, 10);
  const md = evalMarkdown(results, names, date);
  const path = writeOut(`evals/${date}.md`, md);
  console.log(md);
  console.log(`saved ${path}`);
}

async function cmdDomains(store: Store, args: string[]) {
  const missing = store.accounts().filter((a) => !a.domain || (has(args, '--retry') && a.domainBasis === 'inferred'));
  let found = 0;
  await pool(missing, 6, async (a) => {
    const d = await resolveDomain(a);
    if (d) { store.setDomain(a.id, d, 'inferred'); found++; console.log(`  ${a.name}: ${d}`); }
    else console.log(`  ? ${a.name}: not found — add "domain" to the import file`);
  });
  console.log(`domains: ${found} of ${missing.length} found`);
}

function cmdAccounts(store: Store) {
  for (const a of store.accounts()) {
    const n = store.signals(a.id, { currentOnly: true }).length;
    console.log(`${a.id.padEnd(24)} ${(a.domain ?? '-').padEnd(24)} ${(a.ats ? `${a.ats}:${a.atsSlug}` : '-').padEnd(28)} ${n} signals`);
  }
}

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const args = [cmd, ...rest];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  const store = openStore(DB);
  try {
    switch (cmd) {
      case 'import': {
        if (!rest[0]) throw new Error('usage: signalpipe import <accounts.json>');
        const accounts = parseImport(JSON.parse(readFileSync(rest[0], 'utf8')));
        for (const a of accounts) store.upsertAccount(a);
        console.log(`imported ${accounts.length} accounts`);
        break;
      }
      case 'domains': await cmdDomains(store, args); break;
      case 'accounts': cmdAccounts(store); break;
      case 'collect': await cmdCollect(store, args); break;
      case 'score': await cmdScore(store, args); break;
      case 'top': cmdTop(store, args); break;
      case 'show': cmdShow(store, args); break;
      case 'draft': await cmdDraft(store, args); break;
      case 'label-sheet': cmdLabelSheet(store, args); break;
      case 'label': cmdLabel(store, args); break;
      case 'eval': cmdEval(store); break;
      default: console.log(HELP); process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}
