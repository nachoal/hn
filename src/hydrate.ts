import type { Ctx } from './context.js';
import { fromAlgoliaHit, fromFirebaseItem } from './normalize.js';
import type { HnItem } from './types.js';

export interface HydrateOptions {
  /** Fetch every item from Firebase (real-time score/comment count; one request per item). */
  live?: boolean;
  /** Rank of the first id (0-based offset into the source list). */
  rankOffset?: number;
}

/**
 * Turn an ordered list of ids into normalized items, preserving order and attaching `rank`.
 * Default path: one Algolia request per 40 ids, Firebase only for the misses (jobs, very fresh items).
 */
export async function hydrateIds(ctx: Ctx, ids: number[], opts: HydrateOptions = {}): Promise<HnItem[]> {
  const offset = opts.rankOffset ?? 0;
  if (ids.length === 0) return [];

  if (opts.live) {
    const raws = await ctx.firebase.items(ids);
    const items: (HnItem | null)[] = raws.map((raw, i) => (raw && !raw.deleted ? { ...fromFirebaseItem(raw), rank: offset + i + 1 } : null));
    return items.filter((x): x is HnItem => x !== null);
  }

  const hits = await ctx.algolia.hydrate(ids);
  const missing = ids.filter((id) => !hits.has(id));
  const fallback = new Map<number, HnItem>();
  if (missing.length > 0) {
    const raws = await ctx.firebase.items(missing);
    for (const raw of raws) if (raw && !raw.deleted) fallback.set(raw.id, fromFirebaseItem(raw));
  }

  const out: HnItem[] = [];
  ids.forEach((id, i) => {
    const hit = hits.get(id);
    const item = hit ? fromAlgoliaHit(hit) : fallback.get(id);
    if (item) out.push({ ...item, rank: offset + i + 1 });
  });
  return out;
}
