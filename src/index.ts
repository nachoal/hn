import { buildCli } from './cli.js';
import { outputError } from './output.js';

async function main() {
  try {
    await buildCli(process.argv).parseAsync();
  } catch (err) {
    outputError(err, process.argv.includes('--pretty'));
    process.exit(1);
  }
}

main();
