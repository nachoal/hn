import type { Argv } from 'yargs';
import { buildMeta, createContext } from '../context.js';
import { NotFoundError } from '../errors.js';
import { fromAlgoliaHit, matchKeywords, splitList, treeFromAlgolia } from '../normalize.js';
import { output } from '../output.js';
import { clamp } from '../query.js';

const KINDS = {
  hiring: /who is hiring/i,
  'wants-to-be-hired': /who wants to be hired/i,
  freelancer: /freelancer/i,
} as const;

type Kind = keyof typeof KINDS;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "Ask HN: Who is hiring? (August 2026)" → "2026-08" */
export function monthFromTitle(title: string | null | undefined): string | null {
  const m = /\(([A-Za-z]+)\s+(\d{4})\)/.exec(title ?? '');
  if (!m) return null;
  const idx = MONTHS.indexOf(m[1]!.toLowerCase());
  if (idx < 0) return null;
  return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
}

export function registerHiringCommands(yargs: Argv) {
  return yargs.command(
    'hiring',
    'Read the monthly "Who is hiring?" threads (jobs, job seekers, freelancers)',
    (y) =>
      y
        .option('kind', { type: 'string', choices: Object.keys(KINDS) as Kind[], default: 'hiring' as Kind, describe: 'Which monthly thread' })
        .option('month', { type: 'string', describe: 'YYYY-MM; default = latest thread' })
        .option('keywords', { type: 'string', describe: 'Comma-separated, case-insensitive filter over each post' })
        .option('match', { type: 'string', choices: ['any', 'all'] as const, default: 'any' as const, describe: 'A post must contain any / all keywords' })
        .option('limit', { type: 'number', default: 100, describe: 'Max posts returned; 0 = all' })
        .option('list', { type: 'boolean', default: false, describe: 'List available threads instead of reading one' })
        .example('hn hiring --keywords "remote,typescript"', 'Remote TypeScript jobs in the latest thread')
        .example('hn hiring --kind wants-to-be-hired --keywords "rails,senior" --match all', 'Candidates matching all keywords')
        .example('hn hiring --month 2026-07 --keywords "ai" --limit 0', 'Every AI post from July 2026')
        .example('hn hiring --list', 'Which months are available'),
    async (argv) => {
      const ctx = createContext();
      const kind = argv.kind as Kind;
      const res = await ctx.algolia.search({ tags: 'story,author_whoishiring', sort: 'date', hitsPerPage: 120 });
      const threads = res.hits
        .filter((h) => KINDS[kind].test(h.title ?? ''))
        .map((h) => ({ ...fromAlgoliaHit(h), month: monthFromTitle(h.title) }));

      if (argv.list) {
        output({ kind, threads, count: threads.length, _meta: buildMeta(ctx) }, argv.pretty as boolean);
        return;
      }

      const month = argv.month as string | undefined;
      const thread = month ? threads.find((t) => t.month === month) : threads[0];
      if (!thread) {
        throw new NotFoundError(`No "${kind}" thread found${month ? ` for ${month}` : ''}`, 'Run `hn hiring --list` to see the available months.');
      }

      const node = await ctx.algolia.item(thread.id);
      const topLevel = treeFromAlgolia(node?.children ?? [], 0, 1);
      const keywords = splitList(argv.keywords as string | undefined);
      let posts = topLevel.filter((c) => c.text && c.text.trim().length > 0);
      if (keywords.length > 0) {
        posts = posts.filter((c) => {
          const hits = matchKeywords(c.text!, keywords);
          return argv.match === 'all' ? hits.length === keywords.length : hits.length > 0;
        });
      }
      const matched = posts.length;
      const limit = clamp(argv.limit as number, 0, 100000, 100);
      if (limit > 0) posts = posts.slice(0, limit);
      const items = posts.map((c) => ({
        ...c,
        replies: [],
        matched_keywords: keywords.length > 0 ? matchKeywords(c.text!, keywords) : undefined,
      }));

      output(
        {
          kind,
          thread: {
            id: thread.id,
            title: thread.title,
            month: thread.month,
            created_at: thread.created_at,
            hn_url: thread.hn_url,
            top_level_posts: topLevel.length,
          },
          keywords,
          match: argv.match,
          matched_count: matched,
          count: items.length,
          items,
          _meta: buildMeta(ctx),
        },
        argv.pretty as boolean,
      );
    },
  );
}
