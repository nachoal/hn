import { vi } from 'vitest';
import { buildCli } from '../src/cli.js';

export interface MockReply {
  status?: number;
  body?: unknown;
  text?: string;
}

export type Handler = (url: URL) => MockReply | undefined;

/** Replace global fetch with a URL-routed stub; returns the list of requested URLs. */
export function installFetch(handler: Handler) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    calls.push(url.href);
    const reply = handler(url) ?? { status: 404, text: '{"error":"Not Found","status":404}' };
    const text = reply.text ?? JSON.stringify(reply.body === undefined ? null : reply.body);
    return new Response(text, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export function algoliaPage(hits: unknown[], nbHits = hits.length, hitsPerPage = 20, page = 0) {
  return { hits, nbHits, nbPages: Math.max(1, Math.ceil(Math.min(nbHits, 1000) / hitsPerPage)), page, hitsPerPage };
}

/** Run the CLI in-process and return the parsed JSON it wrote to stdout. */
export async function runCli(args: string[]): Promise<{ stdout: string; json: any }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await buildCli(['node', 'hn', ...args]).exitProcess(false).parseAsync();
  } finally {
    spy.mockRestore();
  }
  const stdout = chunks.join('');
  const last = stdout.trim().split('\n').pop() ?? 'null';
  let json: any = null;
  try {
    json = JSON.parse(last);
  } catch {
    json = null; // commands like `skill path` print a bare string
  }
  return { stdout, json };
}
