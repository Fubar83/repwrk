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

test('clone takes the whole v1 surface and nothing else', () => {
  assert.deepEqual(parse(['clone']), {
    name: 'clone',
    help: false,
    owner: null,
    filter: null,
    branch: null,
    yes: false,
  });

  const full = parse([
    'clone',
    '--owner',
    'my-org',
    '--filter',
    'customer-*',
    '--branch',
    'feature/foo',
    '--yes',
  ]);
  assert.equal(full.owner, 'my-org');
  assert.equal(full.filter, 'customer-*');
  assert.equal(full.branch, 'feature/foo');
  assert.equal(full.yes, true);
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
  assert.equal(parse(['clone', '--filter=customer-*']).filter, 'customer-*');
  assert.equal(parse(['foreach', '--at=**/*lambda']).at, '**/*lambda');
});

// Top level

test('an unknown subcommand is refused', () => {
  refuses(['frobnicate'], "unknown command 'frobnicate'");
});

test('bare repwrk asks for help rather than erroring', () => {
  assert.equal(parse([]).name, 'help');
  assert.equal(parse(['--help']).name, 'help');
});
