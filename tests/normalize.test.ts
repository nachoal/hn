import { describe, expect, it } from 'vitest';
import type { AlgoliaNode } from '../src/clients/algolia.js';
import { monthFromTitle } from '../src/commands/hiring.js';
import { parseLaunchTitle } from '../src/commands/launches.js';
import { normalizeDomain } from '../src/commands/search.js';
import {
  countComments,
  domainOf,
  flattenComments,
  fromAlgoliaHit,
  fromFirebaseItem,
  matchKeywords,
  parseDate,
  parseItemRef,
  parseSince,
  reorderByKids,
  sortTree,
  splitList,
  treeFromAlgolia,
  truncateLevelOrder,
  typeFromTags,
} from '../src/normalize.js';
import { timeFilters, thresholdFilters, typeTags } from '../src/query.js';

function node(id: number, children: AlgoliaNode[] = [], extra: Partial<AlgoliaNode> = {}): AlgoliaNode {
  return {
    id,
    type: 'comment',
    author: `u${id}`,
    title: null,
    url: null,
    text: `<p>text ${id}</p>`,
    points: null,
    parent_id: null,
    story_id: 1,
    created_at: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    children,
    ...extra,
  };
}

describe('type detection', () => {
  it('maps Algolia tags with the right precedence', () => {
    expect(typeFromTags(['story', 'author_x', 'story_1'])).toBe('story');
    expect(typeFromTags(['story', 'ask_hn'])).toBe('ask');
    expect(typeFromTags(['story', 'show_hn'])).toBe('show');
    expect(typeFromTags(['comment', 'story_1'])).toBe('comment');
    expect(typeFromTags(['job'])).toBe('job');
    expect(typeFromTags(['poll'])).toBe('poll');
    expect(typeFromTags(undefined)).toBe('story');
  });

  it('derives ask/show from Firebase titles', () => {
    expect(fromFirebaseItem({ id: 1, type: 'story', title: 'Ask HN: Why?' }).type).toBe('ask');
    expect(fromFirebaseItem({ id: 2, type: 'story', title: 'Show HN: Thing' }).type).toBe('show');
    expect(fromFirebaseItem({ id: 3, type: 'job', title: 'Acme is hiring' }).type).toBe('job');
  });
});

describe('item normalization', () => {
  it('normalizes an Algolia story hit', () => {
    const item = fromAlgoliaHit({
      objectID: '42',
      title: 'Hello',
      url: 'https://www.example.com/a?b=1',
      author: 'pg',
      points: 10,
      num_comments: 3,
      created_at: '2026-01-01T00:00:00Z',
      story_text: '<p>hi &amp; bye</p>',
      _tags: ['story', 'author_pg', 'story_42'],
    });
    expect(item).toMatchObject({ id: 42, type: 'story', domain: 'example.com', text: 'hi & bye', hn_url: 'https://news.ycombinator.com/item?id=42' });
  });

  it('normalizes a Firebase item with epoch time and flags', () => {
    const item = fromFirebaseItem({ id: 7, type: 'story', by: 'a', time: 1_700_000_000, score: 5, descendants: 2, dead: true, url: 'http://x.org' });
    expect(item.created_at).toBe('2023-11-14T22:13:20.000Z');
    expect(item.points).toBe(5);
    expect(item.num_comments).toBe(2);
    expect(item.dead).toBe(true);
    expect(item.domain).toBe('x.org');
  });

  it('extracts domains defensively', () => {
    expect(domainOf('https://www.Foo.com/x')).toBe('foo.com');
    expect(domainOf('not a url')).toBeNull();
    expect(domainOf(null)).toBeNull();
    expect(normalizeDomain('https://www.example.com/path?q=1')).toBe('example.com');
    expect(normalizeDomain('Example.COM')).toBe('example.com');
  });
});

describe('comment trees', () => {
  const tree = treeFromAlgolia([node(10, [node(11, [node(12)]), node(13)]), node(20), node(30, [node(31)])]);

  it('builds nested comments with depth and reply_count', () => {
    expect(tree).toHaveLength(3);
    expect(tree[0]!.replies[0]!.depth).toBe(1);
    expect(tree[0]!.reply_count).toBe(2);
    expect(tree[0]!.text).toBe('text 10');
    expect(countComments(tree)).toBe(7);
  });

  it('respects a max depth while keeping reply counts', () => {
    const shallow = treeFromAlgolia([node(10, [node(11, [node(12)])])], 0, 1);
    expect(shallow[0]!.replies).toHaveLength(0);
    expect(shallow[0]!.reply_count).toBe(1);
  });

  it('truncates in level order so top-level comments survive first', () => {
    const { comments, truncated, returned, total } = truncateLevelOrder(tree, 4);
    expect(total).toBe(7);
    expect(returned).toBe(4);
    expect(truncated).toBe(true);
    expect(comments.map((c) => c.id)).toEqual([10, 20, 30]);
    expect(comments[0]!.replies.map((c) => c.id)).toEqual([11]);
    expect(comments[2]!.replies).toEqual([]);
  });

  it('does not truncate when under the cap or when cap is 0', () => {
    expect(truncateLevelOrder(tree, 0).truncated).toBe(false);
    expect(truncateLevelOrder(tree, 100).returned).toBe(7);
  });

  it('reorders top-level comments by Firebase kids and leaves unknowns last', () => {
    const ordered = reorderByKids(tree, [30, 10]);
    expect(ordered.map((c) => c.id)).toEqual([30, 10, 20]);
    expect(reorderByKids(tree, undefined).map((c) => c.id)).toEqual([10, 20, 30]);
  });

  it('sorts by time recursively and flattens with depth', () => {
    const newest = sortTree(tree, 'new');
    expect(newest.map((c) => c.id)).toEqual([30, 20, 10]);
    const flat = flattenComments(tree);
    expect(flat.map((c) => c.id)).toEqual([10, 11, 12, 13, 20, 30, 31]);
    expect(flat.every((c) => c.replies.length === 0)).toBe(true);
    expect(flat[2]!.depth).toBe(2);
  });
});

describe('argument parsing', () => {
  it('parses relative windows', () => {
    expect(parseSince('1h')).toBe(3600);
    expect(parseSince('7d')).toBe(7 * 86400);
    expect(parseSince('2w')).toBe(14 * 86400);
    expect(parseSince('1y')).toBe(365 * 86400);
    expect(() => parseSince('soon')).toThrow(/Invalid --since/);
  });

  it('parses dates as UTC midnight', () => {
    expect(parseDate('2026-01-01')).toBe(1767225600);
    expect(() => parseDate('yesterday')).toThrow(/Invalid --after/);
  });

  it('extracts ids from numbers and URLs', () => {
    expect(parseItemRef('8863')).toBe(8863);
    expect(parseItemRef('https://news.ycombinator.com/item?id=8863')).toBe(8863);
    expect(parseItemRef('https://hn.algolia.com/api/v1/items/8863')).toBe(8863);
    expect(() => parseItemRef('nope')).toThrow(/Cannot parse/);
  });

  it('splits keyword lists and matches case-insensitively', () => {
    expect(splitList('a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(splitList(['a,b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(matchKeywords('Remote Rust engineer', ['rust', 'go'])).toEqual(['rust']);
  });

  it('builds Algolia filters from time and threshold flags', () => {
    const t = timeFilters({ after: '2026-01-01', before: '2026-02-01' });
    expect(t.filters).toEqual(['created_at_i>=1767225600', 'created_at_i<1769904000']);
    expect(timeFilters({ since: '1h' }).filters[0]).toMatch(/^created_at_i>=\d+$/);
    expect(thresholdFilters(10, 5)).toEqual(['points>=10', 'num_comments>=5']);
    expect(thresholdFilters(0, undefined)).toEqual([]);
    expect(typeTags('ask')).toEqual(['ask_hn']);
    expect(typeTags('all')).toEqual([]);
  });
});

describe('HN-specific parsers', () => {
  it('reads the month out of whoishiring titles', () => {
    expect(monthFromTitle('Ask HN: Who is hiring? (August 2026)')).toBe('2026-08');
    expect(monthFromTitle('Ask HN: Who wants to be hired? (January 2025)')).toBe('2025-01');
    expect(monthFromTitle('nope')).toBeNull();
  });

  it('parses Launch HN titles', () => {
    expect(parseLaunchTitle('Launch HN: OneCLI (YC S26) – OSS sandboxed agent harness for teams')).toEqual({
      company: 'OneCLI',
      batch: 'S26',
      tagline: 'OSS sandboxed agent harness for teams',
    });
    expect(parseLaunchTitle('Launch HN: Vendo (YC S26) - Let users build features')).toMatchObject({ company: 'Vendo', tagline: 'Let users build features' });
    expect(parseLaunchTitle('Launch HN: NoDash (YC W24)')).toEqual({ company: 'NoDash', batch: 'W24', tagline: null });
    expect(parseLaunchTitle('Launch HN: ProvenMetal (YC S26) delivers circuit boards in days')).toEqual({
      company: 'ProvenMetal',
      batch: 'S26',
      tagline: 'delivers circuit boards in days',
    });
    expect(parseLaunchTitle('Show HN: not a launch')).toBeNull();
  });
});
