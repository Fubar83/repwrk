import { UsageError } from '../errors.js';
import { CLONE_HINT, FOREACH_HINT } from './usage.js';

/**
 * Argument parsing for repwrk.
 *
 * repwrk options come first, the first non-option argument is the command, and
 * everything after the command belongs to the command. repwrk never interprets
 * or rewrites a command's arguments: `foreach pnpm audit --parallel` runs
 * `pnpm audit --parallel`, it does not run pnpm in parallel.
 *
 * Parsing touches nothing — no network, no filesystem, no child process — so a
 * command line that cannot be understood fails before anything happens.
 */

const FOREACH_OPTIONS = {
  '--at': { type: 'value', requires: 'a glob' },
  '--parallel': { type: 'boolean' },
  '--help': { type: 'boolean' },
};

const CLONE_OPTIONS = {
  '--owner': { type: 'value', requires: 'a value' },
  '--filter': { type: 'value', requires: 'a value' },
  '--branch': { type: 'value', requires: 'a value' },
  '--no-confirm': { type: 'boolean' },
  '--help': { type: 'boolean' },
};

const isOption = (token) => token.startsWith('-') && token !== '-';

const optionKey = (token) => (token.includes('=') ? token.slice(0, token.indexOf('=')) : token);

const inlineValue = (token) =>
  token.includes('=') ? token.slice(token.indexOf('=') + 1) : null;

/**
 * Read repwrk's own options up to the first non-option argument, which ends
 * option parsing whether or not a `--` separator was used.
 *
 * Returns `{ options, rest }`, where `rest` is everything from that argument
 * onwards, untouched.
 */
function parseOptions(argv, spec, hint) {
  const options = {};
  let index = 0;

  while (index < argv.length) {
    const token = argv[index];

    // An explicit end-of-options marker; never required.
    if (token === '--') return { options, rest: argv.slice(index + 1) };

    // The first non-option argument ends repwrk's options.
    if (!isOption(token)) return { options, rest: argv.slice(index) };

    const key = optionKey(token);
    const definition = spec[key];
    if (!definition) throw new UsageError(`unknown option '${key}'`, { hint });

    if (definition.type === 'boolean') {
      if (inlineValue(token) !== null) {
        throw new UsageError(`option '${key}' does not take a value`, { hint });
      }
      options[key] = true;
      index += 1;
      continue;
    }

    const attached = inlineValue(token);
    const value = attached ?? argv[index + 1];

    // An option cannot swallow the next option as its value, and an empty value
    // — usually an unset shell variable — must not read as "option not given":
    // `--filter ""` would otherwise widen the selection to every repository.
    if (value === undefined || value === '' || (attached === null && isOption(value))) {
      throw new UsageError(`${key} requires ${definition.requires}`, { hint });
    }

    options[key] = value;
    index += attached === null ? 2 : 1;
  }

  return { options, rest: [] };
}

function parseForeach(argv) {
  const { options, rest } = parseOptions(argv, FOREACH_OPTIONS, FOREACH_HINT);
  const [command = null, ...args] = rest;

  // --parallel is about running a command; with nothing to run it is a mistake,
  // whether or not --at was given.
  if (options['--parallel'] && command === null && !options['--help']) {
    throw new UsageError('--parallel requires a command', { hint: FOREACH_HINT });
  }

  return {
    name: 'foreach',
    help: Boolean(options['--help']),
    at: options['--at'] ?? null,
    parallel: Boolean(options['--parallel']),
    command,
    args,
  };
}

function parseClone(argv) {
  const { options, rest } = parseOptions(argv, CLONE_OPTIONS, CLONE_HINT);

  if (rest.length > 0) {
    throw new UsageError(`unexpected argument '${rest[0]}'`, { hint: CLONE_HINT });
  }

  return {
    name: 'clone',
    help: Boolean(options['--help']),
    owner: options['--owner'] ?? null,
    filter: options['--filter'] ?? null,
    branch: options['--branch'] ?? null,
    // Confirming is what clone does; the flag turns it off. Carried as the
    // positive so every use site reads as the thing it decides.
    confirm: !options['--no-confirm'],
  };
}

const COMMANDS = { clone: parseClone, foreach: parseForeach };

export function parse(argv) {
  const [name, ...rest] = argv;

  if (name === undefined || name === '--help' || name === '-h') return { name: 'help' };
  if (name === '--version' || name === '-V') return { name: 'version' };

  if (!Object.hasOwn(COMMANDS, name)) {
    throw new UsageError(
      isOption(name) ? `unknown option '${optionKey(name)}'` : `unknown command '${name}'`,
    );
  }

  return COMMANDS[name](rest);
}
