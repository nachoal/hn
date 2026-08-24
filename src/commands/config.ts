import type { Argv } from 'yargs';
import { configPath, loadConfig, resolveSettings, saveConfig } from '../config.js';
import { output } from '../output.js';

export function registerConfigCommands(yargs: Argv) {
  return yargs.command('config', 'Local settings (~/.hn/config.json)', (y) =>
    y
      .command(
        'set',
        'Save settings',
        (y) =>
          y
            .option('pace-ms', { type: 'number', describe: 'Delay between requests inside loops (digest, feed run, --all). Default 250' })
            .option('default-limit', { type: 'number', describe: 'Reserved for future defaults' })
            .option('timeout-ms', { type: 'number', describe: 'Per-request timeout. Default 20000' })
            .option('user-agent', { type: 'string', describe: 'User-Agent header override' })
            .example('hn config set --pace-ms 500', 'Slow down batch loops')
            .example('hn config set --timeout-ms 40000', 'Slow network'),
        async (argv) => {
          const next = {
            ...loadConfig(),
            ...(argv.paceMs !== undefined && { paceMs: argv.paceMs as number }),
            ...(argv.defaultLimit !== undefined && { defaultLimit: argv.defaultLimit as number }),
            ...(argv.timeoutMs !== undefined && { timeoutMs: argv.timeoutMs as number }),
            ...(argv.userAgent !== undefined && { userAgent: argv.userAgent as string }),
          };
          saveConfig(next);
          output({ saved: true, path: configPath(), config: next }, argv.pretty as boolean);
        },
      )
      .command(
        'show',
        'Display the saved config and the effective settings',
        (y) => y.example('hn config show', 'Effective settings incl. env overrides (HN_CONFIG_DIR, HN_PACE_MS, HN_TIMEOUT_MS)'),
        async (argv) => {
          output({ path: configPath(), config: loadConfig(), effective: resolveSettings() }, argv.pretty as boolean);
        },
      )
      .demandCommand(1, 'Specify a subcommand: set, show\n\n  Example: hn config show'),
  );
}
