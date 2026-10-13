/**
 * The store: one SQLite file through Node's own driver, so there is nothing to
 * install or compile.
 *
 * Signals are never deleted. A signal that stops showing up (a role closed, a
 * script removed) just stops having `last_seen` moved forward, so "was true on
 * these dates" stays answerable. Scores keep one row per account and method;
 * labels are Tory's own calls and are the ground truth evals compare against.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Account, Draft, Label, Score, Signal, Tier } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  domain_basis TEXT,
  ats TEXT,
  ats_slug TEXT,
  tags TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  claim TEXT NOT NULL,
  detail TEXT NOT NULL,
  source_url TEXT NOT NULL,
  basis TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  event_at TEXT
);
CREATE INDEX IF NOT EXISTS signals_account ON signals(account_id);

CREATE TABLE IF NOT EXISTS scores (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  method TEXT NOT NULL,
  score INTEGER NOT NULL,
  tier TEXT NOT NULL,
  reasons TEXT NOT NULL,
  unknowns TEXT NOT NULL,
  angle TEXT,
  citations_ok INTEGER NOT NULL,
  citations_bad INTEGER NOT NULL,
  model TEXT,
  scored_at TEXT NOT NULL,
  PRIMARY KEY (account_id, method)
);

CREATE TABLE IF NOT EXISTS drafts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  signals TEXT NOT NULL,
  model TEXT NOT NULL,
  drafted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  tier TEXT NOT NULL,
  note TEXT,
  labeled_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]'
);
`;

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const toAccount = (r: any): Account => ({
    id: r.id, name: r.name, domain: r.domain, domainBasis: r.domain_basis,
    ats: r.ats, atsSlug: r.ats_slug, tags: JSON.parse(r.tags),
  });
  const toSignal = (r: any): Signal => ({
    id: r.id, accountId: r.account_id, kind: r.kind, label: r.label, claim: r.claim, detail: r.detail,
    sourceUrl: r.source_url, basis: r.basis, observedAt: r.observed_at, lastSeen: r.last_seen, eventAt: r.event_at,
  });
  const toScore = (r: any): Score => ({
    accountId: r.account_id, method: r.method, score: r.score, tier: r.tier,
    reasons: JSON.parse(r.reasons), unknowns: JSON.parse(r.unknowns), angle: r.angle,
    citationsOk: r.citations_ok, citationsBad: r.citations_bad, model: r.model, scoredAt: r.scored_at,
  });

  return {
    db,
    close: () => db.close(),

    upsertAccount(a: Account) {
      db.prepare(`INSERT INTO accounts (id, name, domain, domain_basis, ats, ats_slug, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name,
          domain = COALESCE(excluded.domain, accounts.domain),
          domain_basis = CASE WHEN excluded.domain IS NULL THEN accounts.domain_basis ELSE excluded.domain_basis END,
          ats = COALESCE(excluded.ats, accounts.ats), ats_slug = COALESCE(excluded.ats_slug, accounts.ats_slug),
          tags = excluded.tags`)
        .run(a.id, a.name, a.domain, a.domainBasis, a.ats, a.atsSlug, JSON.stringify(a.tags));
    },
    setDomain(id: string, domain: string, basis: string) {
      db.prepare('UPDATE accounts SET domain = ?, domain_basis = ? WHERE id = ?').run(domain, basis, id);
    },
    accounts(): Account[] {
      return db.prepare('SELECT * FROM accounts ORDER BY name').all().map(toAccount);
    },
    account(idOrName: string): Account | null {
      const r = db.prepare('SELECT * FROM accounts WHERE id = ? OR lower(name) = lower(?)').get(idOrName, idOrName);
      return r ? toAccount(r) : null;
    },

    /** Insert a new signal or move an existing one's last_seen forward. Returns true when new. */
    recordSignal(s: Signal): boolean {
      const existing = db.prepare('SELECT id FROM signals WHERE id = ?').get(s.id);
      if (existing) {
        db.prepare('UPDATE signals SET last_seen = ?, claim = ?, detail = ? WHERE id = ?').run(s.lastSeen, s.claim, s.detail, s.id);
        return false;
      }
      db.prepare(`INSERT INTO signals (id, account_id, kind, label, claim, detail, source_url, basis, observed_at, last_seen, event_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.id, s.accountId, s.kind, s.label, s.claim, s.detail, s.sourceUrl, s.basis, s.observedAt, s.lastSeen, s.eventAt);
      return true;
    },
    /** Signals still current: seen on or after `since` (the latest collection of that kind). */
    signals(accountId: string, opts: { currentOnly?: boolean } = {}): Signal[] {
      const rows = db.prepare('SELECT * FROM signals WHERE account_id = ? ORDER BY kind, observed_at DESC').all(accountId).map(toSignal);
      if (!opts.currentOnly) return rows;
      // A signal is current when it was seen in the most recent collection of its kind for this account.
      const latest = new Map<string, string>();
      for (const s of rows) if (!latest.has(s.kind) || s.lastSeen > latest.get(s.kind)!) latest.set(s.kind, s.lastSeen);
      return rows.filter((s) => s.kind === 'news' || s.lastSeen.slice(0, 10) >= latest.get(s.kind)!.slice(0, 10));
    },

    saveScore(s: Score) {
      db.prepare(`INSERT OR REPLACE INTO scores (account_id, method, score, tier, reasons, unknowns, angle, citations_ok, citations_bad, model, scored_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.accountId, s.method, s.score, s.tier, JSON.stringify(s.reasons), JSON.stringify(s.unknowns), s.angle,
          s.citationsOk, s.citationsBad, s.model, s.scoredAt);
    },
    score(accountId: string, method: 'rules' | 'judge'): Score | null {
      const r = db.prepare('SELECT * FROM scores WHERE account_id = ? AND method = ?').get(accountId, method);
      return r ? toScore(r) : null;
    },
    scores(method: 'rules' | 'judge'): Score[] {
      return db.prepare('SELECT * FROM scores WHERE method = ? ORDER BY score DESC').all(method).map(toScore);
    },

    saveDraft(d: Draft) {
      db.prepare('INSERT OR REPLACE INTO drafts (account_id, subject, body, signals, model, drafted_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(d.accountId, d.subject, d.body, JSON.stringify(d.signals), d.model, d.draftedAt);
    },
    draft(accountId: string): Draft | null {
      const r: any = db.prepare('SELECT * FROM drafts WHERE account_id = ?').get(accountId);
      return r ? { accountId: r.account_id, subject: r.subject, body: r.body, signals: JSON.parse(r.signals), model: r.model, draftedAt: r.drafted_at } : null;
    },

    saveLabel(l: Label) {
      db.prepare('INSERT OR REPLACE INTO labels (account_id, tier, note, labeled_at) VALUES (?, ?, ?, ?)')
        .run(l.accountId, l.tier, l.note, l.labeledAt);
    },
    labels(): Label[] {
      return db.prepare('SELECT * FROM labels').all().map((r: any) => ({ accountId: r.account_id, tier: r.tier as Tier, note: r.note, labeledAt: r.labeled_at }));
    },

    startRun(kind: string): number {
      return Number(db.prepare('INSERT INTO runs (kind, started_at) VALUES (?, ?)').run(kind, new Date().toISOString()).lastInsertRowid);
    },
    finishRun(id: number, ok: number, failed: number, errors: string[]) {
      db.prepare('UPDATE runs SET finished_at = ?, ok = ?, failed = ?, errors = ? WHERE id = ?')
        .run(new Date().toISOString(), ok, failed, JSON.stringify(errors.slice(0, 200)), id);
    },
  };
}
