import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from './errors.js';
import { runGit } from './git/git.js';
import { matchesPath } from './glob.js';

export function isRepository(directory) {
  return existsSync(path.join(directory, '.git'));
}

/**
 * The repositories in the workspace: the direct child directories of `cwd`
 * that are git repositories, in name order so that runs are reproducible.
 */
export async function discoverRepos(workspace) {
  let entries;
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new RuntimeError(`workspace not found: ${workspace}`, { component: 'workspace' });
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(workspace, entry.name) }))
    .filter((repo) => isRepository(repo.path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listFiles(repo, selectors) {
  const { code, stdout, stderr } = await runGit(['ls-files', ...selectors, '-z'], {
    cwd: repo.path,
  });
  if (code !== 0) {
    throw new RuntimeError(`could not read ${repo.name}: ${stderr}`, { component: 'git' });
  }
  return stdout.split('\0').filter(Boolean);
}

/**
 * Every path git considers part of a repository — tracked files plus untracked
 * ones that are not ignored.
 *
 * Asking git rather than walking the filesystem is what makes ignore rules
 * apply for free: anything in .gitignore never appears, so `node_modules` and
 * `bin`/`obj` are excluded because the repository says so, not because this
 * tool has opinions about them. It also cannot escape the repository, so a
 * pattern like `../*` matches nothing.
 */
async function repositoryPaths(repo) {
  // --cached lists a file that is tracked but no longer in the working tree, so
  // the deleted ones are subtracted: a target has to be a directory a command
  // can actually run in.
  const [listed, deleted] = await Promise.all([
    listFiles(repo, ['--cached', '--others', '--exclude-standard']),
    listFiles(repo, ['--deleted']),
  ]);

  const gone = new Set(deleted);
  const files = listed.filter((file) => !gone.has(file));

  // A directory exists, as far as a glob is concerned, if a file lives under it.
  const directories = new Set();
  for (const file of files) {
    const segments = file.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join('/'));
    }
  }

  return { files, directories };
}

/**
 * The execution targets inside one repository.
 *
 * A matching directory is a target. A matching file makes the directory
 * holding it a target — which is what lets `**\/*lambda/package.json` select
 * lambda directories by the file that identifies them. Several matches can
 * collapse onto the same directory, so targets are deduplicated.
 */
export async function targetsIn(repo, pattern) {
  const { files, directories } = await repositoryPaths(repo);
  const found = new Set();

  for (const directory of directories) {
    if (matchesPath(directory, pattern)) found.add(directory);
  }
  for (const file of files) {
    if (matchesPath(file, pattern)) {
      const parent = path.posix.dirname(file);
      found.add(parent === '.' ? '' : parent);
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b)).map((relative) => ({
    repo,
    // Listed and reported exactly as the spec shows: repo/path/inside.
    name: relative === '' ? repo.name : `${repo.name}/${relative}`,
    path: relative === '' ? repo.path : path.join(repo.path, ...relative.split('/')),
  }));
}

/**
 * What `foreach` will work on: every repository, or every path matching
 * `pattern` inside them. A repository with no match contributes nothing, which
 * is not an error — a glob may describe a shape only some repositories have.
 */
export async function resolveWorkUnits(workspace, pattern) {
  const repos = await discoverRepos(workspace);
  if (!pattern) {
    return repos.map((repo) => ({ repo, name: repo.name, path: repo.path }));
  }

  const targets = [];
  for (const repo of repos) targets.push(...(await targetsIn(repo, pattern)));
  return targets;
}
