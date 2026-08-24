import type { Argv } from 'yargs';
import { buildMeta, createContext } from '../context.js';
import { UsageError } from '../errors.js';
import { sleep } from '../http.js';
import { splitList } from '../normalize.js';
import { output } from '../output.js';
import { IN_ATTRIBUTES, SEARCH_TYPES, clamp, joinTags, thresholdFilters, timeFilters, typeTags } from '../query.js';
import type { SearchSort, SearchType } from '../types.js';
import { hitToEntry } from './search.js';

export function registerDigestCommands(yargs: Argv) {
  return yargs.command(
    'digest',
    'Scan several keywords in one call — one ranked bucket per keyword',
    (y) =>
      y
        .option('keywords', { type: 'string', demandOption: true, describe: 'Comma-separated keywords or phrases' })
        .option('type', { type: 'string', choices: SEARCH_TYPES, default: 'story' as const, describe: 'Item type' })
        .option('since', { type: 'string', default: '7d', describe: 'Relative window: 24h, 7d, 30d' })
        .option('after', { type: 'string', describe: 'Created on/after YYYY-MM-DD (UTC); overrides --since' })
        .option('before', { type: 'string', describe: 'Created before YYYY-MM-DD (UTC)' })
        .option('min-points', { type: 'number', default: 0, describe: 'Minimum points' })
        .option('sort', { type: 'string', choices: ['relevance', 'date'] as const, default: 'relevance' as const })
        .option('in', { type: 'string', choices: ['title', 'url', 'text'] as const, describe: 'Match only this field' })
        .option('limit', { type: 'number', default: 50, describe: 'Hits per keyword (max 1000)' })
        .example('hn digest --keywords "claude code,cursor,codex" --since 7d --min-points 20', 'Compare three products this week')
        .example('hn digest --keywords "postgres,sqlite" --type comment --since 30d', 'What commenters say')
        .example("hn digest --keywords \"a,b\" | jq '.buckets[] | {keyword, count}'", 'Just the counts'),
    async (argv) => {
      const ctx = createContext();
      const keywords = splitList(argv.keywords as string);
      if (keywords.length === 0) throw new UsageError('No keywords given.', 'Example: hn digest --keywords "claude code,cursor" --since 7d');
      const type = argv.type as SearchType;
      const time = timeFilters({ since: argv.since as string | undefined, after: argv.after as string | undefined, before: argv.before as string | undefined });
      const filters = [...time.filters, ...thresholdFilters(argv.minPoints as number | undefined)];
      const limit = clamp(argv.limit as number, 1, 1000, 50);
      const sort = argv.sort as SearchSort;
      const seen = new Set<number>();
      const buckets = [];
      for (const [i, keyword] of keywords.entries()) {
        if (i > 0 && ctx.settings.paceMs > 0) await sleep(ctx.settings.paceMs);
        const res = await ctx.algolia.search({
          query: keyword,
          tags: joinTags(typeTags(type)),
          numericFilters: filters,
          restrictSearchableAttributes: argv.in ? IN_ATTRIBUTES[argv.in as string] : undefined,
          sort,
          hitsPerPage: limit,
        });
        const items = res.hits.map(hitToEntry);
        for (const item of items) seen.add(item.id);
        buckets.push({ keyword, nb_hits: res.nbHits, count: items.length, items });
      }
      output(
        {
          query_time: new Date().toISOString(),
          type,
          since: argv.after ? null : argv.since,
          sort,
          keywords,
          buckets,
          unique_count: seen.size,
          _meta: buildMeta(ctx),
        },
        argv.pretty as boolean,
      );
    },
  );
}
