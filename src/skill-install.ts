import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.js';

export const SKILL_NAME = 'hn-hackernews-research';

export type Target = 'claude' | 'codex' | 'pi' | 'agents';
export const TARGETS: Target[] = ['claude', 'codex', 'pi', 'agents'];

export const TARGET_LABELS: Record<Target, string> = {
  claude: 'Claude Code (~/.claude/skills)',
  codex: 'Codex CLI ($CODEX_HOME/skills, default ~/.codex/skills)',
  pi: 'pi coding agent (~/.pi/agent/skills)',
  agents: 'Cross-harness Agent Skills dir (~/.agents/skills — read by Codex and pi)',
};

export function targetDir(target: Target): string {
  switch (target) {
    case 'claude':
      return join(homedir(), '.claude', 'skills');
    case 'codex':
      return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills');
    case 'pi':
      return join(homedir(), '.pi', 'agent', 'skills');
    case 'agents':
      return join(homedir(), '.agents', 'skills');
  }
}

/** Walk up from this file (dist/index.js or src/skill-install.ts) to the package root. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'skills', SKILL_NAME, 'SKILL.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError('Cannot locate the bundled skill directory.', 'Reinstall: `npm install -g github:nachoal/hn`, or run ./install_global.sh from a clone.');
}

export function skillSourceDir(): string {
  return join(packageRoot(), 'skills', SKILL_NAME);
}

const FLAG_LINE = /^disable-model-invocation:.*\r?\n/m;

export function stripSlashOnly(skillMd: string): string {
  return skillMd.replace(FLAG_LINE, '');
}

export function hasSlashOnlyFlag(skillMd: string): boolean {
  return /^disable-model-invocation:\s*true\s*$/m.test(skillMd);
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function present(p: string): boolean {
  return existsSync(p) || isSymlink(p);
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export interface InstallOptions {
  mode: 'symlink' | 'copy';
  /** Keep `disable-model-invocation: true` (slash-only) in the installed SKILL.md. Copies only. */
  slashOnly: boolean;
  force: boolean;
}

export interface InstallResult {
  target: Target;
  path: string;
  mode: 'symlink' | 'copy';
  changed: boolean;
  slash_only: boolean;
  invoke: string;
  note?: string;
}

function invokeHint(target: Target, slashOnly: boolean): string {
  switch (target) {
    case 'claude':
      return slashOnly ? `/${SKILL_NAME} (slash-only; auto-trigger is off)` : `/${SKILL_NAME} or automatically when the task mentions Hacker News`;
    case 'codex':
    case 'agents':
      return `$${SKILL_NAME} or automatically`;
    case 'pi':
      return slashOnly ? `/skill:${SKILL_NAME} (slash-only)` : `/skill:${SKILL_NAME} or automatically`;
  }
}

export function installSkill(target: Target, opts: InstallOptions): InstallResult {
  const src = skillSourceDir();
  const dest = join(targetDir(target), SKILL_NAME);
  const sourceMd = readFileSync(join(src, 'SKILL.md'), 'utf-8');

  if (present(dest)) {
    if (opts.mode === 'symlink' && isSymlink(dest) && sameRealPath(dest, src)) {
      const slashOnly = hasSlashOnlyFlag(sourceMd);
      return { target, path: dest, mode: 'symlink', changed: false, slash_only: slashOnly, invoke: invokeHint(target, slashOnly), note: 'already installed' };
    }
    if (!opts.force) {
      throw new ConfigError(`${dest} already exists.`, 'Re-run with --force to replace it, or remove it first.');
    }
    rmSync(dest, { recursive: true, force: true });
  }

  mkdirSync(dirname(dest), { recursive: true });

  if (opts.mode === 'symlink') {
    symlinkSync(src, dest, 'dir');
    const slashOnly = hasSlashOnlyFlag(sourceMd);
    return { target, path: dest, mode: 'symlink', changed: true, slash_only: slashOnly, invoke: invokeHint(target, slashOnly) };
  }

  cpSync(src, dest, { recursive: true });
  const md = join(dest, 'SKILL.md');
  const content = opts.slashOnly ? sourceMd : stripSlashOnly(sourceMd);
  writeFileSync(md, content);
  const slashOnly = hasSlashOnlyFlag(content);
  return { target, path: dest, mode: 'copy', changed: true, slash_only: slashOnly, invoke: invokeHint(target, slashOnly) };
}

export interface StatusResult {
  target: Target;
  path: string;
  installed: boolean;
  mode: 'symlink' | 'copy' | null;
  up_to_date: boolean | null;
  slash_only: boolean | null;
}

export function skillStatus(target: Target): StatusResult {
  const src = skillSourceDir();
  const dest = join(targetDir(target), SKILL_NAME);
  if (!present(dest)) return { target, path: dest, installed: false, mode: null, up_to_date: null, slash_only: null };
  if (isSymlink(dest)) {
    const ok = sameRealPath(dest, src);
    let slashOnly: boolean | null = null;
    try {
      slashOnly = hasSlashOnlyFlag(readFileSync(join(dest, 'SKILL.md'), 'utf-8'));
    } catch {
      slashOnly = null;
    }
    return { target, path: dest, installed: true, mode: 'symlink', up_to_date: ok, slash_only: slashOnly };
  }
  let installedMd = '';
  try {
    installedMd = readFileSync(join(dest, 'SKILL.md'), 'utf-8');
  } catch {
    return { target, path: dest, installed: true, mode: 'copy', up_to_date: false, slash_only: null };
  }
  const sourceMd = readFileSync(join(src, 'SKILL.md'), 'utf-8');
  return {
    target,
    path: dest,
    installed: true,
    mode: 'copy',
    up_to_date: stripSlashOnly(installedMd) === stripSlashOnly(sourceMd),
    slash_only: hasSlashOnlyFlag(installedMd),
  };
}
