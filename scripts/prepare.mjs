// npm "prepare" hook.
//
// From a clone (`npm install` / `./install_global.sh`) the dev toolchain is present, so rebuild
// dist/index.js from source. When npm installs straight from git (`npm install -g github:nachoal/hn`)
// it does NOT install devDependencies, so tsup is missing — in that case the committed dist/ is used.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let hasTsup = true;
try {
  require.resolve('tsup/package.json');
} catch {
  hasTsup = false;
}

if (!hasTsup) {
  if (!existsSync(new URL('../dist/index.js', import.meta.url))) {
    console.error('hn: dist/index.js is missing and tsup is not installed — run `npm install && npm run build` from a clone.');
    process.exit(1);
  }
  process.exit(0);
}

const result = spawnSync('tsup', [], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
