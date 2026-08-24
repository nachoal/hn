import type { Argv } from 'yargs';
import { VERSION, configDir } from '../config.js';
import { buildMeta, createContext } from '../context.js';
import { output } from '../output.js';

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; ms: number; value: T } | { ok: false; ms: number; error: string }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
  }
}

export function registerStatusCommands(yargs: Argv) {
  return yargs.command(
    'status',
    'Check both upstream APIs: reachability, latency, current max item id',
    (y) => y.example('hn status', 'Exit code 1 if either API is unreachable'),
    async (argv) => {
      const ctx = createContext();
      const [firebase, algolia] = await Promise.all([
        timed(() => ctx.firebase.maxitem()),
        timed(() => ctx.algolia.search({ tags: 'story', hitsPerPage: 1 })),
      ]);
      const ok = firebase.ok && algolia.ok;
      output(
        {
          ok,
          version: VERSION,
          firebase: firebase.ok ? { ok: true, latency_ms: firebase.ms, maxitem: firebase.value } : { ok: false, latency_ms: firebase.ms, error: firebase.error },
          algolia: algolia.ok ? { ok: true, latency_ms: algolia.ms, indexed_stories: algolia.value.nbHits } : { ok: false, latency_ms: algolia.ms, error: algolia.error },
          config_dir: configDir(),
          _meta: buildMeta(ctx),
        },
        argv.pretty as boolean,
      );
      if (!ok) process.exitCode = 1;
    },
  );
}
