import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGit } from '../src/git/git.js';

const CLI = fileURLToPath(new URL('../bin/repwrk.js', import.meta.url));
const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Run the CLI itself in `cwd`, so exit codes and reporting are covered too. */
function repwrk(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * A workspace holding one repository with two lambda directories, plus a
 * script that deletes `b-lambda` when it runs in `a-lambda`. Targets are
 * visited in name order, so that removes the second target after discovery
 * has already listed it — the race the tool has to survive.
 */
async function makeWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'repwrk-foreach-'));
  created.push(workspace);

  const repo = path.join(workspace, 'api');
  await mkdir(path.join(repo, 'services/a-lambda'), { recursive: true });
  await mkdir(path.join(repo, 'services/b-lambda'), { recursive: true });
  await runGit(['init', '-q', '-b', 'main'], { cwd: repo });
  await writeFile(path.join(repo, 'services/a-lambda/package.json'), '{}');
  await writeFile(path.join(repo, 'services/b-lambda/package.json'), '{}');

  // .cjs: this lives outside the package, but say so rather than rely on it.
  const script = path.join(workspace, 'kill-sibling.cjs');
  await writeFile(
    script,
    'const path = require("node:path");\n' +
      'const fs = require("node:fs");\n' +
      'const here = path.basename(process.cwd());\n' +
      'if (here === "a-lambda") {\n' +
      '  fs.rmSync(path.join(process.cwd(), "..", "b-lambda"), ' +
      '{ recursive: true, force: true });\n' +
      '}\n' +
      'console.log("ran in " + here);\n',
  );

  return { workspace, script };
}

test('a target directory that disappears mid-run fails only that target', async () => {
  const { workspace, script } = await makeWorkspace();

  const result = await repwrk(
    ['foreach', '--at', '**/*lambda', process.execPath, script],
    workspace,
  );

  // The spawn fails with ENOENT because the directory is gone — not because
  // node is missing, which is what the message used to claim.
  assert.doesNotMatch(result.stderr, /command not found/);
  assert.match(result.stderr, /directory no longer exists/);
  // The target that did run still ran, and still reported its output.
  assert.match(result.stdout, /ran in a-lambda/);
  assert.match(result.stderr, /1 of 2 failed/);
  assert.equal(result.code, 1);
});

test('a command that really is missing still stops the whole run', async () => {
  const { workspace } = await makeWorkspace();

  const result = await repwrk(
    ['foreach', '--at', '**/*lambda', 'repwrk-no-such-command-9z8y7x'],
    workspace,
  );

  assert.match(result.stderr, /command not found: repwrk-no-such-command-9z8y7x/);
  assert.equal(result.code, 1);
});

test('a missing command stops a parallel run too', async () => {
  const { workspace } = await makeWorkspace();

  const result = await repwrk(
    ['foreach', '--parallel', 'repwrk-no-such-command-9z8y7x'],
    workspace,
  );

  assert.match(result.stderr, /command not found: repwrk-no-such-command-9z8y7x/);
  assert.equal(result.code, 1);
});

test('every repository still gets its turn when one command fails', async () => {
  const { workspace } = await makeWorkspace();

  const result = await repwrk(
    ['foreach', '--at', '**/*lambda', process.execPath, '-e', 'process.exit(3)'],
    workspace,
  );

  assert.match(result.stderr, /exited with 3/);
  assert.match(result.stderr, /2 of 2 failed/);
  assert.equal(result.code, 1);
});

/**
 * Two repositories holding the same script, executable in one and not in the
 * other — a command that starts in some working directories and not others.
 */
async function makeRunnerWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'repwrk-foreach-'));
  created.push(workspace);

  for (const [name, mode] of [
    ['able', 0o755],
    ['unable', 0o644],
  ]) {
    const repo = path.join(workspace, name);
    await mkdir(repo, { recursive: true });
    await runGit(['init', '-q', '-b', 'main'], { cwd: repo });
    const runner = path.join(repo, 'runner');
    await writeFile(runner, ['#!/bin/sh', 'echo "ran in $(basename "$PWD")"', ''].join('\n'));
    await chmod(runner, mode);
  }

  return workspace;
}

test(
  'a unit that cannot start does not swallow the output of the ones that ran',
  { skip: process.platform === 'win32' && 'POSIX file permissions' },
  async () => {
    const workspace = await makeRunnerWorkspace();

    const result = await repwrk(['foreach', '--parallel', './runner'], workspace);

    // The work was already done when the failure surfaced; throwing it away
    // would mean running everything again to see any of it.
    assert.match(result.stdout, /ran in able/);
    assert.match(result.stderr, /could not start \.\/runner|command not found/);
    assert.equal(result.code, 1);
  },
);
