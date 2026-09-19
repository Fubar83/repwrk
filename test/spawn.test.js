import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { escapeForCmd, resolveCommand, spawn } from '../src/spawn.js';

const isWindows = process.platform === 'win32';

/**
 * Arguments that get mangled, or start a second command, if the escaping is
 * wrong. Each one has broken a real tool at some point.
 */
const AWKWARD_ARGUMENTS = [
  ['plain'],
  ['hello world'],
  ['--author=John Doe'],
  ['a"b'],
  ['say "hi" twice'],
  ['c&d'],
  ['a|b', 'c>d', 'e<f'],
  ['(parens)'],
  ['100%'],
  ['%PATH%'],
  ['%%'],
  ['!bang!'],
  ['^caret'],
  ['back\\slash'],
  ['trailing\\'],
  ['two\\\\'],
  ['quote\\"mix'],
  ['--pretty=%s [%an]'],
  ['', 'empty-before'],
  ['tab\tseparated'],
  ['a&b', 'c d', '"quoted"', '%X%'],
];

describe('spawning a command', () => {
  let fixtures;
  let originalPath;

  before(async () => {
    // A space in the path: npm.cmd really does live under "C:\Program Files".
    // realpath because macOS hands out /var/... but a child process reports
    // its cwd as the /private/var/... it really resolves to.
    fixtures = await realpath(await mkdtemp(path.join(tmpdir(), 'repwrk spawn tests ')));

    await writeFile(
      path.join(fixtures, 'print-argv.js'),
      'console.log(JSON.stringify(process.argv.slice(2)));\n',
    );

    if (isWindows) {
      // Shaped exactly like npm.cmd: a batch file forwarding %* to node.
      await writeFile(
        path.join(fixtures, 'argvtest.cmd'),
        '@echo off\r\nnode "%~dp0print-argv.js" %*\r\n',
      );
      // npm also ships an extensionless POSIX shell script beside npm.cmd.
      // Windows cannot execute it, so resolution must not prefer it.
      await writeFile(
        path.join(fixtures, 'argvtest'),
        '#!/bin/sh\nexec node "$(dirname "$0")/print-argv.js" "$@"\n',
      );
    } else {
      const script = path.join(fixtures, 'argvtest');
      await writeFile(script, '#!/bin/sh\nexec node "$(dirname "$0")/print-argv.js" "$@"\n', {
        mode: 0o755,
      });
    }

    originalPath = process.env.PATH;
    process.env.PATH = `${fixtures}${path.delimiter}${originalPath}`;
  });

  after(async () => {
    process.env.PATH = originalPath;
    await rm(fixtures, { recursive: true, force: true });
  });

  /** Run the fixture and return the argv it actually received. */
  function argvSeenBy(args) {
    return new Promise((resolve, reject) => {
      const child = spawn('argvtest', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error(`unparseable output: ${JSON.stringify(stdout)} ${stderr}`));
        }
      });
    });
  }

  for (const args of AWKWARD_ARGUMENTS) {
    test(`arguments arrive unchanged: ${JSON.stringify(args)}`, async () => {
      assert.deepEqual(await argvSeenBy(args), args);
    });
  }

  test('a metacharacter cannot start a second command', async () => {
    const seen = await argvSeenBy(['one', '&', 'echo', 'INJECTED']);
    assert.deepEqual(seen, ['one', '&', 'echo', 'INJECTED']);
  });

  test('an environment variable reference stays literal', async () => {
    const [seen] = await argvSeenBy(['%PATH%']);
    assert.equal(seen, '%PATH%');
  });

  test('a command that does not exist reports ENOENT', async () => {
    const child = spawn('repwrk-no-such-command-9z8y7x', [], { stdio: 'ignore' });
    const error = await new Promise((resolve) => child.on('error', resolve));
    assert.equal(error.code, 'ENOENT');
  });

  test('a real executable still runs', async () => {
    const child = spawn('node', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    await new Promise((resolve) => child.on('close', resolve));
    assert.match(stdout.trim(), /^v\d+\./);
  });

  test('the working directory is honoured', async () => {
    const child = spawn(process.execPath, ['-p', 'process.cwd()'], {
      cwd: fixtures,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    await new Promise((resolve) => child.on('close', resolve));
    assert.equal(path.resolve(stdout.trim()), path.resolve(fixtures));
  });
});

describe('resolving a command name', { skip: !isWindows && 'Windows-only behaviour' }, () => {
  test('a name on PATH resolves to a real file', () => {
    const resolved = resolveCommand('node');
    assert.ok(resolved?.toLowerCase().endsWith('node.exe'), `got ${resolved}`);
  });

  test('a name that is not on PATH resolves to null', () => {
    assert.equal(resolveCommand('repwrk-no-such-command-9z8y7x'), null);
  });

  test('PATHEXT decides which extensions are tried', () => {
    const env = { PATH: process.env.PATH, PATHEXT: '.NOPE' };
    assert.equal(resolveCommand('node', { env }), null);
  });

  test('an extensionless sibling never wins over the executable one', () => {
    // npm is exactly this shape: a POSIX `npm` script next to `npm.cmd`.
    const resolved = resolveCommand('npm');
    assert.ok(resolved?.toLowerCase().endsWith('npm.cmd'), `got ${resolved}`);
  });
});

describe('cmd.exe escaping', () => {
  test('every metacharacter is hidden from cmd.exe', () => {
    for (const character of ['&', '|', '<', '>', '(', ')', '^', '%', '!']) {
      assert.ok(
        escapeForCmd(character).includes(`^${character}`),
        `${character} was not escaped: ${escapeForCmd(character)}`,
      );
    }
  });

  test('a trailing backslash cannot escape the closing quote', () => {
    // One backslash becomes two, so the quote that follows stays a quote.
    assert.equal(escapeForCmd('x\\'), '^"x\\\\^"');
  });

  test('an embedded quote is escaped for the C runtime', () => {
    assert.equal(escapeForCmd('a"b'), '^"a\\^"b^"');
  });
});
