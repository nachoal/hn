import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '1.0.1';

export interface HnConfig {
  paceMs?: number;
  defaultLimit?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export interface Settings {
  paceMs: number;
  defaultLimit: number;
  timeoutMs: number;
  userAgent: string;
}

/** ~/.hn by default. HN_CONFIG_DIR overrides (used by tests and sandboxes). */
export function configDir(): string {
  return process.env.HN_CONFIG_DIR ?? join(homedir(), '.hn');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function feedsDir(): string {
  return join(configDir(), 'feeds');
}

export function loadConfig(): HnConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as HnConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: HnConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n');
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function resolveSettings(): Settings {
  const cfg = loadConfig();
  return {
    paceMs: envNumber('HN_PACE_MS') ?? cfg.paceMs ?? 250,
    defaultLimit: cfg.defaultLimit ?? 30,
    timeoutMs: envNumber('HN_TIMEOUT_MS') ?? cfg.timeoutMs ?? 20000,
    userAgent: cfg.userAgent ?? `hn-cli/${VERSION} (+https://github.com/nachoal/hn)`,
  };
}
