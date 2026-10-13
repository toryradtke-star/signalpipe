/**
 * Tech-stack signals from an account's homepage: the raw HTML, searched for
 * the script hosts and globals in TOOLS. Only what ships to every visitor is
 * read; nothing runs, nothing logs in.
 *
 * A miss proves nothing (tools load late, behind consent banners, or from a
 * tag manager), so absence is never recorded as a signal.
 */
import type { Account, Signal } from '../types.ts';
import { request, shortHash, snippet } from '../util.ts';
import { TOOLS } from './tools.ts';

export function stackSignals(account: Account, html: string, url: string, now: string): Signal[] {
  const out: Signal[] = [];
  for (const [key, tool] of Object.entries(TOOLS)) {
    if (!tool.script) continue;
    const m = tool.script.exec(html);
    if (!m) continue;
    out.push({
      id: `sig_${shortHash(account.id, 'stack-site', key)}`,
      accountId: account.id, kind: 'stack', label: `tool:${key}`,
      claim: `${tool.name} loads on ${new URL(url).hostname}`,
      detail: snippet(html, m.index, m[0].length, 60),
      sourceUrl: url, basis: 'observed', observedAt: now, lastSeen: now, eventAt: null,
    });
  }
  return out;
}

export async function collectStack(account: Account, now: string): Promise<Signal[]> {
  if (!account.domain) return [];
  const url = `https://${account.domain}/`;
  const res = await request(url, { accept: 'text/html,application/xhtml+xml', retries: 1 });
  const html = await res.text();
  return stackSignals(account, html, res.url || url, now);
}
