/**
 * Small shared pieces: HTTP with retries, HTML to text, stable IDs, and the
 * Claude call (borrowed from jobpipe and leadpipe, same author).
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const USER_AGENT = 'signalpipe/0.1 (+https://github.com/toryradtke-star/signalpipe)';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`http ${status}`); this.status = status; }
}

/** One request, retried on network errors, 429 and 5xx. Other 4xx are final. */
export async function request(
  url: string,
  init: { accept?: string; timeoutMs?: number; retries?: number; userAgent?: string } = {},
): Promise<Response> {
  const { accept = 'application/json', timeoutMs = 20_000, retries = 2, userAgent = USER_AGENT } = init;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept, 'user-agent': userAgent },
        redirect: 'follow',
      });
      if (res.ok) return res;
      if (attempt >= retries || (res.status < 500 && res.status !== 429)) throw new HttpError(res.status);
    } catch (err) {
      if (err instanceof HttpError || attempt >= retries) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML to plain text: tags dropped, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

export function shortHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 10);
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

export function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A window of text around a match, for evidence that a person can check. */
export function snippet(text: string, index: number, length: number, radius = 80): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

const run = promisify(execFile);

/**
 * Ask Claude through the `claude` CLI in print mode. Every prompt here carries
 * text from strangers' websites and job posts, so the call runs with no tools
 * and no MCP servers: the model can only answer.
 */
export async function ask(prompt: string, opts: { model?: string; timeoutMs?: number } = {}): Promise<string> {
  const args = ['-p', prompt, '--tools', '', '--strict-mcp-config', '--permission-mode', 'default'];
  if (opts.model) args.push('--model', opts.model);
  const pending = run('claude', args, { timeout: opts.timeoutMs ?? 180_000, maxBuffer: 8 * 1024 * 1024 });
  pending.child.stdin?.end();
  return (await pending).stdout;
}

/** The first balanced JSON object in a model's reply. */
export function extractJson(text: string): Record<string, any> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Scraped text, fenced so the model reads it as data, never as instructions. */
export function untrusted(label: string, text: string): string {
  const clean = text.replace(/<\/?untrusted[^>]*>/gi, '');
  return `<untrusted source="${label}">\n${clean}\n</untrusted>`;
}

/** Run `fn` over items with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
