/**
 * Getting accounts in, and finding their websites.
 *
 * The import format is a JSON array of {name, domain?, ats?, slug?, tags?},
 * which is also exactly jobpipe's companies.json, so a job search's employer
 * registry imports as-is.
 *
 * A domain that isn't given is guessed (slug.com, name.com, the name itself
 * when it already looks like a domain) and kept only when the homepage's
 * <title> or site name contains the account's name. Guessed domains are
 * marked `inferred` so nothing downstream treats them as given.
 */
import type { Account, Ats } from './types.ts';
import { request, slugify } from './util.ts';

export function parseImport(raw: unknown): Account[] {
  if (!Array.isArray(raw)) throw new Error('expected a JSON array of accounts');
  return raw.map((r: any) => {
    const name = String(r?.name ?? '').trim();
    if (!name) throw new Error(`account without a name: ${JSON.stringify(r)}`);
    const ats = ['greenhouse', 'lever', 'ashby'].includes(r?.ats) ? (r.ats as Ats) : null;
    const domain = r?.domain ? String(r.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase() : null;
    return {
      id: slugify(r?.id ?? name), name, domain, domainBasis: domain ? 'observed' : null,
      ats, atsSlug: ats && r?.slug ? String(r.slug) : null,
      tags: Array.isArray(r?.tags) ? r.tags.map(String) : [],
    };
  });
}

export function domainCandidates(a: Account): string[] {
  const out = new Set<string>();
  const bare = a.name.toLowerCase().replace(/[^a-z0-9.]/g, '');
  if (/^[a-z0-9-]+\.[a-z]{2,}$/.test(bare)) out.add(bare);           // "Apollo.io"
  out.add(`${a.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`);   // "Fleetio" -> fleetio.com
  if (a.atsSlug) out.add(`${a.atsSlug.toLowerCase().replace(/[^a-z0-9-]/g, '')}.com`);
  out.add(`${slugify(a.name)}.com`);
  return [...out];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function pageNamesAccount(html: string, name: string): boolean {
  const head = html.slice(0, 60_000);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '';
  const site = /property=["']og:site_name["'][^>]*content=["']([^"']+)/i.exec(head)?.[1] ?? '';
  const want = norm(name.replace(/\.(io|com|ai|co)$/i, ''));
  return want.length > 1 && (norm(title).includes(want) || norm(site).includes(want));
}

export async function resolveDomain(a: Account): Promise<string | null> {
  for (const domain of domainCandidates(a)) {
    try {
      const res = await request(`https://${domain}/`, { accept: 'text/html', retries: 0, timeoutMs: 12_000 });
      const html = await res.text();
      if (pageNamesAccount(html, a.name)) return new URL(res.url || `https://${domain}/`).hostname.replace(/^www\./, '');
    } catch { /* try the next guess */ }
  }
  return null;
}
