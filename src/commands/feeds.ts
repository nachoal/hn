import type { Argv } from 'yargs';
import type { FeedKind } from '../clients/firebase.js';
import { buildMeta, createContext } from '../context.js';
import { hydrateIds } from '../hydrate.js';
import { output } from '../output.js';
import { clamp } from '../query.js';

interface FeedSpec {
  kind: FeedKind;
  describe: string;
  max: number;
  hasJobs: boolean;
  /** Jobs are never in the Algolia index — go straight to Firebase. */
  liveOnly?: boolean;
}

const FEEDS: FeedSpec[] = [
  { kind: 'top', describe: 'Front page — top stories in HN rank order (rank 1-30 is the front page)', max: 500, hasJobs: true },
  { kind: 'new', describe: 'Newest submissions', max: 500, hasJobs: true },
  { kind: 'best', describe: 'Best recent stories by votes', max: 500, hasJobs: false },
  { kind: 'ask', describe: 'Ask HN, ranked', max: 200, hasJobs: false },
  { kind: 'show', describe: 'Show HN, ranked', max: 200, hasJobs: false },
  { kind: 'jobs', describe: 'Job postings (YC companies)', max: 200, hasJobs: false, liveOnly: true },
];

const HYDRATE_NOTE = 'points/num_comments come from the Algolia index (lags live values by a minute or so); add --live for real-time numbers.';

export function registerRankedFeedCommands(yargs: Argv) {
  for (const feed of FEEDS) {
    yargs = yargs.command(
      feed.kind,
      feed.describe,
      (y) => {
        let b = y
          .option('limit', { type: 'number', default: 30, describe: `Items per page (max ${feed.max})` })
          .option('page', { type: 'number', default: 1, describe: 'Page number, 1-based' })
          .option('live', {
            type: 'boolean',
            default: false,
            describe: 'Hydrate every item from Firebase (real-time scores; one request per item instead of one per page)',
          });
        if (feed.hasJobs) {
          b = b.option('jobs', { type: 'boolean', default: true, describe: 'Include job postings (use --no-jobs to drop them)' });
        }
        return b
          .example(`hn ${feed.kind}`, `First ${feed.kind} page, 30 items, 1-2 requests`)
          .example(`hn ${feed.kind} --limit 50 --page 2`, 'Items 51-100')
          .example(`hn ${feed.kind} --live | jq '.items[] | {rank, title, points}'`, 'Real-time numbers, trimmed with jq');
      },
      async (argv) => {
        const ctx = createContext();
        const limit = clamp(argv.limit as number, 1, feed.max, 30);
        const page = clamp(argv.page as number, 1, 1000, 1);
        const ids = await ctx.firebase.list(feed.kind);
        const start = (page - 1) * limit;
        const slice = ids.slice(start, start + limit);
        const live = (argv.live as boolean) || feed.liveOnly === true;
        let items = await hydrateIds(ctx, slice, { live, rankOffset: start });
        if (feed.hasJobs && argv.jobs === false) items = items.filter((i) => i.type !== 'job');
        output(
          {
            feed: feed.kind,
            items,
            count: items.length,
            page,
            total_available: ids.length,
            _meta: buildMeta(ctx, live ? undefined : HYDRATE_NOTE),
          },
          argv.pretty as boolean,
        );
      },
    );
  }
  return yargs;
}
