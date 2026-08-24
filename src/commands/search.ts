import type { Argv } from 'yargs';
import type { AlgoliaHit } from '../clients/algolia.js';
import { buildMeta, createContext } from '../context.js';
import { UsageError } from '../errors.js';
import { commentFromHit, fromAlgoliaHit, typeFromTags } from '../normalize.js';
import { output } from '../output.js';
import { searchAll } from '../paginate.js';
import { IN_ATTRIBUTES, SEARCH_TYPES, clamp, joinTags, thresholdFilters, timeFilters, typeTags } from '../query.js';
import type { HnEntry, SearchSort, SearchType } from '../types.js';

export function hitToEntry(hit: AlgoliaHit): HnEntry {
  return typeFromTags(hit._tags) === 'comment' ? commentFromHit(hit) : fromAlgoliaHit(hit);
}

const CAP_NOTE =
  'Algolia caps every query at 1,000 hits (nb_pages reflects the cap). Narrow with --since/--after/--before, or use --all to slice by date automatically.';

export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split('/')[0]!.split('?')[0]!;
  return d.replace(/^www\./, '');
}

export function registerSearchCommands(yargs: Argv) {
  return yargs
    .command(
      'search',
      'Full-text search over stories and comments (Algolia)',
      (y) =>
        y
          .option('q', { type: 'string', alias: 'query', describe: 'Search text (optional when filtering by --author / --since / --min-points)' })
          .option('type', { type: 'string', choices: SEARCH_TYPES, default: 'story' as const, describe: 'Item type' })
          .option('comments', { type: 'boolean', default: false, describe: 'Shorthand for --type comment' })
          .option('sort', {
            type: 'string',
            choices: ['relevance', 'date'] as const,
            default: 'relevance' as const,
            describe: 'relevance = Algolia ranking weighted by points; date = newest first',
          })
          .option('since', { type: 'string', describe: 'Relative window: 1h, 24h, 7d, 2w, 30d, 1y' })
          .option('after', { type: 'string', describe: 'Created on/after YYYY-MM-DD (UTC); overrides --since' })
          .option('before', { type: 'string', describe: 'Created before YYYY-MM-DD (UTC)' })
          .option('min-points', { type: 'number', describe: 'Minimum points' })
          .option('min-comments', { type: 'number', describe: 'Minimum comment count' })
          .option('author', { type: 'string', describe: 'Only items by this username' })
          .option('in', { type: 'string', choices: ['title', 'url', 'text'] as const, describe: 'Match only this field' })
          .option('limit', { type: 'number', default: 20, describe: 'Hits per page (max 1000)' })
          .option('page', { type: 'number', default: 1, describe: 'Page number, 1-based' })
          .option('all', { type: 'boolean', default: false, describe: 'Fetch every page up to --max-pages; slices by date past the 1,000-hit cap' })
          .option('max-pages', { type: 'number', default: 10, describe: 'Request budget for --all' })
          .check((argv) => {
            if (!argv.q && !argv.author && !argv.since && !argv.after && !argv.before && argv.minPoints === undefined) {
              throw new UsageError('Nothing to search for.', 'Give a query (hn search -q "claude code") or a filter (hn search --since 7d --min-points 100)');
            }
            return true;
          })
          .example('hn search -q "claude code" --since 30d --min-points 50', 'Popular recent stories about a topic')
          .example('hn search -q "rate limit" --comments --since 7d --limit 50', 'What commenters said this week')
          .example('hn search --since 7d --min-points 200 --sort date', 'Big stories this week, no text query')
          .example('hn search -q "postgres" --type ask --after 2026-01-01 --before 2026-07-01', 'Ask HN posts in a date range')
          .example('hn search -q "sqlite" --all --max-pages 20 --sort date', 'Deep pull, auto-sliced past the 1,000-hit cap'),
      async (argv) => {
        const ctx = createContext();
        const type = (argv.comments ? 'comment' : argv.type) as SearchType;
        const tags = [...typeTags(type)];
        if (argv.author) tags.push(`author_${argv.author as string}`);
        const time = timeFilters({ since: argv.since as string | undefined, after: argv.after as string | undefined, before: argv.before as string | undefined });
        const filters = [...time.filters, ...thresholdFilters(argv.minPoints as number | undefined, argv.minComments as number | undefined)];
        const sort = argv.sort as SearchSort;
        const limit = clamp(argv.limit as number, 1, 1000, 20);
        const page = clamp(argv.page as number, 1, 100000, 1);
        const base = {
          query: argv.q as string | undefined,
          tags: joinTags(tags),
          numericFilters: filters,
          restrictSearchableAttributes: argv.in ? IN_ATTRIBUTES[argv.in as string] : undefined,
          sort,
        };

        if (argv.all) {
          const maxPages = clamp(argv.maxPages as number, 1, 1000, 10);
          const result = await searchAll(ctx.algolia, base, {
            maxPages,
            hitsPerPage: limit,
            after: time.after,
            before: time.before,
            paceMs: ctx.settings.paceMs,
          });
          const items = result.hits.map(hitToEntry);
          output(
            {
              query: base.query ?? null,
              type,
              sort,
              items,
              count: items.length,
              nb_hits: result.nb_hits,
              pages_fetched: result.pages_fetched,
              windows: result.windows,
              capped: result.capped,
              _meta: buildMeta(ctx, result.capped ? `Stopped at --max-pages ${maxPages}; raise it to pull more.` : undefined),
            },
            argv.pretty as boolean,
          );
          return;
        }

        const res = await ctx.algolia.search({ ...base, hitsPerPage: limit, page: page - 1 });
        const items = res.hits.map(hitToEntry);
        output(
          {
            query: base.query ?? null,
            type,
            sort,
            items,
            count: items.length,
            page,
            nb_hits: res.nbHits,
            nb_pages: res.nbPages,
            _meta: buildMeta(ctx, res.nbHits > 1000 ? CAP_NOTE : undefined),
          },
          argv.pretty as boolean,
        );
      },
    )
    .command(
      'domain <domain>',
      'Everything HN has submitted from a site (matches the submitted URL)',
      (y) =>
        y
          .positional('domain', { type: 'string', demandOption: true, describe: 'e.g. anthropic.com (scheme/path ignored)' })
          .option('since', { type: 'string', describe: 'Relative window: 7d, 30d, 1y' })
          .option('after', { type: 'string', describe: 'Created on/after YYYY-MM-DD (UTC)' })
          .option('before', { type: 'string', describe: 'Created before YYYY-MM-DD (UTC)' })
          .option('min-points', { type: 'number', describe: 'Minimum points' })
          .option('sort', {
            type: 'string',
            choices: ['points', 'date'] as const,
            default: 'points' as const,
            describe: 'points = most upvoted first; date = newest first',
          })
          .option('limit', { type: 'number', default: 30, describe: 'Hits per page (max 1000)' })
          .option('page', { type: 'number', default: 1, describe: 'Page number, 1-based' })
          .example('hn domain anthropic.com', 'Most upvoted submissions from a site')
          .example('hn domain github.com/simonw --since 1y --sort date', 'Path is ignored; newest first')
          .example("hn domain example.com | jq '.items[] | {title, points, num_comments, hn_url}'", 'Trim to the useful fields'),
      async (argv) => {
        const ctx = createContext();
        const domain = normalizeDomain(argv.domain as string);
        if (!domain) throw new UsageError('Empty domain.', 'Example: hn domain anthropic.com');
        const time = timeFilters({ since: argv.since as string | undefined, after: argv.after as string | undefined, before: argv.before as string | undefined });
        const filters = [...time.filters, ...thresholdFilters(argv.minPoints as number | undefined)];
        const limit = clamp(argv.limit as number, 1, 1000, 30);
        const page = clamp(argv.page as number, 1, 100000, 1);
        const res = await ctx.algolia.search({
          query: domain,
          restrictSearchableAttributes: 'url',
          tags: 'story',
          numericFilters: filters,
          sort: argv.sort === 'date' ? 'date' : 'relevance',
          hitsPerPage: limit,
          page: page - 1,
        });
        const items = res.hits
          .map(fromAlgoliaHit)
          .filter((item) => item.domain !== null && (item.domain === domain || item.domain.endsWith(`.${domain}`)));
        output(
          {
            domain,
            items,
            count: items.length,
            page,
            nb_hits: res.nbHits,
            nb_pages: res.nbPages,
            _meta: buildMeta(ctx, 'nb_hits counts URL text matches before the exact-domain filter; count is what survived.'),
          },
          argv.pretty as boolean,
        );
      },
    );
}
