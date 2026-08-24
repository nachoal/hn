import { ALGOLIA_MAX_HITS, type AlgoliaClient, type AlgoliaHit, type SearchQuery } from './clients/algolia.js';
import { sleep } from './http.js';
import { nowSeconds } from './normalize.js';

export interface SearchAllOptions {
  maxPages: number;
  hitsPerPage: number;
  /** Epoch-second window already implied by the caller's filters (used to seed window slicing). */
  after?: number;
  before?: number;
  paceMs: number;
}

export interface SearchAllResult {
  hits: AlgoliaHit[];
  nb_hits: number;
  pages_fetched: number;
  windows: number;
  capped: boolean;
}

const MIN_WINDOW_SECONDS = 60;
const DEFAULT_SPAN_SECONDS = 20 * 365 * 86400;

/**
 * Pull more than one page. Algolia hard-caps every query at 1,000 hits, so when a query is
 * bigger than that the time range is split in half recursively (by `created_at_i`) until each
 * window fits, and every window is paged. `maxPages` bounds total requests; `capped` reports
 * whether that budget cut the pull short.
 */
export async function searchAll(client: AlgoliaClient, base: SearchQuery, opts: SearchAllOptions): Promise<SearchAllResult> {
  const seen = new Map<number, AlgoliaHit>();
  let pagesFetched = 0;
  let windows = 0;
  let capped = false;
  let nbHitsTotal = 0;

  const baseFilters = (base.numericFilters ?? []).filter((f) => !f.startsWith('created_at_i'));

  const fetchWindow = async (lo: number | undefined, hi: number | undefined, depth: number): Promise<void> => {
    if (pagesFetched >= opts.maxPages) {
      capped = true;
      return;
    }
    const filters = [...baseFilters];
    if (lo !== undefined) filters.push(`created_at_i>=${lo}`);
    if (hi !== undefined) filters.push(`created_at_i<${hi}`);
    const first = await client.search({ ...base, numericFilters: filters, hitsPerPage: opts.hitsPerPage, page: 0 });
    pagesFetched++;
    windows++;

    if (first.nbHits > ALGOLIA_MAX_HITS) {
      const start = lo ?? nowSeconds() - DEFAULT_SPAN_SECONDS;
      const end = hi ?? nowSeconds() + 60;
      if (depth < 30 && end - start > MIN_WINDOW_SECONDS) {
        const mid = Math.floor((start + end) / 2);
        // Newest half first so a capped pull still returns the most recent items.
        await fetchWindow(mid, end, depth + 1);
        await fetchWindow(start, mid, depth + 1);
        return;
      }
      // A window this narrow still exceeds 1,000 hits: page what Algolia allows and say so.
      capped = true;
    }

    nbHitsTotal += first.nbHits;
    for (const hit of first.hits) seen.set(Number(hit.objectID), hit);
    const totalPages = Math.min(first.nbPages, Math.ceil(ALGOLIA_MAX_HITS / opts.hitsPerPage));
    for (let page = 1; page < totalPages; page++) {
      if (pagesFetched >= opts.maxPages) {
        capped = true;
        return;
      }
      if (opts.paceMs > 0) await sleep(opts.paceMs);
      const res = await client.search({ ...base, numericFilters: filters, hitsPerPage: opts.hitsPerPage, page });
      pagesFetched++;
      for (const hit of res.hits) seen.set(Number(hit.objectID), hit);
      if (res.hits.length === 0) break;
    }
  };

  await fetchWindow(opts.after, opts.before, 0);

  const hits = [...seen.values()];
  if (base.sort === 'date') hits.sort((a, b) => (b.created_at_i ?? 0) - (a.created_at_i ?? 0));
  else hits.sort((a, b) => (b.points ?? 0) - (a.points ?? 0));

  return { hits, nb_hits: nbHitsTotal, pages_fetched: pagesFetched, windows, capped };
}
