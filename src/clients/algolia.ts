import type { Http } from '../http.js';
import type { SearchSort } from '../types.js';

export interface AlgoliaHit {
  objectID: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string;
  created_at_i?: number;
  story_text?: string | null;
  comment_text?: string | null;
  story_id?: number | null;
  parent_id?: number | null;
  story_title?: string | null;
  story_url?: string | null;
  _tags?: string[];
}

export interface AlgoliaResponse {
  hits: AlgoliaHit[];
  nbHits: number;
  nbPages: number;
  page: number;
  hitsPerPage: number;
  exhaustiveNbHits?: boolean;
  processingTimeMS?: number;
}

export interface AlgoliaNode {
  id: number;
  created_at?: string;
  created_at_i?: number;
  type: string;
  author: string | null;
  title: string | null;
  url: string | null;
  text: string | null;
  points: number | null;
  parent_id: number | null;
  story_id: number | null;
  children: AlgoliaNode[];
  options?: unknown[];
}

export interface AlgoliaUser {
  username: string;
  karma: number;
  about?: string | null;
}

export interface SearchQuery {
  query?: string;
  /** Algolia tag expression: comma = AND, parentheses = OR. e.g. `story,(author_pg,author_dang)` */
  tags?: string;
  /** e.g. ['created_at_i>1700000000', 'points>=100'] — joined with commas (AND). */
  numericFilters?: string[];
  page?: number;
  hitsPerPage?: number;
  restrictSearchableAttributes?: string;
  sort?: SearchSort;
}

/** Percent-encode everything, including the parentheses and `>` that Algolia's tag/filter syntax needs. */
export function enc(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export const ALGOLIA_MAX_HITS = 1000;

/** HN Search API (Algolia). Keyless; documented budget 10,000 req/h; hard cap 1,000 hits per query. */
export class AlgoliaClient {
  constructor(
    private readonly http: Http,
    private readonly base = 'https://hn.algolia.com/api/v1',
  ) {}

  buildUrl(q: SearchQuery): string {
    const endpoint = q.sort === 'date' ? 'search_by_date' : 'search';
    const params: string[] = [];
    if (q.query) params.push(`query=${enc(q.query)}`);
    if (q.tags) params.push(`tags=${enc(q.tags)}`);
    if (q.numericFilters && q.numericFilters.length > 0) params.push(`numericFilters=${enc(q.numericFilters.join(','))}`);
    if (q.restrictSearchableAttributes) params.push(`restrictSearchableAttributes=${enc(q.restrictSearchableAttributes)}`);
    const hitsPerPage = Math.min(Math.max(q.hitsPerPage ?? 20, 1), ALGOLIA_MAX_HITS);
    params.push(`hitsPerPage=${hitsPerPage}`);
    params.push(`page=${Math.max(q.page ?? 0, 0)}`);
    return `${this.base}/${endpoint}?${params.join('&')}`;
  }

  async search(q: SearchQuery): Promise<AlgoliaResponse> {
    const label = q.sort === 'date' ? 'algolia:search_by_date' : 'algolia:search';
    const res = await this.http.getJson<AlgoliaResponse>(this.buildUrl(q), label);
    return res ?? { hits: [], nbHits: 0, nbPages: 0, page: 0, hitsPerPage: q.hitsPerPage ?? 20 };
  }

  /** Full nested tree for a story (or the subtree under a comment) in one request. */
  item(id: number): Promise<AlgoliaNode | null> {
    return this.http.getJson<AlgoliaNode>(`${this.base}/items/${id}`, 'algolia:items', { allowNotFound: true });
  }

  /** Algolia returns HTTP 500 for unknown users, so failures are reported as null. */
  async user(name: string): Promise<AlgoliaUser | null> {
    try {
      return await this.http.getJson<AlgoliaUser>(`${this.base}/users/${encodeURIComponent(name)}`, 'algolia:users', { allowNotFound: true });
    } catch {
      return null;
    }
  }

  /**
   * Fetch many stories by id in one request per chunk using `tags=(story,job,poll),(story_1,story_2,…)`.
   * The first group keeps comments out (they also carry `story_<id>` tags). Jobs are not indexed by
   * Algolia and brand-new items lag by a minute or so — callers fall back to Firebase for misses.
   */
  async hydrate(ids: number[], chunkSize = 40): Promise<Map<number, AlgoliaHit>> {
    const out = new Map<number, AlgoliaHit>();
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const res = await this.search({
        tags: `(story,job,poll),(${chunk.map((id) => `story_${id}`).join(',')})`,
        hitsPerPage: chunk.length,
      });
      for (const hit of res.hits) out.set(Number(hit.objectID), hit);
    }
    return out;
  }
}
