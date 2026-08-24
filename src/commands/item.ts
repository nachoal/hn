import type { Argv } from 'yargs';
import { buildMeta, createContext } from '../context.js';
import { NotFoundError } from '../errors.js';
import { fromFirebaseItem, parseItemRef } from '../normalize.js';
import { output } from '../output.js';

export function registerItemCommands(yargs: Argv) {
  return yargs.command('item', 'One item straight from the official API (live, any type)', (y) =>
    y
      .command(
        'get <id>',
        'Live record for a story, comment, job, or poll — real-time score, kids, parent',
        (y) =>
          y
            .positional('id', { type: 'string', demandOption: true, describe: 'Item id or news.ycombinator.com URL' })
            .option('raw', { type: 'boolean', default: false, describe: 'Also include the untouched Firebase JSON' })
            .example('hn item get 8863', 'Live story record')
            .example('hn item get 9224 --raw', 'A comment, with the raw payload'),
        async (argv) => {
          const ctx = createContext();
          const id = parseItemRef(argv.id as string);
          const raw = await ctx.firebase.item(id);
          if (!raw) {
            throw new NotFoundError(`Item ${id} does not exist`, 'Firebase returned null — the id is above maxitem or was never created. `hn status` shows the current maxitem.');
          }
          const item = {
            ...fromFirebaseItem(raw),
            kids: raw.kids ?? [],
            parent: raw.parent ?? null,
            poll: raw.poll ?? null,
            parts: raw.parts ?? [],
          };
          output({ item, raw: argv.raw ? raw : undefined, _meta: buildMeta(ctx) }, argv.pretty as boolean);
        },
      )
      .demandCommand(1, 'Specify a subcommand: get\n\n  Example: hn item get 8863'),
  );
}
