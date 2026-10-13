import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hiringSignals, parseBoard } from './collect/hiring.ts';
import { stackSignals } from './collect/stack.ts';
import { newsSignals, parseRss } from './collect/news.ts';
import { scoreByRules, validateJudgment } from './score.ts';
import { validateDraft } from './draft.ts';
import { evaluate } from './evals.ts';
import { domainCandidates, pageNamesAccount, parseImport } from './accounts.ts';
import { openStore } from './db.ts';
import type { Account, Profile, Signal } from './types.ts';

const profile: Profile = JSON.parse(readFileSync(new URL('../examples/gtm-engineer-job-search/profile.json', import.meta.url), 'utf8'));
const NOW = '2026-10-13T12:00:00.000Z';
const acme: Account = { id: 'acme', name: 'Acme', domain: 'acme.com', domainBasis: 'observed', ats: 'greenhouse', atsSlug: 'acme', tags: [] };

const board = {
  jobs: [
    { id: 1, title: 'GTM Engineer', content: '&lt;p&gt;Build workflows in Clay and HubSpot with LLMs&lt;/p&gt;', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Remote, US' }, first_published: '2026-10-01T00:00:00Z' },
    { id: 2, title: 'Account Executive, Mid-Market', content: '&lt;p&gt;Salesforce experience&lt;/p&gt;', absolute_url: 'https://boards.greenhouse.io/acme/jobs/2' },
    { id: 3, title: 'Senior Backend Engineer', content: '&lt;p&gt;Go and Postgres&lt;/p&gt;', absolute_url: 'https://boards.greenhouse.io/acme/jobs/3' },
  ],
};

test('greenhouse board: escaped HTML decoded, roles matched, tools from descriptions', () => {
  const jobs = parseBoard('greenhouse', board);
  assert.equal(jobs[0].description, 'Build workflows in Clay and HubSpot with LLMs');
  const sigs = hiringSignals(acme, jobs, profile, NOW);
  const hiring = sigs.filter((s) => s.kind === 'hiring');
  assert.deepEqual(hiring.map((s) => s.label).sort(), ['gtm-engineer', 'sales-team']);
  assert.ok(hiring.every((s) => s.basis === 'observed' && s.sourceUrl.startsWith('https://')));
  const tools = sigs.filter((s) => s.kind === 'stack').map((s) => s.label).sort();
  assert.deepEqual(tools, ['tool:clay', 'tool:hubspot', 'tool:llm', 'tool:salesforce']);
  assert.ok(sigs.filter((s) => s.kind === 'stack').every((s) => s.basis === 'inferred'), 'a tool named in a job post is inferred, not observed');
  // Stable IDs: collecting twice yields the same signals.
  assert.deepEqual(hiringSignals(acme, jobs, profile, NOW).map((s) => s.id), sigs.map((s) => s.id));
});

test('homepage stack: script fingerprints are observed, absence records nothing', () => {
  const html = '<html><script src="//js.hs-scripts.com/123.js"></script><script src="https://cdn.segment.com/analytics.js"></script></html>';
  const sigs = stackSignals(acme, html, 'https://acme.com/', NOW);
  assert.deepEqual(sigs.map((s) => s.label).sort(), ['tool:hubspot', 'tool:segment']);
  assert.ok(sigs.every((s) => s.basis === 'observed'));
  assert.equal(stackSignals(acme, '<html></html>', 'https://acme.com/', NOW).length, 0);
});

const rss = `<rss><channel>
<item><title>Acme raises $40M Series B to expand AI sales tools - TechCrunch</title><link>https://news.example/1</link><pubDate>Tue, 07 Oct 2026 10:00:00 GMT</pubDate><source url="https://techcrunch.com">TechCrunch</source></item>
<item><title>Acme lays off 10% of staff - The Verge</title><link>https://news.example/2</link><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><source url="https://theverge.com">The Verge</source></item>
<item><title>Acmeville council approves budget, raises taxes - Local</title><link>https://news.example/3</link><pubDate>Mon, 06 Oct 2026 10:00:00 GMT</pubDate><source url="https://x">Local</source></item>
<item><title>Acme raises Series A - Old News</title><link>https://news.example/4</link><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate><source url="https://x">Old News</source></item>
</channel></rss>`;

test('news: classified headlines naming the account, inside the lookback window', () => {
  const sigs = newsSignals(acme, parseRss(rss), 180, NOW);
  assert.deepEqual(sigs.map((s) => s.label), ['funding', 'layoffs']);
  assert.match(sigs[0].claim, /"Acme raises \$40M Series B to expand AI sales tools" \(TechCrunch\)/);
});

function sig(id: string, kind: Signal['kind'], label: string, basis: Signal['basis'] = 'observed'): Signal {
  return { id, accountId: 'acme', kind, label, claim: `${label} claim`, detail: label, sourceUrl: 'https://x', basis, observedAt: NOW, lastSeen: NOW, eventAt: null };
}

test('rules: weights, caps, negatives, and every reason cites signals', () => {
  const s = scoreByRules(acme, [
    sig('a', 'hiring', 'gtm-engineer'), sig('b', 'hiring', 'gtm-engineer'),
    sig('c', 'hiring', 'sales-team'),
    sig('d', 'stack', 'tool:clay', 'inferred'),
    sig('e', 'news', 'funding'), sig('f', 'news', 'layoffs'),
  ], profile, NOW);
  // gtm-engineer capped at 40, sales 3, clay 10, funding 15, layoffs -25 = 43
  assert.equal(s.score, 43);
  assert.equal(s.tier, 'warm');
  assert.ok(s.reasons.every((r) => r.signals.length > 0));
  assert.equal(s.reasons.find((r) => r.signals.includes('d'))!.basis, 'inferred');
});

test('judge: reasons citing unknown or no signals are dropped and counted', () => {
  const signals = [sig('sig_1', 'hiring', 'gtm-engineer'), sig('sig_2', 'news', 'funding')];
  const s = validateJudgment({
    score: 72, tier: 'hot', angle: 'Their new GTM engineer role',
    reasons: [
      { claim: 'Hiring a GTM engineer', signals: ['sig_1'], basis: 'observed' },
      { claim: 'Made up', signals: ['sig_999'], basis: 'observed' },
      { claim: 'No citation', signals: [], basis: 'inferred' },
      { claim: 'Funded and hiring', signals: ['sig_1', 'sig_2'], basis: 'inferred' },
    ],
  }, signals, acme, profile, 'sonnet', NOW)!;
  assert.equal(s.citationsOk, 2);
  assert.equal(s.citationsBad, 2);
  assert.equal(s.tier, 'hot');
  assert.equal(validateJudgment({ nope: true }, signals, acme, profile, 'sonnet', NOW), null);
});

test('draft: must cite at least one known signal', () => {
  const signals = [sig('sig_1', 'hiring', 'gtm-engineer')];
  assert.equal(validateDraft({ subject: 's', body: 'b', signals: ['sig_x'] }, signals, acme, 'sonnet', NOW), null);
  assert.deepEqual(validateDraft({ subject: 's', body: 'b', signals: ['sig_1', 'sig_x'] }, signals, acme, 'sonnet', NOW)!.signals, ['sig_1']);
});

test('evals: accuracy, within-one, hot precision/recall, kappa', () => {
  const labels = [
    { accountId: 'a', tier: 'hot' as const, note: null, labeledAt: NOW },
    { accountId: 'b', tier: 'hot' as const, note: null, labeledAt: NOW },
    { accountId: 'c', tier: 'warm' as const, note: null, labeledAt: NOW },
    { accountId: 'd', tier: 'cold' as const, note: null, labeledAt: NOW },
  ];
  const mk = (accountId: string, tier: 'hot' | 'warm' | 'cold') => ({ accountId, method: 'judge' as const, score: 0, tier, reasons: [], unknowns: [], angle: null, citationsOk: 3, citationsBad: 1, model: 'x', scoredAt: NOW });
  const r = evaluate('judge', labels, [mk('a', 'hot'), mk('b', 'warm'), mk('c', 'hot'), mk('d', 'cold')]);
  assert.equal(r.n, 4);
  assert.equal(r.accuracy, 0.5);
  assert.equal(r.withinOne, 1);
  assert.equal(r.hotPrecision, 0.5);
  assert.equal(r.hotRecall, 0.5);
  assert.equal(r.citationValidity, 0.75);
  assert.equal(r.confusion.hot.warm, 1);
  assert.ok(r.kappa! > 0 && r.kappa! < 1);
});

test('accounts: jobpipe registry imports as-is; domain guesses; title check', () => {
  const [a] = parseImport([{ name: 'Apollo.io', ats: 'greenhouse', slug: 'apolloio', tags: ['gtm'] }]);
  assert.equal(a.id, 'apolloio');
  assert.equal(a.domain, null);
  assert.deepEqual(domainCandidates(a).slice(0, 2), ['apollo.io', 'apolloio.com']);
  assert.ok(pageNamesAccount('<title>Apollo.io: The AI sales platform</title>', 'Apollo.io'));
  assert.ok(!pageNamesAccount('<title>Domain for sale</title>', 'Apollo.io'));
});

test('store: signals dedupe and refresh last_seen; current-only drops stale hiring', () => {
  const store = openStore(':memory:');
  store.upsertAccount(acme);
  const s = sig('sig_1', 'hiring', 'gtm-engineer');
  assert.equal(store.recordSignal({ ...s, observedAt: '2026-10-01T00:00:00Z', lastSeen: '2026-10-01T00:00:00Z' }), true);
  assert.equal(store.recordSignal(sig('sig_2', 'hiring', 'sales-team')), true);
  assert.equal(store.recordSignal(sig('sig_2', 'hiring', 'sales-team')), false);
  // sig_1 was last seen on an earlier collection: closed role, no longer current.
  assert.deepEqual(store.signals('acme', { currentOnly: true }).map((x) => x.id), ['sig_2']);
  assert.equal(store.signals('acme').length, 2);
  store.close();
});

test('news: the account must be the subject, not a word in someone else\'s headline', async () => {
  const { aboutAccount } = await import('./collect/news.ts');
  const cases: [string, string, boolean][] = [
    ['Render Networks Announces $14.3 Million Funding', 'Render', false],
    ['Trump administration to ramp up funding', 'Ramp', false],
    ['Lattice Semiconductor launches post-quantum security', 'Lattice', false],
    ['AI automation startup n8n receives strategic investment from SAP', 'n8n', true],
    ['Salesforce acquires Contentful, the Berlin-born headless CMS', 'Contentful', true],
    ['Lattice Acquires Pando to Expand', 'Lattice', true],
  ];
  for (const [h, name, want] of cases) assert.equal(aboutAccount(h, name), want, h);
  const items = [{ title: 'Citigroup maintains Neutral on Acme, raises target to $10', link: 'https://n/1', pubDate: '2026-10-01T00:00:00.000Z', source: null }];
  assert.equal(newsSignals(acme, items, 180, NOW).length, 0, 'analyst notes are not funding');
});

test('ledger: caps each label but keeps real IDs', async () => {
  const { ledger } = await import('./score.ts');
  const many = Array.from({ length: 9 }, (_, i) => sig(`s${i}`, 'hiring', 'sales-team'));
  const text = ledger(many, 3);
  assert.equal(text.split('\n').filter((l) => l.startsWith('[s')).length, 3);
  assert.match(text, /\+6 more hiring\/sales-team/);
});

test('news: "raises alarms" is not funding', () => {
  const items = [{ title: 'Acme raises alarms over outage', link: 'https://n/2', pubDate: '2026-10-01T00:00:00.000Z', source: null }];
  assert.equal(newsSignals(acme, items, 180, NOW).length, 0);
});
