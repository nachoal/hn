import type { Argv } from 'yargs';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { feedsDir } from '../config.js';
import { buildMeta, createContext } from '../context.js';
import { NotFoundError, UsageError } from '../errors.js';
import { sleep } from '../http.js';
import { nowSeconds, parseSince, splitList } from '../normalize.js';
import { output } from '../output.js';
import { SEARCH_TYPES, clamp, joinTags, thresholdFilters, typeTags } from '../query.js';
import type { FeedFile, HnEntry, SearchType } from '../types.js';
import { hitToEntry } from './search.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function feedPath(name: string): string {
  return join(feedsDir(), `${name}.json`);
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new UsageError(`Invalid feed name "${name}"`, 'Use letters, digits, dots, dashes, underscores (max 64 chars).');
}

export function loadFeed(name: string): FeedFile | null {
  const p = feedPath(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as FeedFile;
  } catch {
    return null;
  }
}

export function saveFeed(feed: FeedFile): void {
  const dir = feedsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(feedPath(feed.name), JSON.stringify(feed, null, 2) + '\n');
}

function points(entry: HnEntry): number {
  return 'points' in entry && typeof entry.points === 'number' ? entry.points : 0;
}

export function registerFeedCommands(yargs: Argv) {
  return yargs.command('feed', 'Persistent keyword feeds — idempotent re-runs return only unseen items', (y) =>
    y
      .command(
        'create <name>',
        'Create a named feed',
        (y) =>
          y
            .positional('name', { type: 'string', demandOption: true, describe: 'Feed name (filesystem-safe)' })
            .option('keywords', { type: 'string', demandOption: true, describe: 'Comma-separated keywords or phrases' })
            .option('type', { type: 'string', choices: SEARCH_TYPES, default: 'story' as const, describe: 'Item type' })
            .option('since', { type: 'string', default: '7d', describe: 'Look-back window per run: 24h, 7d, 30d' })
            .option('min-points', { type: 'number', default: 0, describe: 'Minimum points' })
            .option('limit', { type: 'number', default: 50, describe: 'Hits per keyword per run (max 1000)' })
            .example('hn feed create brand --keywords "acme,acme.com" --type all --since 7d', 'Track brand mentions in stories and comments')
            .example('hn feed create ai-agents --keywords "ai agents,agentic" --min-points 20', 'Popular stories only'),
        async (argv) => {
          const name = argv.name as string;
          assertName(name);
          if (loadFeed(name)) throw new UsageError(`Feed "${name}" already exists.`, `Run it: hn feed run ${name} — or delete it: hn feed delete ${name} --yes`);
          const keywords = splitList(argv.keywords as string);
          if (keywords.length === 0) throw new UsageError('No keywords given.', 'Example: --keywords "acme,acme.com"');
          parseSince(argv.since as string);
          const feed: FeedFile = {
            name,
            keywords,
            type: argv.type as SearchType,
            since: argv.since as string,
            min_points: (argv.minPoints as number) ?? 0,
            limit: clamp(argv.limit as number, 1, 1000, 50),
            created_at: new Date().toISOString(),
            last_run_at: null,
            seen_ids: [],
          };
          saveFeed(feed);
          output({ created: true, feed, path: feedPath(name) }, argv.pretty as boolean);
        },
      )
      .command(
        'list',
        'List saved feeds',
        (y) => y.example('hn feed list', 'Show all feeds'),
        async (argv) => {
          const dir = feedsDir();
          const feeds = existsSync(dir)
            ? readdirSync(dir)
                .filter((f) => f.endsWith('.json'))
                .map((f) => loadFeed(f.replace(/\.json$/, '')))
                .filter((f): f is FeedFile => f !== null)
                .map((f) => ({ ...f, seen_count: f.seen_ids.length, seen_ids: undefined }))
            : [];
          output({ feeds, count: feeds.length, dir }, argv.pretty as boolean);
        },
      )
      .command(
        'run <name>',
        'Fetch matches and return only items not seen on previous runs',
        (y) =>
          y
            .positional('name', { type: 'string', demandOption: true })
            .option('dry-run', { type: 'boolean', default: false, describe: 'Preview without marking items as seen' })
            .example('hn feed run brand', 'New matches since the last run')
            .example('hn feed run brand --dry-run', 'Preview, nothing marked seen'),
        async (argv) => {
          const name = argv.name as string;
          const feed = loadFeed(name);
          if (!feed) throw new NotFoundError(`Feed not found: ${name}`, 'List feeds: hn feed list — create one: hn feed create <name> --keywords "..."');
          const ctx = createContext();
          const seen = new Set(feed.seen_ids);
          const fresh = new Map<number, HnEntry>();
          const filters = [`created_at_i>=${nowSeconds() - parseSince(feed.since)}`, ...thresholdFilters(feed.min_points)];
          for (const [i, keyword] of feed.keywords.entries()) {
            if (i > 0 && ctx.settings.paceMs > 0) await sleep(ctx.settings.paceMs);
            const res = await ctx.algolia.search({
              query: keyword,
              tags: joinTags(typeTags(feed.type)),
              numericFilters: filters,
              sort: 'date',
              hitsPerPage: feed.limit,
            });
            for (const hit of res.hits) {
              const entry = hitToEntry(hit);
              if (!seen.has(entry.id) && !fresh.has(entry.id)) fresh.set(entry.id, entry);
            }
          }
          const newItems = [...fresh.values()].sort((a, b) => points(b) - points(a));
          if (!argv.dryRun) {
            feed.seen_ids = [...seen, ...newItems.map((i) => i.id)].slice(-5000);
            feed.last_run_at = new Date().toISOString();
            saveFeed(feed);
          }
          output(
            {
              feed: feed.name,
              dry_run: argv.dryRun as boolean,
              new_items: newItems,
              count: newItems.length,
              last_run_at: feed.last_run_at,
              seen_count: feed.seen_ids.length,
              _meta: buildMeta(ctx),
            },
            argv.pretty as boolean,
          );
        },
      )
      .command(
        'delete <name>',
        'Delete a feed (requires --yes)',
        (y) =>
          y
            .positional('name', { type: 'string', demandOption: true })
            .option('yes', { type: 'boolean', default: false, describe: 'Confirm deletion' })
            .example('hn feed delete brand --yes', 'Delete without prompting'),
        async (argv) => {
          const name = argv.name as string;
          if (!argv.yes) throw new UsageError(`Refusing to delete feed "${name}" without --yes.`, `Run: hn feed delete ${name} --yes`);
          const p = feedPath(name);
          if (!existsSync(p)) throw new NotFoundError(`Feed not found: ${name}`, 'List feeds: hn feed list');
          unlinkSync(p);
          output({ deleted: true, feed: name }, argv.pretty as boolean);
        },
      )
      .demandCommand(1, 'Specify a subcommand: create, list, run, delete\n\n  Example: hn feed create brand --keywords "acme"'),
  );
}
