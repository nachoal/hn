import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlgoliaClient, enc } from '../src/clients/algolia.js';
import { FirebaseClient } from '../src/clients/firebase.js';
import { HnApiError } from '../src/errors.js';
import { Http } from '../src/http.js';
import { algoliaPage, installFetch } from './helpers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AlgoliaClient.buildUrl', () => {
  const client = new AlgoliaClient(new Http());

  it('encodes tag groups, numeric filters, and spaces', () => {
    const url = client.buildUrl({
      query: 'claude code',
      tags: '(story,poll),author_pg',
      numericFilters: ['created_at_i>=1700000000', 'points>=100'],
      sort: 'date',
      hitsPerPage: 50,
      page: 2,
    });
    expect(url.startsWith('https://hn.algolia.com/api/v1/search_by_date?')).toBe(true);
    expect(url).toContain('query=claude%20code');
    expect(url).toContain('tags=%28story%2Cpoll%29%2Cauthor_pg');
    expect(url).toContain('numericFilters=created_at_i%3E%3D1700000000%2Cpoints%3E%3D100');
    expect(url).toContain('hitsPerPage=50');
    expect(url).toContain('page=2');
  });

  it('uses /search for relevance and caps hitsPerPage at 1000', () => {
    const url = client.buildUrl({ query: 'x', hitsPerPage: 5000 });
    expect(url.startsWith('https://hn.algolia.com/api/v1/search?')).toBe(true);
    expect(url).toContain('hitsPerPage=1000');
    expect(url).toContain('page=0');
    expect(url).not.toContain('tags=');
  });

  it('enc percent-encodes the characters encodeURIComponent leaves alone', () => {
    expect(enc("(a,b)*'!")).toBe('%28a%2Cb%29%2A%27%21');
  });
});

describe('AlgoliaClient.hydrate', () => {
  it('batches ids into one request per chunk, guarded to story-like types', async () => {
    const { calls } = installFetch((url) => {
      if (!url.pathname.endsWith('/search')) return undefined;
      const ids = [...url.searchParams.get('tags')!.matchAll(/story_(\d+)/g)].map((m) => Number(m[1]));
      const hits = ids.filter((id) => id !== 3).map((id) => ({ objectID: String(id), title: `t${id}`, _tags: ['story', `story_${id}`] }));
      return { body: algoliaPage(hits, hits.length, ids.length) };
    });
    const client = new AlgoliaClient(new Http());
    const map = await client.hydrate([1, 2, 3, 4], 3);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!).searchParams.get('tags')).toBe('(story,job,poll),(story_1,story_2,story_3)');
    expect(new URL(calls[1]!).searchParams.get('tags')).toBe('(story,job,poll),(story_4)');
    expect([...map.keys()]).toEqual([1, 2, 4]);
  });

  it('returns null for a missing item and null for an unknown user', async () => {
    installFetch((url) => (url.pathname.endsWith('/users/nobody') ? { status: 500, text: '<html>Internal Server Error</html>' } : undefined));
    const client = new AlgoliaClient(new Http({ retries: 0 }));
    expect(await client.item(999)).toBeNull();
    expect(await client.user('nobody')).toBeNull();
  });
});

describe('Http', () => {
  it('throws HnApiError with the endpoint label on 4xx and counts requests', async () => {
    installFetch(() => ({ status: 400, text: '{"message":"bad tags"}' }));
    const http = new Http({ retries: 0 });
    await expect(http.getJson('https://hn.algolia.com/api/v1/search?x', 'algolia:search')).rejects.toMatchObject({
      name: 'HnApiError',
      statusCode: 400,
      endpoint: 'algolia:search',
      details: 'bad tags',
    });
    expect(http.log.requests).toBe(1);
    expect(http.log.endpoints).toEqual(['algolia:search']);
  });

  it('retries 5xx and then succeeds', async () => {
    let n = 0;
    installFetch(() => (++n === 1 ? { status: 503, text: 'busy' } : { body: { ok: true } }));
    const http = new Http({ retries: 1 });
    expect(await http.getJson('https://hacker-news.firebaseio.com/v0/maxitem.json', 'firebase:maxitem')).toEqual({ ok: true });
    expect(http.log.requests).toBe(2);
  });

  it('surfaces network failures as HnApiError status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    const http = new Http({ retries: 0 });
    const err = await http.getJson('https://x', 'firebase:item').catch((e) => e);
    expect(err).toBeInstanceOf(HnApiError);
    expect(err.statusCode).toBe(0);
    expect(err.toJSON().hint).toMatch(/Network error/);
  });
});

describe('FirebaseClient', () => {
  it('fetches items concurrently, preserving order, with null for missing', async () => {
    const { calls } = installFetch((url) => {
      const m = /\/item\/(\d+)\.json$/.exec(url.pathname);
      if (!m) return undefined;
      const id = Number(m[1]);
      return id === 2 ? { text: 'null' } : { body: { id, type: 'story', title: `s${id}` } };
    });
    const fb = new FirebaseClient(new Http());
    const items = await fb.items([1, 2, 3], 2);
    expect(items.map((i) => i?.id ?? null)).toEqual([1, null, 3]);
    expect(calls).toHaveLength(3);
  });

  it('maps feed kinds to endpoints', async () => {
    const { calls } = installFetch(() => ({ body: [5, 6] }));
    const fb = new FirebaseClient(new Http());
    expect(await fb.list('jobs')).toEqual([5, 6]);
    expect(calls[0]).toBe('https://hacker-news.firebaseio.com/v0/jobstories.json');
  });
});
