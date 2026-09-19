import { currentBranch, isDirty, refExists, runGit } from './git.js';

/**
 * Work out what should happen to one repository, without touching it.
 *
 * Kept separate from doing it so the decision is testable on its own.
 */
export async function planBranch(directory, { branch, defaultBranch }) {
  const current = await currentBranch(directory);
  if (current === branch) return { action: 'already-on' };

  // The one case where switching could cost someone work.
  if (await isDirty(directory)) return { action: 'dirty' };

  // A branch that exists locally, or on the remote, is joined rather than
  // recreated — otherwise a second machine would start a parallel history
  // under the same name.
  if (await refExists(`refs/heads/${branch}`, directory)) return { action: 'switch' };
  if (await refExists(`refs/remotes/origin/${branch}`, directory)) {
    return { action: 'switch', tracking: true };
  }

  // Otherwise branch from the default branch as the remote has it, not from
  // whatever happens to be checked out.
  const remoteDefault = defaultBranch ? `refs/remotes/origin/${defaultBranch}` : null;
  if (remoteDefault && (await refExists(remoteDefault, directory))) {
    return { action: 'create', from: `origin/${defaultBranch}` };
  }
  if (defaultBranch && (await refExists(`refs/heads/${defaultBranch}`, directory))) {
    return { action: 'create', from: defaultBranch };
  }
  return { action: 'create', from: null };
}

function describe(plan, branch) {
  switch (plan.action) {
    case 'already-on':
      return `already on ${branch}`;
    case 'dirty':
      return 'has uncommitted changes, left untouched';
    case 'switch':
      return plan.tracking ? `checking out ${branch} from origin` : `switching to ${branch}`;
    default:
      return plan.from ? `creating ${branch} from ${plan.from}` : `creating ${branch}`;
  }
}

/**
 * Put each repository on `branch`.
 *
 * `entries` are `{ repo, path }` pairs. A repository with uncommitted changes
 * is left alone, and counts as a failure: the caller asked for every one of
 * them to be on the branch, and it is not.
 */
export async function branchRepos(entries, { branch } = {}) {
  const failures = [];
  let switched = 0;

  for (const { repo, path: directory } of entries) {
    const plan = await planBranch(directory, { branch, defaultBranch: repo.defaultBranch });
    process.stderr.write(`==> ${repo.nameWithOwner ?? repo.name}: ${describe(plan, branch)}\n`);

    if (plan.action === 'already-on') {
      switched += 1;
      continue;
    }
    if (plan.action === 'dirty') {
      failures.push({ repo, reason: 'uncommitted changes' });
      continue;
    }

    const args =
      plan.action === 'switch'
        ? ['switch', branch]
        : ['switch', '--create', branch, ...(plan.from ? [plan.from] : [])];

    const { code, stderr } = await runGit(args, { cwd: directory });
    if (code === 0) {
      switched += 1;
    } else {
      failures.push({ repo, reason: stderr || `git switch exited with ${code}` });
      process.stderr.write(`    failed: ${stderr}\n`);
    }
  }

  return { switched, failures };
}
