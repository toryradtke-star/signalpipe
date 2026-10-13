/**
 * The shapes everything else passes around.
 *
 * The one rule that runs through all of them: a claim about an account is only
 * as good as the signal it cites. Signals carry their source URL, when they
 * were observed, and whether the claim was read straight off the source
 * (`observed`) or reasoned from it (`inferred`). Scores and drafts point back
 * at signal IDs, never at free text.
 */

export type Ats = 'greenhouse' | 'lever' | 'ashby';

export type Account = {
  id: string;            // stable slug, e.g. "airtable"
  name: string;
  domain: string | null; // "airtable.com"; null until known
  domainBasis: Basis | null;
  ats: Ats | null;
  atsSlug: string | null;
  tags: string[];
};

export type Basis = 'observed' | 'inferred';

export type SignalKind = 'hiring' | 'stack' | 'news';

export type Signal = {
  id: string;            // "sig_" + short hash of account|kind|label|source
  accountId: string;
  kind: SignalKind;
  label: string;         // rule key the profile weights, e.g. "gtm-ops", "tool:clay", "funding"
  claim: string;         // one human sentence
  detail: string;        // the matched snippet or title, kept short
  sourceUrl: string;
  basis: Basis;
  observedAt: string;    // ISO; first time we saw it
  lastSeen: string;      // ISO; moves forward while the signal is still there
  eventAt: string | null; // when the thing itself happened, if the source says
};

export type Tier = 'hot' | 'warm' | 'cold';

export const TIERS: Tier[] = ['hot', 'warm', 'cold'];

/** One reason in a score, tied to the signals that justify it. */
export type Reason = { claim: string; signals: string[]; points?: number; basis: Basis };

export type Score = {
  accountId: string;
  method: 'rules' | 'judge';
  score: number;          // 0-100
  tier: Tier;
  reasons: Reason[];
  unknowns: string[];
  angle: string | null;   // the opening the judge would lead with
  citationsOk: number;    // reasons whose citations all resolved
  citationsBad: number;   // reasons dropped for citing nothing or unknown IDs
  model: string | null;
  scoredAt: string;
};

export type Draft = {
  accountId: string;
  subject: string;
  body: string;
  signals: string[];
  model: string;
  draftedAt: string;
};

export type Label = { accountId: string; tier: Tier; note: string | null; labeledAt: string };

/** What the person running signalpipe sells, to whom, and what counts as a signal. */
export type Profile = {
  seller: { name: string; offer: string; proof: string[]; voice?: string };
  icp: { description: string; disqualifiers?: string[] };
  signals: {
    hiring: { roles: { label: string; pattern: string; weight: number; max?: number; claim: string }[]; mentionTools?: boolean };
    stack: { tools: Record<string, number> };
    news: { lookbackDays: number; weights: Partial<Record<NewsLabel, number>> };
  };
  tiers: { hot: number; warm: number };
  draft?: { goal: string; maxWords?: number };
};

export type NewsLabel = 'funding' | 'layoffs' | 'acquisition' | 'launch' | 'leadership';
