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
  '--at': { type: 'value', requires: 'a glob', short: '-a' },
  '--parallel': { type: 'boolean', short: '-p' },
  '--help': { type: 'boolean', short: '-h' },
};

const CLONE_OPTIONS = {
  '--owner': { type: 'value', requires: 'a value', short: '-o' },
  '--team': { type: 'value', requires: 'a value', short: '-t' },
  // Repeatable, and OR-ed: each one widens the selection.
  '--filter': { type: 'value', requires: 'a value', repeatable: true, short: '-f' },
  '--language': { type: 'value', requires: 'a value', repeatable: true, short: '-l' },
  '--branch': { type: 'value', requires: 'a value', short: '-b' },
  // Deliberately without a short spelling. `-y` is the one anybody would
  // reach for, and "yes" is exactly the word this flag was renamed away from:
  // it does not say what is being agreed to once the prompt asks more than
  // one thing. Turning off a confirmation is worth the extra keystrokes.
  '--no-confirm': { type: 'boolean' },
  '--help': { type: 'boolean', short: '-h' },
};

/**
 * Short spellings, as a map from the short form to the long one it stands for.
 *
 * Only the long name is ever stored, so nothing downstream has to know that a
 * short form exists — and an option can gain or lose one without touching
 * anything but the table above.
 */
function shortFormsOf(spec) {
  const shorts = {};
  for (const [name, definition] of Object.entries(spec)) {
    if (definition.short) shorts[definition.short] = name;
  }
  return shorts;
}

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
  const shorts = shortFormsOf(spec);
  let index = 0;

  while (index < argv.length) {
    const token = argv[index];

    // An explicit end-of-options marker; never required.
    if (token === '--') return { options, rest: argv.slice(index + 1) };

    // The first non-option argument ends repwrk's options.
    if (!isOption(token)) return { options, rest: argv.slice(index) };

    // What was typed is what any complaint names, so the error points at the
    // command line the reader is looking at rather than its longer synonym.
    const typed = optionKey(token);
    const key = shorts[typed] ?? typed;
    const definition = spec[key];
    if (!definition) throw new UsageError(`unknown option '${typed}'`, { hint });

    if (definition.type === 'boolean') {
      if (inlineValue(token) !== null) {
        throw new UsageError(`option '${typed}' does not take a value`, { hint });
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
      throw new UsageError(`${typed} requires ${definition.requires}`, { hint });
    }

    // A repeatable option collects; a plain one keeps the last value given,
    // which is what a shell alias overriding its own default relies on.
    if (definition.repeatable) (options[key] ??= []).push(value);
    else options[key] = value;
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

  // A team lives inside an organisation and cannot be resolved without one.
  // Caught here so it costs nothing, rather than after a listing has started.
  if (options['--team'] && !options['--owner'] && !options['--help']) {
    throw new UsageError('--team requires --owner', { hint: CLONE_HINT });
  }

  return {
    name: 'clone',
    help: Boolean(options['--help']),
    owner: options['--owner'] ?? null,
    team: options['--team'] ?? null,
    // Always a list, empty when unused, so no caller has to tell one filter
    // apart from several — or from none.
    filter: options['--filter'] ?? [],
    language: options['--language'] ?? [],
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
