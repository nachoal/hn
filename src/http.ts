import { HnApiError } from './errors.js';

export interface RequestLog {
  requests: number;
  endpoints: string[];
}

export interface HttpOptions {
  timeoutMs?: number;
  userAgent?: string;
  retries?: number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Thin fetch wrapper shared by both API clients. Counts every request so commands can
 * report `_meta.requests` (Algolia exposes no rate-limit headers, so the local count is
 * the only pacing signal an agent has). Retries transient failures with a short backoff.
 */
export class Http {
  readonly log: RequestLog = { requests: 0, endpoints: [] };
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly retries: number;

  constructor(opts: HttpOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.userAgent = opts.userAgent ?? 'hn-cli (+https://github.com/nachoal/hn)';
    this.retries = opts.retries ?? 2;
  }

  /**
   * GET a JSON document. Returns null on 404 when `allowNotFound` is set (Algolia items),
   * otherwise throws HnApiError. Firebase returns literal `null` bodies for missing items —
   * those come back as null too.
   */
  async getJson<T>(url: string, label: string, opts: { allowNotFound?: boolean } = {}): Promise<T | null> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      this.log.requests++;
      if (!this.log.endpoints.includes(label)) this.log.endpoints.push(label);
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': this.userAgent, accept: 'application/json' },
          signal: controller.signal,
        });
        if (res.status === 404 && opts.allowNotFound) return null;
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          if ((res.status >= 500 || res.status === 429) && attempt <= this.retries) {
            await sleep(res.status === 429 ? 1500 * attempt : 400 * attempt);
            continue;
          }
          throw new HnApiError(res.status, label, summarize(body) || res.statusText || 'request failed', url);
        }
        const text = await res.text();
        if (text === '' || text === 'null') return null;
        return JSON.parse(text) as T;
      } catch (err) {
        if (err instanceof HnApiError) throw err;
        if (attempt <= this.retries) {
          await sleep(400 * attempt);
          continue;
        }
        const message = (err as Error)?.name === 'AbortError' ? `timeout after ${this.timeoutMs}ms` : (err as Error).message;
        throw new HnApiError(0, label, `Network error: ${message}`, url);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

function summarize(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { error?: string; message?: string };
    return parsed.error || parsed.message || trimmed.slice(0, 200);
  } catch {
    return trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pMap<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
