import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  checkWorkspace,
  foreignEntries,
  reportWrongBranch,
  surveyRepos,
} from '../src/commands/clone.js';
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
 * ask() reads the terminal, so it is exercised in a child process with a
 * piped stdin rather than in-process.
 */
function askInChild(answer) {
  const source = `
    const { ask } = await import(${JSON.stringify(new URL('../src/commands/clone.js', import.meta.url).href)});
    process.stdout.write(String(await ask('proceed?')));
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

// The test runner's stdin is not a terminal, which is the unattended case:
// there is nobody to ask, so an ordinary workspace proceeds and a directory
// of unrelated files does not.

test('an unattended run clones into an empty directory', async () => {
  assert.equal(await checkWorkspace(await tempDir(), { cloneCount: 3 }), 'proceed');
});

test('an unattended run adds clones to a workspace of clones', async () => {
  const workspace = await tempDir();
  await makeRepoIn(workspace, 'api');

  assert.equal(await checkWorkspace(workspace, { cloneCount: 3 }), 'proceed');
});

test('dotfiles the system leaves behind are not foreign', async () => {
  const workspace = await tempDir();
  await makeRepoIn(workspace, 'api');
  await writeFile(path.join(workspace, '.DS_Store'), '');
  await writeFile(path.join(workspace, '.gitignore'), 'node_modules');

  assert.deepEqual(await foreignEntries(workspace), []);
});

test('a workspace holding only dotfiles is still cloned into unattended', async () => {
  const workspace = await tempDir();
  await makeRepoIn(workspace, 'api');
  await writeFile(path.join(workspace, '.DS_Store'), '');

  // A file nobody chose to put there is no reason to refuse a scripted clone.
  assert.equal(await checkWorkspace(workspace, { cloneCount: 3 }), 'proceed');
});

test('a directory holding anything else is never cloned into unattended', async () => {
  const workspace = await tempDir();
  await writeFile(path.join(workspace, 'thesis.docx'), 'important');

  assert.equal(await checkWorkspace(workspace, { cloneCount: 3 }), 'needs-confirmation');
});

test('--no-confirm proceeds without asking', async () => {
  const workspace = await tempDir();
  await writeFile(path.join(workspace, 'thesis.docx'), 'important');

  assert.equal(await checkWorkspace(workspace, { cloneCount: 3, confirm: false }), 'proceed');
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

// Surveying what is already here, and reporting the ones on another branch

const repoRecord = (name) => ({ name, nameWithOwner: `my-org/${name}` });

async function commitIn(repo) {
  await writeFile(path.join(repo, 'README.md'), '#\n');
  await runGit(['add', '-A'], { cwd: repo });
  await runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: repo,
  });
}

/** Run `body`, returning what it wrote to stderr instead of printing it. */
async function captureStderr(body) {
  const original = process.stderr.write;
  let output = '';
  process.stderr.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    await body();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

test('a survey says which selected repositories are already here', async () => {
  const workspace = await tempDir();
  await makeRepoIn(workspace, 'api');

  const survey = await surveyRepos([repoRecord('api'), repoRecord('web')], {
    directory: workspace,
  });

  assert.deepEqual(
    survey.map((entry) => [entry.repo.name, entry.present]),
    [
      ['api', true],
      ['web', false],
    ],
  );
  // No branch was asked for, so git is never consulted.
  assert.equal(survey[0].on, null);
});

test('a survey reads the branch of each repository already here', async () => {
  const workspace = await tempDir();
  const api = await makeRepoIn(workspace, 'api');
  await commitIn(api);
  await runGit(['switch', '-q', '--create', 'feature/foo'], { cwd: api });

  const web = await makeRepoIn(workspace, 'web');
  await commitIn(web);

  const survey = await surveyRepos([repoRecord('api'), repoRecord('web')], {
    directory: workspace,
    branch: 'feature/foo',
  });

  assert.equal(survey[0].on, 'feature/foo');
  assert.equal(survey[1].on, 'main');
});

test('a repository already here on another branch is reported, not changed', async () => {
  const workspace = await tempDir();
  const api = await makeRepoIn(workspace, 'api');
  await commitIn(api);
  await runGit(['switch', '-q', '--create', 'feature/foo'], { cwd: api });

  const web = await makeRepoIn(workspace, 'web');
  await commitIn(web);

  const survey = await surveyRepos([repoRecord('api'), repoRecord('web')], {
    directory: workspace,
    branch: 'feature/foo',
  });

  let elsewhere;
  const written = await captureStderr(() => {
    elsewhere = reportWrongBranch(survey, 'feature/foo');
  });

  assert.match(written, /web \(on main\)/);
  // The one already on the branch is not nagged about.
  assert.doesNotMatch(written, /api \(on/);
  // And the user is told how to move them.
  assert.match(written, /repwrk foreach git switch feature\/foo/);

  assert.equal(elsewhere.length, 1);
  // Reported only: web is still on the branch it was on.
  const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: web });
  assert.equal(stdout, 'main');
});

test('nothing is reported when no branch was asked for', async () => {
  const workspace = await tempDir();
  await makeRepoIn(workspace, 'api');

  const survey = await surveyRepos([repoRecord('api')], { directory: workspace });
  assert.deepEqual(reportWrongBranch(survey, null), []);
});

test('a plain directory sitting where a clone would go is reported', async () => {
  const workspace = await tempDir();
  await mkdir(path.join(workspace, 'api'));

  const survey = await surveyRepos([repoRecord('api')], {
    directory: workspace,
    branch: 'main',
  });
  assert.equal(survey[0].present, true);
  assert.equal(survey[0].isRepo, false);

  const written = await captureStderr(() => reportWrongBranch(survey, 'main'));
  assert.match(written, /api \(not a git repository\)/);
});
