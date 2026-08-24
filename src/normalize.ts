import type { AlgoliaHit, AlgoliaNode } from './clients/algolia.js';
import type { FirebaseItem } from './clients/firebase.js';
import { UsageError } from './errors.js';
import { htmlToText } from './text.js';
import type { HnComment, HnItem, ItemType } from './types.js';

export function hnUrl(id: number | string): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function typeFromTags(tags: string[] | undefined): ItemType {
  const t = tags ?? [];
  if (t.includes('comment')) return 'comment';
  if (t.includes('job')) return 'job';
  if (t.includes('pollopt')) return 'pollopt';
  if (t.includes('poll')) return 'poll';
  if (t.includes('ask_hn')) return 'ask';
  if (t.includes('show_hn')) return 'show';
  return 'story';
}

export function typeFromFirebase(item: FirebaseItem): ItemType {
  switch (item.type) {
    case 'job':
      return 'job';
    case 'poll':
      return 'poll';
    case 'pollopt':
      return 'pollopt';
    case 'comment':
      return 'comment';
    default: {
      const title = item.title ?? '';
      if (/^Ask HN\b/i.test(title)) return 'ask';
      if (/^Show HN\b/i.test(title)) return 'show';
      return 'story';
    }
  }
}

function isoFromEpoch(seconds: number | undefined | null): string | null {
  if (seconds === undefined || seconds === null) return null;
  return new Date(seconds * 1000).toISOString();
}

export function fromAlgoliaHit(hit: AlgoliaHit): HnItem {
  const id = Number(hit.objectID);
  const url = hit.url ?? null;
  return {
    id,
    type: typeFromTags(hit._tags),
    title: hit.title ?? null,
    url,
    domain: domainOf(url),
    author: hit.author ?? null,
    points: hit.points ?? null,
    num_comments: hit.num_comments ?? null,
    created_at: hit.created_at ?? isoFromEpoch(hit.created_at_i),
    text: htmlToText(hit.story_text ?? null),
    hn_url: hnUrl(id),
  };
}

export function fromFirebaseItem(item: FirebaseItem): HnItem {
  const url = item.url ?? null;
  const out: HnItem = {
    id: item.id,
    type: typeFromFirebase(item),
    title: item.title ?? null,
    url,
    domain: domainOf(url),
    author: item.by ?? null,
    points: item.score ?? null,
    num_comments: item.descendants ?? null,
    created_at: isoFromEpoch(item.time),
    text: htmlToText(item.text ?? null),
    hn_url: hnUrl(item.id),
  };
  if (item.dead) out.dead = true;
  if (item.deleted) out.deleted = true;
  return out;
}

/** A comment as returned by Algolia *search* (flat hit with story context, no children). */
export function commentFromHit(hit: AlgoliaHit): HnComment {
  const id = Number(hit.objectID);
  return {
    id,
    type: 'comment',
    author: hit.author ?? null,
    text: htmlToText(hit.comment_text ?? null),
    created_at: hit.created_at ?? isoFromEpoch(hit.created_at_i),
    parent_id: hit.parent_id ?? null,
    story_id: hit.story_id ?? null,
    depth: 0,
    hn_url: hnUrl(id),
    story_title: hit.story_title ?? null,
    story_url: hit.story_url ?? null,
    reply_count: 0,
    replies: [],
  };
}

/** Recursively normalize an Algolia items/:id subtree into HnComment nodes. */
export function treeFromAlgolia(nodes: AlgoliaNode[], depth = 0, maxDepth = 0): HnComment[] {
  const out: HnComment[] = [];
  for (const node of nodes) {
    if (node.type !== 'comment') continue;
    const children = node.children ?? [];
    const replies = maxDepth > 0 && depth + 1 >= maxDepth ? [] : treeFromAlgolia(children, depth + 1, maxDepth);
    out.push({
      id: node.id,
      type: 'comment',
      author: node.author ?? null,
      text: htmlToText(node.text),
      created_at: node.created_at ?? isoFromEpoch(node.created_at_i),
      parent_id: node.parent_id ?? null,
      story_id: node.story_id ?? null,
      depth,
      hn_url: hnUrl(node.id),
      reply_count: children.filter((c) => c.type === 'comment').length,
      replies,
    });
  }
  return out;
}

export function countComments(tree: HnComment[]): number {
  let n = 0;
  for (const c of tree) n += 1 + countComments(c.replies);
  return n;
}

/** Pre-order flatten; `replies` emptied, `depth` and `reply_count` preserved. */
export function flattenComments(tree: HnComment[]): HnComment[] {
  const out: HnComment[] = [];
  const walk = (nodes: HnComment[]) => {
    for (const c of nodes) {
      out.push({ ...c, replies: [] });
      walk(c.replies);
    }
  };
  walk(tree);
  return out;
}

/**
 * Keep the first `max` comments in level order (all top-level first, then their replies, …).
 * Level order guarantees every kept comment's ancestors are kept too, so the tree stays valid,
 * and it favors top-level comments — which carry most of a thread's signal.
 */
export function truncateLevelOrder(tree: HnComment[], max: number): { comments: HnComment[]; truncated: boolean; returned: number; total: number } {
  const total = countComments(tree);
  if (max <= 0 || total <= max) return { comments: tree, truncated: false, returned: total, total };
  const kept = new Set<number>();
  const queue: HnComment[] = [...tree];
  while (queue.length) {
    const node = queue.shift()!;
    if (kept.size < max) kept.add(node.id);
    else break;
    queue.push(...node.replies);
  }
  const prune = (nodes: HnComment[]): HnComment[] =>
    nodes.filter((n) => kept.has(n.id)).map((n) => ({ ...n, replies: prune(n.replies) }));
  return { comments: prune(tree), truncated: true, returned: kept.size, total };
}

export function sortTree(tree: HnComment[], mode: 'new' | 'old'): HnComment[] {
  const sorted = [...tree].sort((a, b) => {
    const ta = a.created_at ?? '';
    const tb = b.created_at ?? '';
    return mode === 'new' ? tb.localeCompare(ta) : ta.localeCompare(tb);
  });
  return sorted.map((c) => ({ ...c, replies: sortTree(c.replies, mode) }));
}

/** Reorder top-level comments to match Firebase `kids` (HN's ranked display order). */
export function reorderByKids(tree: HnComment[], kids: number[] | undefined): HnComment[] {
  if (!kids || kids.length === 0) return tree;
  const rank = new Map<number, number>();
  kids.forEach((id, i) => rank.set(id, i));
  return [...tree].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

const SINCE_UNITS: Record<string, number> = { h: 3600, d: 86400, w: 7 * 86400, m: 30 * 86400, y: 365 * 86400 };

/** "7d" → seconds. Accepts h (hours), d (days), w (weeks), m (30-day months), y (years). */
export function parseSince(since: string): number {
  const m = /^(\d+)\s*([hdwmy])$/i.exec(since.trim());
  if (!m) {
    throw new UsageError(`Invalid --since value: "${since}"`, 'Use a number plus unit: 1h, 24h, 7d, 2w, 30d, 1y');
  }
  return Number(m[1]) * SINCE_UNITS[m[2]!.toLowerCase()]!;
}

/** YYYY-MM-DD (UTC) or any ISO date-time → epoch seconds. */
export function parseDate(input: string, flag = '--after'): number {
  const trimmed = input.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new UsageError(`Invalid ${flag} date: "${input}"`, 'Use YYYY-MM-DD, e.g. --after 2026-01-01');
  }
  return Math.floor(ms / 1000);
}

/** Numeric id, or a news.ycombinator.com / hn.algolia.com URL containing one. */
export function parseItemRef(ref: string): number {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = /(?:[?&]id=|\/items\/|\/item\/)(\d+)/.exec(trimmed);
  if (m) return Number(m[1]);
  throw new UsageError(`Cannot parse item id from "${ref}"`, 'Pass a numeric id or a URL like https://news.ycombinator.com/item?id=8863');
}

export function splitList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .flatMap((p) => p.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Case-insensitive substring match; returns the keywords that hit. */
export function matchKeywords(haystack: string, keywords: string[]): string[] {
  const hay = haystack.toLowerCase();
  return keywords.filter((k) => hay.includes(k.toLowerCase()));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
