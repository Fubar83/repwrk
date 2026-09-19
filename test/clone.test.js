import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { checkWorkspace, foreignEntries } from '../src/commands/clone.js';
import { runGit } from '../src/git/git.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'repwrk-clone-'));
  created.push(dir);
  return dir;
}

async function makeRepoIn(parent, name) {
  const repo = path.join(parent, name);
  await mkdir(repo, { recursive: true });
  await runGit(['init', '-q', '-b', 'main'], { cwd: repo });
  return repo;
}

/**
 * confirm() reads the terminal, so it is exercised in a child process with a
 * piped stdin rather than in-process.
 */
function askInChild(answer) {
  const source = `
    const { confirm } = await import(${JSON.stringify(new URL('../src/commands/clone.js', import.meta.url).href)});
    process.stdout.write(String(await confirm('proceed?')));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(stdout.trim()));
    child.stdin.end(answer);
  });
}

test('an empty directory holds nothing foreign', async () => {
  assert.deepEqual(await foreignEntries(await tempDir()), []);
});

test('a directory of clones holds nothing foreign', async () => {
  const workspace = await tempDir();
  await makeRepoIn(workspace, 'api');
  await makeRepoIn(workspace, 'web');

  assert.deepEqual(await foreignEntries(workspace), []);
});

test('files and plain directories are foreign', async () => {
  const workspace = await tempDir();
  await makeRepoIn(workspace, 'api');
  await writeFile(path.join(workspace, 'notes.txt'), 'hello');
  await mkdir(path.join(workspace, 'Downloads'));

  assert.deepEqual(await foreignEntries(workspace), ['Downloads', 'notes.txt']);
});

test('cloning into an empty directory is not confirmed', async () => {
  assert.equal(await checkWorkspace(await tempDir(), { repoCount: 3 }), 'proceed');
});

test('adding clones to a workspace of clones is not confirmed', async () => {
  const workspace = await tempDir();
  await makeRepoIn(workspace, 'api');

  assert.equal(await checkWorkspace(workspace, { repoCount: 3 }), 'proceed');
});

test('a directory holding anything else is never cloned into unattended', async () => {
  const workspace = await tempDir();
  await writeFile(path.join(workspace, 'thesis.docx'), 'important');

  // The test runner's stdin is not a terminal, which is exactly the
  // unattended case: refuse rather than guess.
  assert.equal(await checkWorkspace(workspace, { repoCount: 3 }), 'needs-confirmation');
});

test('--yes proceeds without asking', async () => {
  const workspace = await tempDir();
  await writeFile(path.join(workspace, 'thesis.docx'), 'important');

  assert.equal(await checkWorkspace(workspace, { repoCount: 3, assumeYes: true }), 'proceed');
});

test('confirm accepts y and yes, in any case', async () => {
  assert.equal(await askInChild('y\n'), 'true');
  assert.equal(await askInChild('Y\n'), 'true');
  assert.equal(await askInChild('yes\n'), 'true');
  assert.equal(await askInChild('YES\n'), 'true');
});

test('confirm treats anything else as no', async () => {
  assert.equal(await askInChild('n\n'), 'false');
  assert.equal(await askInChild('\n'), 'false');
  assert.equal(await askInChild('maybe\n'), 'false');
  assert.equal(await askInChild('ya\n'), 'false');
});
