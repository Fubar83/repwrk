import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runGit } from '../src/git/git.js';
import { discoverRepos, isRepository, resolveWorkUnits, targetsIn } from '../src/workspace.js';

const created = [];

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A workspace of repositories. `layout` maps a directory name to the files it
 * should contain, or null for a directory that is not a repository at all.
 */
async function makeWorkspace(layout) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'repwrk-ws-'));
  created.push(workspace);

  for (const [name, files] of Object.entries(layout)) {
    const repo = path.join(workspace, name);
    await mkdir(repo, { recursive: true });
    if (files === null) continue;

    await runGit(['init', '-q', '-b', 'main'], { cwd: repo });
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(path.join(repo, path.dirname(file)), { recursive: true });
      await writeFile(path.join(repo, file), contents ?? '{}');
    }
  }

  return workspace;
}

const names = (units) => units.map((unit) => unit.name);

const repoIn = (workspace, name) => ({ name, path: path.join(workspace, name) });

test('a workspace is the direct child directories that are repositories', async () => {
  const workspace = await makeWorkspace({
    web: {},
    api: {},
    infrastructure: {},
    'not-a-repo': null,
  });

  assert.deepEqual(names(await discoverRepos(workspace)), ['api', 'infrastructure', 'web']);
});

test('repositories are listed by name, in deterministic order', async () => {
  const workspace = await makeWorkspace({ c: {}, a: {}, b: {} });
  const units = await resolveWorkUnits(workspace, null);

  assert.deepEqual(names(units), ['a', 'b', 'c']);
  assert.equal(units[0].path, path.join(workspace, 'a'));
});

test('a repository nested deeper than a direct child is not included', async () => {
  const workspace = await makeWorkspace({ api: {} });
  const nested = path.join(workspace, 'outer', 'inner');
  await mkdir(nested, { recursive: true });
  await runGit(['init', '-q'], { cwd: nested });

  assert.deepEqual(names(await discoverRepos(workspace)), ['api']);
});

test('isRepository recognises a clone, not just any folder', async () => {
  const workspace = await makeWorkspace({ repo: {}, plain: null });
  assert.equal(isRepository(path.join(workspace, 'repo')), true);
  assert.equal(isRepository(path.join(workspace, 'plain')), false);
});

test('a missing workspace is a runtime error, not a crash', async () => {
  await assert.rejects(() => discoverRepos(path.join(tmpdir(), 'repwrk-missing-9z8y7x')), {
    name: 'RuntimeError',
  });
});

test('a glob matching directories makes each one a target', async () => {
  const workspace = await makeWorkspace({
    api: { 'services/foo-lambda/index.js': '', 'services/web/index.js': '' },
  });

  const targets = await targetsIn(repoIn(workspace, 'api'), '**/*lambda');
  assert.deepEqual(names(targets), ['api/services/foo-lambda']);
});

test('a glob matching files targets the directory holding them', async () => {
  const workspace = await makeWorkspace({
    api: { 'services/foo-lambda/package.json': '', 'services/bar-lambda/package.json': '' },
    web: { 'functions/foo-lambda/package.json': '', 'src/app.js': '' },
  });

  const repos = await discoverRepos(workspace);
  const targets = [];
  for (const repo of repos) targets.push(...(await targetsIn(repo, '**/*lambda/package.json')));

  assert.deepEqual(names(targets), [
    'api/services/bar-lambda',
    'api/services/foo-lambda',
    'web/functions/foo-lambda',
  ]);
  assert.equal(targets[0].path, path.join(workspace, 'api', 'services', 'bar-lambda'));
});

test('several matches collapsing onto one directory yield one target', async () => {
  const workspace = await makeWorkspace({
    api: { 'services/foo-lambda/package.json': '', 'services/foo-lambda/tsconfig.json': '' },
  });

  const targets = await targetsIn(repoIn(workspace, 'api'), '**/*lambda/*.json');
  assert.deepEqual(names(targets), ['api/services/foo-lambda']);
});

test('a repository with no match contributes nothing, and that is not an error', async () => {
  const workspace = await makeWorkspace({ docs: { 'README.md': 'hi' } });
  assert.deepEqual(await targetsIn(repoIn(workspace, 'docs'), '**/*lambda'), []);
});

test('ignored paths are never targets', async () => {
  const workspace = await makeWorkspace({
    api: {
      '.gitignore': 'node_modules/\ndist/\n',
      'node_modules/vendor-lambda/package.json': '',
      'dist/built-lambda/package.json': '',
      'src/real-lambda/package.json': '',
    },
  });

  const targets = await targetsIn(repoIn(workspace, 'api'), '**/*lambda/package.json');
  assert.deepEqual(names(targets), ['api/src/real-lambda']);
});

test('a glob cannot reach outside the repository', async () => {
  const workspace = await makeWorkspace({
    api: { 'src/app.js': '' },
    secrets: { 'keys.txt': '' },
  });

  assert.deepEqual(await targetsIn(repoIn(workspace, 'api'), '../**'), []);
  assert.deepEqual(await targetsIn(repoIn(workspace, 'api'), '../secrets'), []);
});

test('target names read with forward slashes on every platform', async () => {
  const workspace = await makeWorkspace({ api: { 'services/foo-lambda/package.json': '' } });
  const [target] = await targetsIn(repoIn(workspace, 'api'), '**/*lambda/package.json');

  assert.equal(target.name, 'api/services/foo-lambda');
});

test('a match at the repository root targets the repository itself', async () => {
  const workspace = await makeWorkspace({ api: { 'package.json': '' } });
  const [target] = await targetsIn(repoIn(workspace, 'api'), 'package.json');

  assert.equal(target.name, 'api');
  assert.equal(target.path, path.join(workspace, 'api'));
});
