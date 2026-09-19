import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { branchRepos, planBranch } from '../src/git/branch.js';
import { currentBranch, runGit } from '../src/git/git.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'github-list-branch-'));
  created.push(dir);
  return dir;
}

const IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

/** A standalone repository with one commit on `main` and no remote. */
async function makeRepo() {
  const dir = await tempDir();
  await runGit(['init', '-q', '-b', 'main'], { cwd: dir });
  await writeFile(path.join(dir, 'file.txt'), 'hello');
  await runGit(['add', '.'], { cwd: dir });
  await runGit([...IDENTITY, 'commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

/** A clone, so that origin/main exists exactly as it would after a checkout. */
async function makeClone() {
  const origin = await tempDir();
  await runGit(['init', '-q', '--bare', '-b', 'main'], { cwd: origin });
  const seed = await makeRepo();
  await runGit(['remote', 'add', 'origin', origin], { cwd: seed });
  await runGit(['push', '-q', 'origin', 'main'], { cwd: seed });

  const clone = path.join(await tempDir(), 'clone');
  await runGit(['clone', '-q', origin, clone]);
  return clone;
}

const repoFor = (name) => ({
  name,
  nameWithOwner: `Fubar83/${name}`,
  defaultBranch: 'main',
  fresh: true,
});

test('a repository already on the branch needs no action', async () => {
  const dir = await makeRepo();
  await runGit(['switch', '-q', '--create', 'chore/bump'], { cwd: dir });
  assert.deepEqual(await planBranch(dir, { branch: 'chore/bump', defaultBranch: 'main' }), {
    action: 'already-on',
  });
});

test('an existing local branch is switched to, not recreated', async () => {
  const dir = await makeRepo();
  await runGit(['branch', 'chore/bump'], { cwd: dir });
  const plan = await planBranch(dir, { branch: 'chore/bump', defaultBranch: 'main' });
  assert.equal(plan.action, 'switch');
});

test('a dirty working tree is never switched', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'file.txt'), 'uncommitted edit');
  const plan = await planBranch(dir, { branch: 'chore/bump', defaultBranch: 'main' });
  assert.equal(plan.action, 'dirty');
});

test('a dirty tree already on the branch is left alone rather than reported dirty', async () => {
  const dir = await makeRepo();
  await runGit(['switch', '-q', '--create', 'chore/bump'], { cwd: dir });
  await writeFile(path.join(dir, 'file.txt'), 'work in progress');
  const plan = await planBranch(dir, { branch: 'chore/bump', defaultBranch: 'main' });
  assert.equal(plan.action, 'already-on');
});

test('a new branch is created from origin/<default>, not from local HEAD', async () => {
  const clone = await makeClone();
  await runGit(['switch', '-q', '--create', 'stray'], { cwd: clone });
  const plan = await planBranch(clone, { branch: 'chore/bump', defaultBranch: 'main' });
  assert.deepEqual(plan, { action: 'create', from: 'origin/main' });
});

test('without a remote it falls back to the local default branch', async () => {
  const dir = await makeRepo();
  const plan = await planBranch(dir, { branch: 'chore/bump', defaultBranch: 'main' });
  assert.deepEqual(plan, { action: 'create', from: 'main' });
});

test('an unknown default branch falls back to HEAD', async () => {
  const dir = await makeRepo();
  const plan = await planBranch(dir, { branch: 'chore/bump', defaultBranch: 'trunk' });
  assert.deepEqual(plan, { action: 'create', from: null });
});

test('branchRepos puts every clean repository on the branch', async () => {
  const first = await makeClone();
  const second = await makeClone();
  const entries = [
    { repo: repoFor('first'), path: first },
    { repo: repoFor('second'), path: second },
  ];

  const result = await branchRepos(entries, { branch: 'chore/bump' });

  assert.equal(result.switched, 2);
  assert.deepEqual(result.failures, []);
  assert.equal(await currentBranch(first), 'chore/bump');
  assert.equal(await currentBranch(second), 'chore/bump');
});

test('a dirty repository fails the run and keeps its branch and its changes', async () => {
  const clean = await makeClone();
  const dirty = await makeClone();
  await writeFile(path.join(dirty, 'file.txt'), 'work in progress');

  const result = await branchRepos(
    [
      { repo: repoFor('clean'), path: clean },
      { repo: repoFor('dirty'), path: dirty },
    ],
    { branch: 'chore/bump' },
  );

  assert.equal(result.switched, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reason, 'uncommitted changes');
  assert.equal(await currentBranch(clean), 'chore/bump');
  assert.equal(await currentBranch(dirty), 'main');
});

test('branchRepos is repeatable', async () => {
  const clone = await makeClone();
  const entries = [{ repo: repoFor('one'), path: clone }];

  await branchRepos(entries, { branch: 'chore/bump' });
  const second = await branchRepos(entries, { branch: 'chore/bump' });

  assert.equal(second.switched, 1);
  assert.deepEqual(second.failures, []);
  assert.equal(await currentBranch(clone), 'chore/bump');
});
