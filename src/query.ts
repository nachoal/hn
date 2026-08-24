import { nowSeconds, parseDate, parseSince } from './normalize.js';
import type { SearchType } from './types.js';

export const SEARCH_TYPES = ['story', 'ask', 'show', 'poll', 'job', 'comment', 'all'] as const;

/** Algolia tag(s) for a --type value. `ask_hn`/`show_hn` imply `story`, so they stand alone. */
export function typeTags(type: SearchType): string[] {
  switch (type) {
    case 'story':
      return ['story'];
    case 'ask':
      return ['ask_hn'];
    case 'show':
      return ['show_hn'];
    case 'poll':
      return ['poll'];
    case 'job':
      return ['job'];
    case 'comment':
      return ['comment'];
    case 'all':
      return [];
  }
}

export function joinTags(parts: string[]): string | undefined {
  return parts.length > 0 ? parts.join(',') : undefined;
}

export interface TimeFlags {
  since?: string;
  after?: string;
  before?: string;
}

export interface TimeWindow {
  filters: string[];
  after?: number;
  before?: number;
}

/** --after wins over --since when both are given; --before is independent. */
export function timeFilters(flags: TimeFlags): TimeWindow {
  const filters: string[] = [];
  let after: number | undefined;
  let before: number | undefined;
  if (flags.after) after = parseDate(flags.after, '--after');
  else if (flags.since) after = nowSeconds() - parseSince(flags.since);
  if (flags.before) before = parseDate(flags.before, '--before');
  if (after !== undefined) filters.push(`created_at_i>=${after}`);
  if (before !== undefined) filters.push(`created_at_i<${before}`);
  return { filters, after, before };
}

export function thresholdFilters(minPoints?: number, minComments?: number): string[] {
  const filters: string[] = [];
  if (minPoints !== undefined && minPoints > 0) filters.push(`points>=${Math.floor(minPoints)}`);
  if (minComments !== undefined && minComments > 0) filters.push(`num_comments>=${Math.floor(minComments)}`);
  return filters;
}

export function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = value === undefined || Number.isNaN(value) ? fallback : value;
  return Math.min(Math.max(Math.floor(n), min), max);
}

export const IN_ATTRIBUTES: Record<string, string> = {
  title: 'title',
  url: 'url',
  text: 'story_text,comment_text',
};
