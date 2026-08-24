import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { registerConfigCommands } from './commands/config.js';
import { registerDigestCommands } from './commands/digest.js';
import { registerFeedCommands } from './commands/feed.js';
import { registerRankedFeedCommands } from './commands/feeds.js';
import { registerHiringCommands } from './commands/hiring.js';
import { registerItemCommands } from './commands/item.js';
import { registerLaunchCommands } from './commands/launches.js';
import { registerSearchCommands } from './commands/search.js';
import { registerSkillCommands } from './commands/skill.js';
import { registerStatusCommands } from './commands/status.js';
import { registerThreadCommands } from './commands/thread.js';
import { registerUserCommands } from './commands/user.js';
import { VERSION } from './config.js';

export function buildCli(argv: string[]) {
  let cli: Argv = yargs(hideBin(argv))
    .scriptName('hn')
    .usage('$0 <command> [flags]\n\nAgent-first Hacker News CLI. JSON on stdout, errors on stderr, no auth.')
    .option('pretty', { type: 'boolean', default: false, describe: 'Pretty-print JSON output', global: true })
    .strict()
    .demandCommand(1, 'Specify a command. Run hn --help to see available commands.')
    .recommendCommands()
    .version(VERSION)
    .help()
    .wrap(Math.min(100, yargs().terminalWidth()))
    .fail((msg, err, instance) => {
      if (err) throw err;
      if (/Specify a command/.test(msg)) instance.showHelp((s: string) => process.stderr.write(s + '\n\n'));
      process.stderr.write(JSON.stringify({ error: 'UsageError', message: msg, hint: 'Run `hn --help` or `hn <command> --help` for flags and examples.' }) + '\n');
      process.exit(1);
    });

  cli = registerRankedFeedCommands(cli);
  cli = registerSearchCommands(cli);
  cli = registerThreadCommands(cli);
  cli = registerItemCommands(cli);
  cli = registerUserCommands(cli);
  cli = registerHiringCommands(cli);
  cli = registerLaunchCommands(cli);
  cli = registerDigestCommands(cli);
  cli = registerFeedCommands(cli);
  cli = registerStatusCommands(cli);
  cli = registerConfigCommands(cli);
  cli = registerSkillCommands(cli);

  return cli;
}
