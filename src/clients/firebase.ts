import { pMap, type Http } from '../http.js';

export type FeedKind = 'top' | 'new' | 'best' | 'ask' | 'show' | 'jobs';

export const FEED_PATHS: Record<FeedKind, string> = {
  top: 'topstories',
  new: 'newstories',
  best: 'beststories',
  ask: 'askstories',
  show: 'showstories',
  jobs: 'jobstories',
};

export interface FirebaseItem {
  id: number;
  type?: 'job' | 'story' | 'comment' | 'poll' | 'pollopt';
  by?: string;
  time?: number;
  text?: string;
  url?: string;
  score?: number;
  title?: string;
  kids?: number[];
  parent?: number;
  poll?: number;
  parts?: number[];
  descendants?: number;
  deleted?: boolean;
  dead?: boolean;
}

export interface FirebaseUser {
  id: string;
  created: number;
  karma: number;
  about?: string;
  submitted?: number[];
}

export interface FirebaseUpdates {
  items: number[];
  profiles: string[];
}

/** Official HN API (read-only, keyless, no documented rate limit). One item per request. */
export class FirebaseClient {
  constructor(
    private readonly http: Http,
    private readonly base = 'https://hacker-news.firebaseio.com/v0',
  ) {}

  async list(kind: FeedKind): Promise<number[]> {
    const ids = await this.http.getJson<number[]>(`${this.base}/${FEED_PATHS[kind]}.json`, `firebase:${FEED_PATHS[kind]}`);
    return Array.isArray(ids) ? ids : [];
  }

  item(id: number): Promise<FirebaseItem | null> {
    return this.http.getJson<FirebaseItem>(`${this.base}/item/${id}.json`, 'firebase:item');
  }

  items(ids: number[], concurrency = 8): Promise<(FirebaseItem | null)[]> {
    return pMap(ids, concurrency, (id) => this.item(id));
  }

  user(name: string): Promise<FirebaseUser | null> {
    return this.http.getJson<FirebaseUser>(`${this.base}/user/${encodeURIComponent(name)}.json`, 'firebase:user');
  }

  async updates(): Promise<FirebaseUpdates> {
    const u = await this.http.getJson<FirebaseUpdates>(`${this.base}/updates.json`, 'firebase:updates');
    return u ?? { items: [], profiles: [] };
  }

  async maxitem(): Promise<number> {
    const n = await this.http.getJson<number>(`${this.base}/maxitem.json`, 'firebase:maxitem');
    return n ?? 0;
  }
}
