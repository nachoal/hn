import type { Argv } from 'yargs';
import { buildMeta, createContext } from '../context.js';
import { NotFoundError } from '../errors.js';
import { commentFromHit, fromAlgoliaHit } from '../normalize.js';
import { output } from '../output.js';
import { clamp, joinTags, thresholdFilters, timeFilters, typeTags } from '../query.js';
import { htmlToText } from '../text.js';
import type { SearchType } from '../types.js';

const POST_TYPES = ['story', 'ask', 'show', 'poll', 'job', 'all'] as const;

export function registerUserCommands(yargs: Argv) {
  return yargs.command('user', 'HN users: profile, submissions, comments', (y) =>
    y
      .command(
        'get <username>',
        'Profile: karma, about, account age, submission count (official API)',
        (y) =>
          y
            .positional('username', { type: 'string', demandOption: true, describe: 'HN username (case-sensitive)' })
            .example('hn user get pg', 'Profile for a user'),
        async (argv) => {
          const ctx = createContext();
          const name = (argv.username as string).trim();
          const u = await ctx.firebase.user(name);
          if (!u) throw new NotFoundError(`No HN user "${name}"`, 'Usernames are case-sensitive.');
          const submitted = u.submitted ?? [];
          output(
            {
              user: {
                id: u.id,
                karma: u.karma,
                created_at: new Date(u.created * 1000).toISOString(),
                about: htmlToText(u.about ?? null),
                submitted_count: submitted.length,
                latest_submitted_ids: submitted.slice(0, 10),
                hn_url: `https://news.ycombinator.com/user?id=${encodeURIComponent(u.id)}`,
              },
              _meta: buildMeta(ctx),
            },
            argv.pretty as boolean,
          );
        },
      )
      .command(
        'posts <username>',
        'Stories / Ask / Show / polls submitted by a user',
        (y) =>
          y
            .positional('username', { type: 'string', demandOption: true })
            .option('type', { type: 'string', choices: POST_TYPES, default: 'story' as const, describe: 'Item type' })
            .option('since', { type: 'string', describe: 'Relative window: 7d, 30d, 1y' })
            .option('after', { type: 'string', describe: 'Created on/after YYYY-MM-DD (UTC)' })
            .option('before', { type: 'string', describe: 'Created before YYYY-MM-DD (UTC)' })
            .option('min-points', { type: 'number', describe: 'Minimum points' })
            .option('sort', { type: 'string', choices: ['date', 'points'] as const, default: 'date' as const, describe: 'date = newest first; points = most upvoted first' })
            .option('limit', { type: 'number', default: 30, describe: 'Hits per page (max 1000)' })
            .option('page', { type: 'number', default: 1, describe: 'Page number, 1-based' })
            .example('hn user posts pg --limit 50', 'Latest 50 submissions')
            .example('hn user posts dang --sort points --since 1y', 'Top submissions of the last year'),
        async (argv) => {
          const ctx = createContext();
          const name = (argv.username as string).trim();
          const tags = [...typeTags(argv.type as SearchType), `author_${name}`];
          const time = timeFilters({ since: argv.since as string | undefined, after: argv.after as string | undefined, before: argv.before as string | undefined });
          const limit = clamp(argv.limit as number, 1, 1000, 30);
          const page = clamp(argv.page as number, 1, 100000, 1);
          const res = await ctx.algolia.search({
            tags: joinTags(tags),
            numericFilters: [...time.filters, ...thresholdFilters(argv.minPoints as number | undefined)],
            sort: argv.sort === 'points' ? 'relevance' : 'date',
            hitsPerPage: limit,
            page: page - 1,
          });
          const items = res.hits.map(fromAlgoliaHit);
          output({ username: name, items, count: items.length, page, nb_hits: res.nbHits, nb_pages: res.nbPages, _meta: buildMeta(ctx) }, argv.pretty as boolean);
        },
      )
      .command(
        'comments <username>',
        'Comments by a user, newest first',
        (y) =>
          y
            .positional('username', { type: 'string', demandOption: true })
            .option('q', { type: 'string', alias: 'query', describe: 'Optional text filter' })
            .option('since', { type: 'string', describe: 'Relative window: 7d, 30d, 1y' })
            .option('after', { type: 'string', describe: 'Created on/after YYYY-MM-DD (UTC)' })
            .option('before', { type: 'string', describe: 'Created before YYYY-MM-DD (UTC)' })
            .option('limit', { type: 'number', default: 50, describe: 'Hits per page (max 1000)' })
            .option('page', { type: 'number', default: 1, describe: 'Page number, 1-based' })
            .example('hn user comments dang --limit 100', 'Latest 100 comments')
            .example('hn user comments pg -q "startup" --since 1y', 'Comments mentioning a word'),
        async (argv) => {
          const ctx = createContext();
          const name = (argv.username as string).trim();
          const time = timeFilters({ since: argv.since as string | undefined, after: argv.after as string | undefined, before: argv.before as string | undefined });
          const limit = clamp(argv.limit as number, 1, 1000, 50);
          const page = clamp(argv.page as number, 1, 100000, 1);
          const res = await ctx.algolia.search({
            query: argv.q as string | undefined,
            tags: `comment,author_${name}`,
            numericFilters: time.filters,
            sort: 'date',
            hitsPerPage: limit,
            page: page - 1,
          });
          const items = res.hits.map(commentFromHit);
          output({ username: name, items, count: items.length, page, nb_hits: res.nbHits, nb_pages: res.nbPages, _meta: buildMeta(ctx) }, argv.pretty as boolean);
        },
      )
      .demandCommand(1, 'Specify a subcommand: get, posts, comments\n\n  Example: hn user get pg'),
  );
}
