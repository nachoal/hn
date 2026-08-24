export type ItemType = 'story' | 'ask' | 'show' | 'job' | 'poll' | 'pollopt' | 'comment';

export type Source = 'firebase' | 'algolia' | 'mixed' | 'local';

export type SearchType = 'story' | 'ask' | 'show' | 'poll' | 'job' | 'comment' | 'all';

export type SearchSort = 'relevance' | 'date';

export interface Meta {
  source: Source;
  requests: number;
  endpoints: string[];
  fetched_at: string;
  note?: string;
}

/** Normalized story / ask / show / job / poll item — same shape whichever API served it. */
export interface HnItem {
  id: number;
  type: ItemType;
  title: string | null;
  url: string | null;
  domain: string | null;
  author: string | null;
  points: number | null;
  num_comments: number | null;
  created_at: string | null;
  text: string | null;
  hn_url: string;
  rank?: number;
  dead?: boolean;
  deleted?: boolean;
}

/** Normalized comment. In trees, `replies` nests; in flat listings it is empty and `reply_count` says how many were dropped. */
export interface HnComment {
  id: number;
  type: 'comment';
  author: string | null;
  text: string | null;
  created_at: string | null;
  parent_id: number | null;
  story_id: number | null;
  depth: number;
  hn_url: string;
  story_title?: string | null;
  story_url?: string | null;
  reply_count: number;
  replies: HnComment[];
}

export type HnEntry = HnItem | HnComment;

export interface FeedFile {
  name: string;
  keywords: string[];
  type: SearchType;
  since: string;
  min_points: number;
  limit: number;
  created_at: string;
  last_run_at: string | null;
  seen_ids: number[];
}
