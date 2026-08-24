import type { Argv } from 'yargs';
import { buildMeta, createContext } from '../context.js';
import { fromAlgoliaHit } from '../normalize.js';
import { output } from '../output.js';
import { clamp, thresholdFilters, timeFilters } from '../query.js';

// "Launch HN: Company (YC S26) – tagline"; the dash is conventional but not universal.
const LAUNCH_RE = /^Launch HN:\s*(.+?)\s*\(\s*YC\s+([A-Z]+\s?\d{2})\s*\)\s*(?:[–—:-]\s*)?(.*)$/i;

export interface LaunchParts {
  company: string;
  batch: string;
  tagline: string | null;
}

export function parseLaunchTitle(title: string | null | undefined): LaunchParts | null {
  const m = LAUNCH_RE.exec(title ?? '');
  if (!m) return null;
  return { company: m[1]!.trim(), batch: m[2]!.replace(/\s+/g, '').toUpperCase(), tagline: m[3]?.trim() || null };
}

export function registerLaunchCommands(yargs: Argv) {
  return yargs.command(
    'launches',
    '"Launch HN" posts — YC startups launching on Hacker News',
    (y) =>
      y
        .option('since', { type: 'string', default: '30d', describe: 'Relative window: 7d, 30d, 1y' })
        .option('after', { type: 'string', describe: 'Created on/after YYYY-MM-DD (UTC); overrides --since' })
        .option('before', { type: 'string', describe: 'Created before YYYY-MM-DD (UTC)' })
        .option('batch', { type: 'string', describe: 'YC batch filter, e.g. S26, W26, F25' })
        .option('min-points', { type: 'number', describe: 'Minimum points' })
        .option('sort', { type: 'string', choices: ['date', 'points'] as const, default: 'date' as const, describe: 'date = newest first; points = most upvoted first' })
        .option('limit', { type: 'number', default: 50, describe: 'Hits per page (max 1000)' })
        .option('page', { type: 'number', default: 1, describe: 'Page number, 1-based' })
        .example('hn launches', 'Launches in the last 30 days')
        .example('hn launches --since 1y --batch S26 --sort points', 'Best-received S26 launches')
        .example("hn launches | jq -r '.items[] | \"\\(.company) — \\(.tagline) [\\(.points)]\"'", 'One line per launch'),
    async (argv) => {
      const ctx = createContext();
      const time = timeFilters({ since: argv.since as string | undefined, after: argv.after as string | undefined, before: argv.before as string | undefined });
      const limit = clamp(argv.limit as number, 1, 1000, 50);
      const page = clamp(argv.page as number, 1, 100000, 1);
      const batch = argv.batch ? (argv.batch as string).replace(/\s+/g, '').toUpperCase() : undefined;
      const res = await ctx.algolia.search({
        // The batch token in the query makes Algolia rank that batch first; the exact filter below does the rest.
        query: batch ? `Launch HN ${batch}` : 'Launch HN',
        restrictSearchableAttributes: 'title',
        tags: 'story',
        numericFilters: [...time.filters, ...thresholdFilters(argv.minPoints as number | undefined)],
        sort: argv.sort === 'points' ? 'relevance' : 'date',
        hitsPerPage: limit,
        page: page - 1,
      });
      const items = res.hits
        .map((hit) => {
          const item = fromAlgoliaHit(hit);
          const parts = parseLaunchTitle(item.title);
          return parts ? { ...item, ...parts } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .filter((x) => !batch || x.batch === batch);
      output(
        {
          since: argv.after ? null : argv.since,
          batch: batch ?? null,
          items,
          count: items.length,
          page,
          nb_hits: res.nbHits,
          nb_pages: res.nbPages,
          _meta: buildMeta(ctx, 'nb_hits counts title matches for "Launch HN" before parsing; count is what parsed as a launch.'),
        },
        argv.pretty as boolean,
      );
    },
  );
}
