/**
 * News signals from Google News' public RSS search: funding, layoffs,
 * acquisitions, launches and leadership changes in the lookback window.
 *
 * Headlines are classified by pattern, and a headline only counts when it names
 * the account, which keeps "Notion raises..." from matching a story that
 * merely mentions Notion. The claim quotes the headline so a person can judge
 * it; the label is the pattern's reading of it.
 */
import type { Account, NewsLabel, Signal } from '../types.ts';
import { decodeEntities, isoOrNull, request, shortHash } from '../util.ts';

export type NewsItem = { title: string; link: string; pubDate: string | null; source: string | null };

const RULES: { label: NewsLabel; re: RegExp; claim: string }[] = [
  { label: 'layoffs', re: /\b(lay(s|ing)? off|layoffs?|job cuts|cuts? \d+%? (of )?(staff|jobs|workforce)|restructur)/i, claim: 'Layoffs or restructuring reported' },
  { label: 'funding', re: /\b((raises?|raised)\b(?! (alarms?|concerns?|questions?|eyebrows|prices?|rates?|the bar|awareness|doubts|hopes|fears|headcount|salaries))|funding|series [a-h]\b|seed round|valuation|\$\d+(\.\d+)?\s?(m|b|million|billion)\b.*\b(round|led by))/i, claim: 'Funding reported' },
  { label: 'acquisition', re: /\b(acquires?|acquired|acquisition|to buy|merg(es|er))\b/i, claim: 'Acquisition reported' },
  { label: 'leadership', re: /\b(appoints?|names?|hires?|taps)\b.*\b(chief|cro|cmo|ceo|vp|head of|president)\b|\bnew (cro|cmo|ceo)\b/i, claim: 'Leadership change reported' },
  { label: 'launch', re: /\b(launch(es|ed)?|unveils?|introduces?|announces? (new|general availability))\b/i, claim: 'Product launch reported' },
];

export function newsUrl(name: string): string {
  const q = `"${name}" (raises OR funding OR "Series" OR layoffs OR acquires OR acquired OR launches OR appoints)`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

export function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t: string) => {
      const r = new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`).exec(m[1]);
      return r ? decodeEntities(r[1]).trim() : null;
    };
    const title = tag('title');
    const link = tag('link');
    if (title && link) items.push({ title, link, pubDate: isoOrNull(tag('pubDate')), source: tag('source') });
  }
  return items;
}

const SUBJECT_VERBS = 'raises|raised|lands|secures|closes|announces|acquires|acquired|buys|lays off|laid off|cuts|is cutting|launches|unveils|introduces|appoints|names|hires|taps|receives|gets|doubles|triples|valued|to acquire|to buy|merges';
// Market chatter about a stock is not news about the company's plans.
const MARKET_NOISE = /\b(price target|target to|shares|stock|forecast|guidance|analyst|maintains|upgrade[sd]?|downgrade[sd]?|rating|earnings|nasdaq|nyse)\b/i;

/**
 * True when the account is the subject of the headline ("Acme raises...",
 * "AI startup Acme secures...") or the target of a deal ("BigCo acquires
 * Acme"). The verb has to follow the name directly, so "Render Networks
 * announces" and "Lattice Semiconductor launches" are other companies, and
 * the name is matched case-sensitively, so "ramp up" is not Ramp.
 */
export function aboutAccount(headline: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const verbAfter = new RegExp(`^('s)?\\s+(${SUBJECT_VERBS})\\b`, 'i');
  const dealBefore = new RegExp(`\\b(acquires?|acquired|acquisition of|buys|to buy|to acquire)\\s+$`, 'i');
  for (const m of headline.matchAll(new RegExp(`(^|[^\\w-])(${esc})(?=[^\\w-]|$)`, 'g'))) {
    const start = m.index + m[1].length;
    const end = start + m[2].length;
    if (verbAfter.test(headline.slice(end)) || dealBefore.test(headline.slice(0, start))) return true;
  }
  return false;
}

export function newsSignals(account: Account, items: NewsItem[], lookbackDays: number, now: string): Signal[] {
  const cutoff = new Date(Date.parse(now) - lookbackDays * 86_400_000).toISOString();
  const out: Signal[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.pubDate || item.pubDate < cutoff) continue;
    // Google appends " - Source" to titles; judge the headline itself.
    const headline = item.source && item.title.endsWith(` - ${item.source}`) ? item.title.slice(0, -(item.source.length + 3)) : item.title;
    if (!aboutAccount(headline, account.name) || MARKET_NOISE.test(headline)) continue;
    const rule = RULES.find((r) => r.re.test(headline));
    if (!rule) continue;
    const key = `${rule.label}|${headline.toLowerCase().replace(/\W+/g, ' ').slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `sig_${shortHash(account.id, 'news', item.link)}`,
      accountId: account.id, kind: 'news', label: rule.label,
      claim: `${rule.claim}: "${headline}"${item.source ? ` (${item.source})` : ''}`,
      detail: headline, sourceUrl: item.link, basis: 'observed',
      observedAt: now, lastSeen: now, eventAt: item.pubDate,
    });
  }
  return out;
}

export async function collectNews(account: Account, lookbackDays: number, now: string): Promise<Signal[]> {
  const res = await request(newsUrl(account.name), { accept: 'application/rss+xml,text/xml' });
  return newsSignals(account, parseRss(await res.text()), lookbackDays, now);
}
