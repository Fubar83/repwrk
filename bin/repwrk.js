#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parse } from '../src/cli/parse.js';
import { CLONE_USAGE, FOREACH_USAGE, USAGE } from '../src/cli/usage.js';
import { clone } from '../src/commands/clone.js';
import { foreach } from '../src/commands/foreach.js';
import { EXIT, reportError } from '../src/errors.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

async function run(argv) {
  // Parsing happens first and on its own: nothing is discovered and no child
  // process is started until the command line is known to be sound.
  const command = parse(argv);

  switch (command.name) {
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return EXIT.SUCCESS;

    case 'version':
      process.stdout.write(`${version}\n`);
      return EXIT.SUCCESS;

    case 'foreach':
      if (command.help) {
        process.stdout.write(`${FOREACH_USAGE}\n`);
        return EXIT.SUCCESS;
      }
      return foreach(command);

    case 'clone':
      if (command.help) {
        process.stdout.write(`${CLONE_USAGE}\n`);
        return EXIT.SUCCESS;
      }
      return clone(command);

    default:
      process.stdout.write(`${USAGE}\n`);
      return EXIT.SUCCESS;
  }
}

// Piping into `head` and friends closes stdout early; that is not an error.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(EXIT.SUCCESS);
  throw error;
});

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.exitCode = reportError(error);
}
