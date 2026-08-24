import type { Argv } from 'yargs';
import type { AlgoliaNode } from '../clients/algolia.js';
import { buildMeta, createContext } from '../context.js';
import { NotFoundError } from '../errors.js';
import {
  commentFromHit,
  domainOf,
  flattenComments,
  hnUrl,
  parseItemRef,
  reorderByKids,
  sortTree,
  treeFromAlgolia,
  truncateLevelOrder,
} from '../normalize.js';
import { output } from '../output.js';
import { clamp } from '../query.js';
import { htmlToText } from '../text.js';
import type { HnItem, ItemType } from '../types.js';

function storyFromNode(node: AlgoliaNode): HnItem {
  const title = node.title ?? '';
  let type: ItemType = 'story';
  if (node.type === 'poll') type = 'poll';
  else if (node.type === 'job') type = 'job';
  else if (/^Ask HN\b/i.test(title)) type = 'ask';
  else if (/^Show HN\b/i.test(title)) type = 'show';
  return {
    id: node.id,
    type,
    title: node.title ?? null,
    url: node.url ?? null,
    domain: domainOf(node.url),
    author: node.author ?? null,
    points: node.points ?? null,
    num_comments: null,
    created_at: node.created_at ?? null,
    text: htmlToText(node.text),
    hn_url: hnUrl(node.id),
  };
}

export function registerThreadCommands(yargs: Argv) {
  return yargs.command('thread', 'Story + full comment tree, or search inside one thread', (y) =>
    y
      .command(
        'get <id>',
        'Fetch a story (or a comment subtree) with nested comments — one Algolia request',
        (y) =>
          y
            .positional('id', { type: 'string', demandOption: true, describe: 'Item id or news.ycombinator.com URL' })
            .option('max-comments', { type: 'number', default: 200, describe: 'Cap on comments returned, level-order (top-level first); 0 = all' })
            .option('depth', { type: 'number', default: 0, describe: 'Max nesting depth; 0 = unlimited' })
            .option('sort', {
              type: 'string',
              choices: ['top', 'new', 'old'] as const,
              default: 'top' as const,
              describe: "top = HN's own ranking for top-level comments (one extra Firebase call); new/old = by time at every level",
            })
            .option('flat', { type: 'boolean', default: false, describe: 'Flat list with depth instead of nested replies' })
            .example('hn thread get 8863', 'Story + top 200 comments in HN order')
            .example('hn thread get https://news.ycombinator.com/item?id=8863 --max-comments 50 --flat', 'Compact, summarizer-friendly')
            .example("hn thread get 8863 --depth 1 | jq -r '.comments[] | \"\\(.author): \\(.text[0:200])\"'", 'Top-level comments only'),
        async (argv) => {
          const ctx = createContext();
          const id = parseItemRef(argv.id as string);
          const wantLive = argv.sort === 'top';
          const [node, live] = await Promise.all([ctx.algolia.item(id), wantLive ? ctx.firebase.item(id) : Promise.resolve(null)]);
          if (!node) {
            throw new NotFoundError(
              `Item ${id} is not in the HN search index`,
              'Deleted/dead items and items younger than ~1 minute are not indexed. `hn item get <id>` reads the live record.',
            );
          }
          const maxDepth = clamp(argv.depth as number, 0, 100, 0);
          let tree = treeFromAlgolia(node.children ?? [], 0, maxDepth);
          if (argv.sort === 'top') tree = reorderByKids(tree, live?.kids);
          else tree = sortTree(tree, argv.sort as 'new' | 'old');
          const { comments, truncated, returned, total } = truncateLevelOrder(tree, clamp(argv.maxComments as number, 0, 100000, 200));
          const finalComments = argv.flat ? flattenComments(comments) : comments;

          const payload: Record<string, unknown> = {};
          if (node.type === 'comment') {
            const root = commentFromHit({
              objectID: String(node.id),
              author: node.author,
              comment_text: node.text,
              created_at: node.created_at,
              created_at_i: node.created_at_i,
              parent_id: node.parent_id,
              story_id: node.story_id,
            });
            root.reply_count = (node.children ?? []).length;
            payload.comment = root;
          } else {
            const story = storyFromNode(node);
            if (live) {
              if (live.score !== undefined) story.points = live.score;
              if (live.descendants !== undefined) story.num_comments = live.descendants;
              if (live.dead) story.dead = true;
              if (live.deleted) story.deleted = true;
            }
            if (story.num_comments === null) story.num_comments = total;
            payload.story = story;
          }
          payload.comments = finalComments;
          payload.comment_count = total;
          payload.returned_count = returned;
          payload.truncated = truncated;
          payload._meta = buildMeta(ctx, truncated ? `Showing ${returned} of ${total} comments; raise --max-comments (0 = all).` : undefined);
          output(payload, argv.pretty as boolean);
        },
      )
      .command(
        'search <id>',
        'Search the comments of one story',
        (y) =>
          y
            .positional('id', { type: 'string', demandOption: true, describe: 'Story id or URL' })
            .option('q', { type: 'string', alias: 'query', demandOption: true, describe: 'Search text' })
            .option('sort', { type: 'string', choices: ['relevance', 'date'] as const, default: 'relevance' as const })
            .option('limit', { type: 'number', default: 50, describe: 'Hits per page (max 1000)' })
            .option('page', { type: 'number', default: 1, describe: 'Page number, 1-based' })
            .example('hn thread search 49156683 -q "remote"', 'Comments mentioning a word inside one thread'),
        async (argv) => {
          const ctx = createContext();
          const id = parseItemRef(argv.id as string);
          const limit = clamp(argv.limit as number, 1, 1000, 50);
          const page = clamp(argv.page as number, 1, 100000, 1);
          const res = await ctx.algolia.search({
            query: argv.q as string,
            tags: `comment,story_${id}`,
            sort: argv.sort as 'relevance' | 'date',
            hitsPerPage: limit,
            page: page - 1,
          });
          const items = res.hits.map(commentFromHit);
          output(
            { story_id: id, query: argv.q, items, count: items.length, page, nb_hits: res.nbHits, nb_pages: res.nbPages, _meta: buildMeta(ctx) },
            argv.pretty as boolean,
          );
        },
      )
      .demandCommand(1, 'Specify a subcommand: get, search\n\n  Example: hn thread get 8863'),
  );
}
