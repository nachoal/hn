import { describe, expect, it, vi } from 'vitest';
import type { AlgoliaClient, AlgoliaHit, SearchQuery } from '../src/clients/algolia.js';
import { searchAll } from '../src/paginate.js';

const STEP = 10;

/** Fake index: `total` stories with created_at_i = 1000, 1000+step, 1000+2·step …, honoring window filters and paging. */
function fakeClient(total: number, step = STEP) {
  const all: AlgoliaHit[] = Array.from({ length: total }, (_, i) => ({ objectID: String(i + 1), created_at_i: 1000 + i * step, points: i, _tags: ['story'] }));
  const search = vi.fn(async (q: SearchQuery) => {
    let lo = -Infinity;
    let hi = Infinity;
    for (const f of q.numericFilters ?? []) {
      const m = /^created_at_i(>=|<)(\d+)$/.exec(f);
      if (!m) continue;
      if (m[1] === '>=') lo = Number(m[2]);
      else hi = Number(m[2]);
    }
    const inWindow = all.filter((h) => h.created_at_i! >= lo && h.created_at_i! < hi).sort((a, b) => b.created_at_i! - a.created_at_i!);
    const hitsPerPage = q.hitsPerPage ?? 20;
    const page = q.page ?? 0;
    const capped = Math.min(inWindow.length, 1000);
    const hits = page * hitsPerPage >= capped ? [] : inWindow.slice(page * hitsPerPage, Math.min((page + 1) * hitsPerPage, capped));
    return { hits, nbHits: inWindow.length, nbPages: Math.ceil(capped / hitsPerPage), page, hitsPerPage };
  });
  return { client: { search } as unknown as AlgoliaClient, search };
}

describe('searchAll', () => {
  it('pages a small result set without slicing', async () => {
    const { client, search } = fakeClient(250);
    const r = await searchAll(client, { query: 'x', sort: 'date' }, { maxPages: 10, hitsPerPage: 100, paceMs: 0 });
    expect(r.hits).toHaveLength(250);
    expect(r.windows).toBe(1);
    expect(r.pages_fetched).toBe(3);
    expect(r.capped).toBe(false);
    expect(search).toHaveBeenCalledTimes(3);
    expect(r.hits[0]!.created_at_i).toBe(1000 + 249 * STEP);
  });

  it('splits the date window past the 1,000-hit cap and dedupes', async () => {
    const { client } = fakeClient(2500);
    const r = await searchAll(client, { query: 'x', sort: 'date' }, { maxPages: 50, hitsPerPage: 500, after: 1000, before: 1000 + 2500 * STEP, paceMs: 0 });
    expect(r.hits).toHaveLength(2500);
    expect(new Set(r.hits.map((h) => h.objectID)).size).toBe(2500);
    expect(r.windows).toBeGreaterThan(1);
    expect(r.capped).toBe(false);
    expect(r.nb_hits).toBe(2500);
  });

  it('reports capped when the page budget runs out and keeps newest first', async () => {
    const { client } = fakeClient(2500);
    const r = await searchAll(client, { query: 'x', sort: 'date' }, { maxPages: 4, hitsPerPage: 500, after: 1000, before: 1000 + 2500 * STEP, paceMs: 0 });
    expect(r.capped).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.length).toBeLessThan(2500);
    expect(r.hits[0]!.created_at_i).toBe(1000 + 2499 * STEP);
  });

  it('flags capped when a window cannot be split further', async () => {
    const { client } = fakeClient(1500, 0);
    // 1500 hits sharing one timestamp inside a 30-second window: below the split floor, so Algolia's 1,000 is all we get.
    const r = await searchAll(client, { query: 'x', sort: 'date' }, { maxPages: 10, hitsPerPage: 500, after: 1000, before: 1030, paceMs: 0 });
    expect(r.capped).toBe(true);
    expect(r.windows).toBe(1);
    expect(r.hits).toHaveLength(1000);
  });

  it('sorts by points for relevance pulls', async () => {
    const { client } = fakeClient(30);
    const r = await searchAll(client, { query: 'x', sort: 'relevance' }, { maxPages: 5, hitsPerPage: 10, paceMs: 0 });
    expect(r.hits.map((h) => h.points).slice(0, 3)).toEqual([29, 28, 27]);
  });
});
