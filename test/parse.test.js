import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from '../src/cli/parse.js';
import { EXIT, UsageError } from '../src/errors.js';

/** Assert that parsing fails with exactly this message and a usage exit code. */
function refuses(argv, message) {
  assert.throws(
    () => parse(argv),
    (error) => {
      assert.ok(error instanceof UsageError, `expected a UsageError, got ${error.name}`);
      assert.equal(error.message, message);
      assert.equal(error.exitCode, EXIT.USAGE);
      return true;
    },
    `expected \`repwrk ${argv.join(' ')}\` to be refused`,
  );
}

// The six valid shapes of foreach

test('foreach alone lists repositories', () => {
  assert.deepEqual(parse(['foreach']), {
    name: 'foreach',
    help: false,
    at: null,
    parallel: false,
    command: null,
    args: [],
  });
});

test('foreach --at lists targets', () => {
  const result = parse(['foreach', '--at', '**/*lambda/package.json']);
  assert.equal(result.at, '**/*lambda/package.json');
  assert.equal(result.command, null);
});

test('foreach <command> executes at repository roots', () => {
  const result = parse(['foreach', 'dotnet', 'test']);
  assert.equal(result.command, 'dotnet');
  assert.deepEqual(result.args, ['test']);
  assert.equal(result.at, null);
});

test('foreach --at <glob> <command> executes at targets', () => {
  const result = parse(['foreach', '--at', '**/*lambda/package.json', 'pnpm', 'audit']);
  assert.equal(result.at, '**/*lambda/package.json');
  assert.equal(result.command, 'pnpm');
  assert.deepEqual(result.args, ['audit']);
});

test('foreach --parallel <command> executes concurrently', () => {
  const result = parse(['foreach', '--parallel', 'dotnet', 'test']);
  assert.equal(result.parallel, true);
  assert.equal(result.command, 'dotnet');
});

test('foreach --parallel --at <glob> <command> is valid', () => {
  const result = parse(['foreach', '--parallel', '--at', '**/*lambda', 'pnpm', 'test']);
  assert.equal(result.parallel, true);
  assert.equal(result.at, '**/*lambda');
  assert.equal(result.command, 'pnpm');
  assert.deepEqual(result.args, ['test']);
});

// The command and its arguments

test('the first non-option argument is the command', () => {
  const result = parse(['foreach', 'git', 'status', '--short']);
  assert.equal(result.command, 'git');
  assert.deepEqual(result.args, ['status', '--short']);
});

test('options after the command belong to the command', () => {
  const result = parse(['foreach', 'pnpm', 'audit', '--parallel']);
  assert.equal(result.command, 'pnpm');
  assert.deepEqual(result.args, ['audit', '--parallel']);
  assert.equal(result.parallel, false, '--parallel after the command is pnpm’s');
});

test('command arguments are passed through untouched', () => {
  assert.deepEqual(parse(['foreach', 'git', 'log', '--author=John Doe']).args, [
    'log',
    '--author=John Doe',
  ]);
  assert.deepEqual(parse(['foreach', 'pnpm', 'run', 'test', '--', '--watch']).args, [
    'run',
    'test',
    '--',
    '--watch',
  ]);
});

test('repwrk options may come in any order before the command', () => {
  assert.deepEqual(
    parse(['foreach', '--parallel', '--at', '**/*lambda', 'pnpm', 'test']),
    parse(['foreach', '--at', '**/*lambda', '--parallel', 'pnpm', 'test']),
  );
});

test('-- ends repwrk options but is not required', () => {
  assert.deepEqual(
    parse(['foreach', '--parallel', '--', 'pnpm', 'test']),
    parse(['foreach', '--parallel', 'pnpm', 'test']),
  );
});

test('after --, an option-looking argument is the command', () => {
  const result = parse(['foreach', '--', '--weird-command', '--flag']);
  assert.equal(result.command, '--weird-command');
  assert.deepEqual(result.args, ['--flag']);
});

test('whether the command exists is not a parsing question', () => {
  assert.equal(parse(['foreach', 'made-up-command']).command, 'made-up-command');
});

// Invalid combinations

test('--parallel without a command is refused', () => {
  refuses(['foreach', '--parallel'], '--parallel requires a command');
});

test('--parallel with --at but no command is still refused', () => {
  refuses(['foreach', '--parallel', '--at', '**/*lambda'], '--parallel requires a command');
});

test('--at with no value is refused', () => {
  refuses(['foreach', '--at'], '--at requires a glob');
});

test('--filter and --branch name themselves when their value is missing', () => {
  refuses(['clone', '--filter'], '--filter requires a value');
  refuses(['clone', '--branch'], '--branch requires a value');
});

test('an option cannot swallow the next option as its value', () => {
  refuses(['clone', '--filter', '--branch', 'x'], '--filter requires a value');
  refuses(['foreach', '--at', '--parallel', 'x'], '--at requires a glob');
});

test('unknown options are errors, never passed to the command', () => {
  refuses(['foreach', '--unknown'], "unknown option '--unknown'");
  refuses(['foreach', '--paralel', 'dotnet', 'test'], "unknown option '--paralel'");
  refuses(['clone', '--filtre', 'customer-*'], "unknown option '--filtre'");
});

// clone

test('clone takes the whole surface and nothing else', () => {
  assert.deepEqual(parse(['clone']), {
    name: 'clone',
    help: false,
    owner: null,
    team: null,
    // Repeatable options are always lists, so no caller has to tell one value
    // apart from several, or from none.
    filter: [],
    language: [],
    branch: null,
    // Confirming is the default, so the parsed value is true until asked otherwise.
    confirm: true,
  });

  const full = parse([
    'clone',
    '--owner',
    'my-org',
    '--team',
    'payments',
    '--filter',
    'customer-*',
    '--language',
    'C#',
    '--branch',
    'feature/foo',
    '--no-confirm',
  ]);
  assert.equal(full.owner, 'my-org');
  assert.equal(full.team, 'payments');
  assert.deepEqual(full.filter, ['customer-*']);
  assert.deepEqual(full.language, ['C#']);
  assert.equal(full.branch, 'feature/foo');
  assert.equal(full.confirm, false);
});

test('--filter and --language repeat, and keep the order they were given', () => {
  const command = parse([
    'clone',
    '--filter',
    'companyA*',
    '--filter',
    '*packages.internal*',
    '--language',
    'C#',
    '--language',
    'Type*',
  ]);
  assert.deepEqual(command.filter, ['companyA*', '*packages.internal*']);
  assert.deepEqual(command.language, ['C#', 'Type*']);
});

test('a repeated --owner keeps the last one, since it cannot mean two owners', () => {
  assert.equal(parse(['clone', '--owner', 'first', '--owner', 'second']).owner, 'second');
});

test('--team needs an organisation to look the team up in', () => {
  refuses(['clone', '--team', 'payments'], '--team requires --owner');
  refuses(['clone', '--team'], '--team requires a value');
  // --help outranks it: asking how the flag works must not require using it right.
  assert.equal(parse(['clone', '--team', 'payments', '--help']).help, true);
});

test('--no-confirm takes no value, and the old --yes is gone', () => {
  refuses(['clone', '--no-confirm=true'], "option '--no-confirm' does not take a value");
  refuses(['clone', '--yes'], "unknown option '--yes'");
});

test('--owner with no value is refused', () => {
  refuses(['clone', '--owner'], '--owner requires a value');
  refuses(['clone', '--owner', '--filter', 'x'], '--owner requires a value');
});

test('omitting --owner leaves the scope to gh', () => {
  assert.equal(parse(['clone', '--filter', 'customer-*']).owner, null);
});

test('clone takes no positional arguments', () => {
  refuses(['clone', 'customer-api'], "unexpected argument 'customer-api'");
});

test('inline option values are accepted', () => {
  assert.deepEqual(parse(['clone', '--filter=customer-*']).filter, ['customer-*']);
  assert.equal(parse(['foreach', '--at=**/*lambda']).at, '**/*lambda');
});

// An unset shell variable expands to an empty argument. Read as "no filter",
// `--filter ""` would widen a selection to every repository the owner has, so
// an empty value is a mistake rather than a default.
test('an empty option value is refused, not read as the option being absent', () => {
  refuses(['clone', '--owner', 'my-org', '--filter', ''], '--filter requires a value');
  refuses(['clone', '--owner', 'my-org', '--filter='], '--filter requires a value');
  refuses(['clone', '--owner', ''], '--owner requires a value');
  refuses(['foreach', '--at', '', 'pnpm', 'test'], '--at requires a glob');
  refuses(['foreach', '--at='], '--at requires a glob');
});

// Top level

test('an unknown subcommand is refused', () => {
  refuses(['frobnicate'], "unknown command 'frobnicate'");
});

test('bare repwrk asks for help rather than erroring', () => {
  assert.equal(parse([]).name, 'help');
  assert.equal(parse(['--help']).name, 'help');
});

// Short forms

test('every long option has its one-letter form, and they mean the same thing', () => {
  const long = parse([
    'clone',
    '--owner', 'my-org',
    '--team', 'payments',
    '--filter', 'customer-*',
    '--language', 'C#',
    '--branch', 'feature/foo',
  ]);
  const short = parse([
    'clone',
    '-o', 'my-org',
    '-t', 'payments',
    '-f', 'customer-*',
    '-l', 'C#',
    '-b', 'feature/foo',
  ]);

  assert.deepEqual(short, long);
});

test('foreach takes its short forms too', () => {
  assert.deepEqual(parse(['foreach', '-a', '**/*lambda', '-p', 'pnpm', 'test']), {
    name: 'foreach',
    help: false,
    at: '**/*lambda',
    parallel: true,
    command: 'pnpm',
    args: ['test'],
  });
});

test('-h asks for help wherever --help does', () => {
  assert.equal(parse(['clone', '-h']).help, true);
  assert.equal(parse(['foreach', '-h']).help, true);
});

test('a short form repeats and mixes with its long form', () => {
  const command = parse(['clone', '-f', 'companyA*', '--filter', '*packages.internal*', '-f', 'x*']);
  assert.deepEqual(command.filter, ['companyA*', '*packages.internal*', 'x*']);
});

// The flag that turns off a confirmation has no one-letter form: -y is what
// anyone would reach for, and "yes" is the spelling this flag was renamed away
// from, because it does not say what is being agreed to.
test('--no-confirm has no one-letter form', () => {
  refuses(['clone', '-y'], "unknown option '-y'");
  refuses(['clone', '-n'], "unknown option '-n'");
});

test('a short form belongs to the command that defines it', () => {
  // -p is foreach's; clone has no such thing and must not invent one.
  refuses(['clone', '-p'], "unknown option '-p'");
  refuses(['foreach', '-o', 'my-org'], "unknown option '-o'");
});

// A complaint should name the spelling in front of the reader, not its synonym.
test('an error names the form that was actually typed', () => {
  refuses(['clone', '-f'], '-f requires a value');
  refuses(['clone', '--filter'], '--filter requires a value');
  refuses(['foreach', '-a'], '-a requires a glob');
  refuses(['foreach', '-p=yes'], "option '-p' does not take a value");
});

test('an empty value is refused however it is spelled', () => {
  refuses(['clone', '-f', ''], '-f requires a value');
  refuses(['clone', '-o', ''], '-o requires a value');
});

// foreach hands everything after the command to the command, so a one-letter
// option there is the command's own and repwrk must not read it.
test('a short form after the command belongs to the command', () => {
  const command = parse(['foreach', 'ls', '-a', '-p']);
  assert.equal(command.command, 'ls');
  assert.deepEqual(command.args, ['-a', '-p']);
  assert.equal(command.at, null);
  assert.equal(command.parallel, false);
});
