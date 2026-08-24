import type { Argv } from 'yargs';
import { UsageError } from '../errors.js';
import { output } from '../output.js';
import { SKILL_NAME, TARGETS, TARGET_LABELS, installSkill, skillSourceDir, skillStatus, type InstallResult, type Target } from '../skill-install.js';

export function registerSkillCommands(yargs: Argv) {
  return yargs.command('skill', `Install the bundled "${SKILL_NAME}" skill into Claude Code, Codex, or pi`, (y) =>
    y
      .command(
        'install',
        'Install the skill (symlink for Claude Code, adapted copies for Codex / pi)',
        (y) =>
          y
            .option('claude', { type: 'boolean', default: false, describe: TARGET_LABELS.claude })
            .option('codex', { type: 'boolean', default: false, describe: TARGET_LABELS.codex })
            .option('pi', { type: 'boolean', default: false, describe: TARGET_LABELS.pi })
            .option('agents', { type: 'boolean', default: false, describe: TARGET_LABELS.agents })
            .option('all', { type: 'boolean', default: false, describe: 'Claude Code + Codex + pi' })
            .option('copy', { type: 'boolean', default: false, describe: 'Claude Code: copy instead of symlinking' })
            .option('auto', {
              type: 'boolean',
              default: false,
              describe: 'Claude Code: let Claude trigger the skill automatically (copies without `disable-model-invocation`)',
            })
            .option('force', { type: 'boolean', default: false, describe: 'Replace an existing install' })
            .example('hn skill install --all', 'Claude Code (symlink, slash-only) + Codex + pi (copies, auto-trigger)')
            .example('hn skill install --claude --auto', 'Claude Code with automatic triggering')
            .example('hn skill install --codex --force', 'Refresh the Codex copy after an update'),
        async (argv) => {
          const targets: Target[] = [];
          if (argv.all) targets.push('claude', 'codex', 'pi');
          for (const t of TARGETS) if (argv[t] && !targets.includes(t)) targets.push(t);
          if (targets.length === 0) {
            throw new UsageError('No target selected.', 'Pass --claude, --codex, --pi, --agents, or --all. Example: hn skill install --all');
          }
          const results: InstallResult[] = [];
          for (const target of targets) {
            const claudeCopy = target === 'claude' && (argv.copy || argv.auto);
            const mode = target === 'claude' && !claudeCopy ? 'symlink' : 'copy';
            const slashOnly = target === 'claude' && !argv.auto;
            results.push(installSkill(target, { mode, slashOnly, force: argv.force as boolean }));
          }
          output({ skill: SKILL_NAME, source: skillSourceDir(), installed: results }, argv.pretty as boolean);
        },
      )
      .command(
        'status',
        'Where the skill is installed and whether the copies are current',
        (y) => y.example('hn skill status', 'Check all harnesses'),
        async (argv) => {
          output({ skill: SKILL_NAME, source: skillSourceDir(), targets: TARGETS.map(skillStatus) }, argv.pretty as boolean);
        },
      )
      .command(
        'path',
        'Print the bundled skill directory (for manual symlinks)',
        (y) => y.example('ln -s "$(hn skill path)" ~/.claude/skills/hn-hackernews-research', 'Manual install'),
        async () => {
          process.stdout.write(skillSourceDir() + '\n');
        },
      )
      .demandCommand(1, 'Specify a subcommand: install, status, path\n\n  Example: hn skill install --all'),
  );
}
