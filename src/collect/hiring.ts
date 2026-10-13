/**
 * Hiring signals from an account's public job board (Greenhouse, Lever, Ashby -
 * the same unauthenticated feeds jobpipe polls).
 *
 * Two kinds of evidence come out of one fetch:
 * - each open role whose title matches a profile pattern ("hiring a RevOps
 *   manager"), and
 * - tools named in any open role's description ("their AE posting asks for
 *   Salesforce and Gong"), one signal per tool, citing the first posting.
 */
import type { Account, Ats, Profile, Signal } from '../types.ts';
import { htmlToText, isoOrNull, request, shortHash, snippet } from '../util.ts';
import { TOOLS } from './tools.ts';

export type Job = { id: string; title: string; description: string; url: string; location: string | null; postedAt: string | null };

export function boardUrl(ats: Ats, slug: string): string {
  const s = encodeURIComponent(slug);
  if (ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`;
  if (ats === 'lever') return `https://api.lever.co/v0/postings/${s}?mode=json`;
  return `https://api.ashbyhq.com/posting-api/job-board/${s}`;
}

export function parseBoard(ats: Ats, body: any): Job[] {
  if (ats === 'greenhouse') {
    return (Array.isArray(body?.jobs) ? body.jobs : []).map((j: any) => ({
      id: String(j.id ?? ''), title: String(j.title ?? '').trim(),
      description: htmlToText(htmlToText(String(j.content ?? ''))), // escaped HTML: decode, then strip
      url: String(j.absolute_url ?? ''), location: j.location?.name ?? null,
      postedAt: isoOrNull(j.first_published) ?? isoOrNull(j.updated_at),
    }));
  }
  if (ats === 'lever') {
    return (Array.isArray(body) ? body : []).map((j: any) => ({
      id: String(j.id ?? ''), title: String(j.text ?? '').trim(),
      description: [j.descriptionPlain ?? htmlToText(String(j.description ?? '')),
        ...(Array.isArray(j.lists) ? j.lists.map((l: any) => `${l?.text ?? ''}\n${htmlToText(String(l?.content ?? ''))}`) : []),
        j.additionalPlain ?? ''].join('\n\n'),
      url: String(j.hostedUrl ?? ''), location: j.categories?.location ?? null, postedAt: isoOrNull(j.createdAt),
    }));
  }
  return (Array.isArray(body?.jobs) ? body.jobs : [])
    .filter((j: any) => j?.isListed !== false)
    .map((j: any) => ({
      id: String(j.id ?? ''), title: String(j.title ?? '').trim(),
      description: j.descriptionPlain ? String(j.descriptionPlain) : htmlToText(String(j.descriptionHtml ?? '')),
      url: String(j.jobUrl ?? ''), location: j.location ?? null, postedAt: isoOrNull(j.publishedAt),
    }));
}

/** Turn a board's open roles into signals. Pure, so it can be tested on fixtures. */
export function hiringSignals(account: Account, jobs: Job[], profile: Profile, now: string): Signal[] {
  const out: Signal[] = [];
  const roles = profile.signals.hiring.roles.map((r) => ({ ...r, re: new RegExp(r.pattern, 'i') }));
  for (const job of jobs) {
    if (!job.id || !job.title) continue;
    const role = roles.find((r) => r.re.test(job.title));
    if (!role) continue;
    out.push({
      id: `sig_${shortHash(account.id, 'hiring', job.url || job.id)}`,
      accountId: account.id, kind: 'hiring', label: role.label,
      claim: `${role.claim}: "${job.title}"${job.location ? ` (${job.location})` : ''}`,
      detail: job.title, sourceUrl: job.url, basis: 'observed',
      observedAt: now, lastSeen: now, eventAt: job.postedAt,
    });
  }
  if (profile.signals.hiring.mentionTools !== false) {
    const seen = new Set<string>();
    for (const job of jobs) {
      for (const [key, tool] of Object.entries(TOOLS)) {
        if (!tool.text || seen.has(key)) continue;
        const m = tool.text.exec(job.description);
        if (!m) continue;
        seen.add(key);
        out.push({
          id: `sig_${shortHash(account.id, 'stack-jobs', key)}`,
          accountId: account.id, kind: 'stack', label: `tool:${key}`,
          claim: `Job post "${job.title}" names ${tool.name}`,
          detail: snippet(job.description, m.index, m[0].length),
          sourceUrl: job.url, basis: 'inferred', // named in a job post: used or wanted, not proven installed
          observedAt: now, lastSeen: now, eventAt: job.postedAt,
        });
      }
    }
  }
  return out;
}

export async function collectHiring(account: Account, profile: Profile, now: string): Promise<{ signals: Signal[]; openRoles: number }> {
  if (!account.ats || !account.atsSlug) return { signals: [], openRoles: 0 };
  const res = await request(boardUrl(account.ats, account.atsSlug));
  const jobs = parseBoard(account.ats, await res.json());
  return { signals: hiringSignals(account, jobs, profile, now), openRoles: jobs.length };
}
