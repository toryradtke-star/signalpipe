/**
 * How often the scoring agrees with a person's own calls.
 *
 * Labels are the ground truth: the person running signalpipe looks at an
 * account's signals (not its score) and says hot, warm or cold. Each method is
 * then measured against those labels:
 *
 * - accuracy: exact tier matches
 * - within one: off by at most one tier (hot vs warm counts, hot vs cold does not)
 * - hot precision / recall: of the accounts it called hot, how many were; of
 *   the hot ones, how many it found. Precision is what costs a salesperson time.
 * - Cohen's kappa: agreement beyond what chance would give
 * - citation validity (judge only): reasons whose signal IDs all resolved
 */
import type { Label, Score, Tier } from './types.ts';
import { TIERS } from './types.ts';

export type EvalResult = {
  method: string;
  n: number;
  accuracy: number;
  withinOne: number;
  hotPrecision: number | null;
  hotRecall: number | null;
  kappa: number | null;
  confusion: Record<Tier, Record<Tier, number>>; // confusion[label][predicted]
  citationValidity: number | null;
  misses: { accountId: string; label: Tier; predicted: Tier }[];
};

const RANK: Record<Tier, number> = { hot: 2, warm: 1, cold: 0 };

export function evaluate(method: string, labels: Label[], scores: Score[]): EvalResult {
  const byAccount = new Map(scores.map((s) => [s.accountId, s]));
  const pairs = labels.flatMap((l) => {
    const s = byAccount.get(l.accountId);
    return s ? [{ accountId: l.accountId, label: l.tier, predicted: s.tier }] : [];
  });
  const confusion = Object.fromEntries(TIERS.map((a) => [a, Object.fromEntries(TIERS.map((b) => [b, 0]))])) as EvalResult['confusion'];
  for (const p of pairs) confusion[p.label][p.predicted]++;
  const n = pairs.length;
  const exact = pairs.filter((p) => p.label === p.predicted).length;
  const within = pairs.filter((p) => Math.abs(RANK[p.label] - RANK[p.predicted]) <= 1).length;
  const predHot = pairs.filter((p) => p.predicted === 'hot');
  const realHot = pairs.filter((p) => p.label === 'hot');
  const tp = predHot.filter((p) => p.label === 'hot').length;

  let kappa: number | null = null;
  if (n) {
    const po = exact / n;
    const pe = TIERS.reduce((sum, t) => sum + (pairs.filter((p) => p.label === t).length / n) * (pairs.filter((p) => p.predicted === t).length / n), 0);
    kappa = pe === 1 ? null : (po - pe) / (1 - pe);
  }
  const scored = scores.filter((s) => labels.some((l) => l.accountId === s.accountId));
  const ok = scored.reduce((a, s) => a + s.citationsOk, 0);
  const bad = scored.reduce((a, s) => a + s.citationsBad, 0);

  return {
    method, n,
    accuracy: n ? exact / n : 0,
    withinOne: n ? within / n : 0,
    hotPrecision: predHot.length ? tp / predHot.length : null,
    hotRecall: realHot.length ? tp / realHot.length : null,
    kappa,
    confusion,
    citationValidity: method === 'judge' && ok + bad ? ok / (ok + bad) : null,
    misses: pairs.filter((p) => p.label !== p.predicted),
  };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

export function evalMarkdown(results: EvalResult[], names: Map<string, string>, date: string): string {
  const lines = [`# signalpipe evals — ${date}`, '', `Labels: ${results[0]?.n ?? 0} accounts labeled by hand, blind to the scores.`, '',
    '| Method | n | Exact | Within one tier | Hot precision | Hot recall | Kappa | Citation validity |',
    '|---|---|---|---|---|---|---|---|'];
  for (const r of results) {
    lines.push(`| ${r.method} | ${r.n} | ${pct(r.accuracy)} | ${pct(r.withinOne)} | ${pct(r.hotPrecision)} | ${pct(r.hotRecall)} | ${r.kappa === null ? 'n/a' : r.kappa.toFixed(2)} | ${pct(r.citationValidity)} |`);
  }
  for (const r of results) {
    lines.push('', `## ${r.method}: confusion (rows = your label, columns = predicted)`, '', '| | hot | warm | cold |', '|---|---|---|---|');
    for (const t of TIERS) lines.push(`| **${t}** | ${TIERS.map((p) => r.confusion[t][p]).join(' | ')} |`);
    if (r.misses.length) {
      lines.push('', 'Disagreements:', '');
      for (const m of r.misses) lines.push(`- ${names.get(m.accountId) ?? m.accountId}: you said **${m.label}**, ${r.method} said **${m.predicted}**`);
    }
  }
  return lines.join('\n') + '\n';
}
