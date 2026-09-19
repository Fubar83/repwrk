import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { EXIT, RuntimeError, UsageError } from '../errors.js';
import { branchRepos } from '../git/branch.js';
import { isValidBranchName } from '../git/git.js';
import { GhError, runGh } from '../github/gh.js';
import { listRepos } from '../github/repos.js';
import { isRepository } from '../workspace.js';

/**
 * Entries in the working directory that are not repositories.
 *
 * Adding clones to a folder of clones is the ordinary thing to do and is not
 * worth a prompt. A folder holding anything else might be somewhere the user
 * did not mean to fill with repositories, so that is what gets confirmed.
 */
export async function foreignEntries(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => !(entry.isDirectory() && isRepository(path.join(directory, entry.name))))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Ask on the terminal. The prompt goes to stderr, and only an explicit yes is a yes. */
export async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Whether cloning into `directory` may proceed: 'proceed', 'aborted' (the user
 * said no) or 'needs-confirmation' (there is no terminal to ask at).
 */
export async function checkWorkspace(directory, { repoCount, assumeYes = false } = {}) {
  const foreign = await foreignEntries(directory);
  if (foreign.length === 0 || assumeYes) return 'proceed';
  if (!process.stdin.isTTY) return 'needs-confirmation';

  const answer = await confirm(
    `The current directory holds ${foreign.length} ` +
      `${foreign.length === 1 ? 'entry' : 'entries'} that ${foreign.length === 1 ? 'is' : 'are'} ` +
      `not a repository (${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}). ` +
      `Clone ${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'} here?`,
  );
  return answer ? 'proceed' : 'aborted';
}

/**
 * Clone the repositories that are not here yet, into `directory/<name>`.
 *
 * An existing directory is never cloned over and never modified — it is
 * skipped, and reported as skipped.
 */
export async function cloneRepos(repos, { directory }) {
  const cloned = [];
  const skipped = [];
  const failures = [];

  for (const repo of repos) {
    const target = path.join(directory, repo.name);

    if (existsSync(target)) {
      skipped.push(repo);
      process.stderr.write(`==> ${repo.nameWithOwner}: already here, skipped\n`);
      continue;
    }

    process.stderr.write(`==> ${repo.nameWithOwner}: cloning\n`);
    try {
      await runGh(['repo', 'clone', repo.nameWithOwner, target]);
      cloned.push({ repo: { ...repo, fresh: true }, path: target });
      process.stdout.write(`${repo.name}\n`);
    } catch (error) {
      failures.push({ repo, message: error.message });
      process.stderr.write(`    failed: ${error.message}\n`);
    }
  }

  return { cloned, skipped, failures };
}

/**
 * `repwrk clone`.
 *
 * Selects repositories, clones the ones that are missing into the current
 * directory, and puts the newly cloned ones on a branch if asked.
 */
export async function clone({ owner, filter, branch, yes }) {
  if (branch !== null && !(await isValidBranchName(branch))) {
    // Checked before any cloning, so a typo costs a second rather than a
    // directory full of clones.
    throw new UsageError(`'${branch}' is not a valid git branch name`);
  }

  const directory = process.cwd();

  let repos;
  try {
    // Without --owner, gh's own default applies: the authenticated account.
    ({ repos } = await listRepos({
      owner: owner ?? undefined,
      patterns: filter ? [filter] : [],
    }));
  } catch (error) {
    if (error instanceof GhError) {
      throw new RuntimeError(error.message, { component: 'api' });
    }
    throw error;
  }

  if (repos.length === 0) {
    process.stderr.write('repwrk: no repositories matched\n');
    return EXIT.SUCCESS;
  }

  const decision = await checkWorkspace(directory, { repoCount: repos.length, assumeYes: yes });
  if (decision === 'needs-confirmation') {
    throw new RuntimeError(
      'the current directory holds entries that are not repositories, and there is no ' +
        'terminal to confirm at; pass --yes to clone here anyway',
      { component: 'workspace' },
    );
  }
  if (decision === 'aborted') {
    process.stderr.write('repwrk: aborted, nothing was cloned\n');
    return EXIT.RUNTIME;
  }

  const result = await cloneRepos(repos, { directory });

  const summary = [`${result.cloned.length} cloned`];
  if (result.skipped.length > 0) summary.push(`${result.skipped.length} already here`);
  if (result.failures.length > 0) summary.push(`${result.failures.length} failed`);
  process.stderr.write(`\nrepwrk: ${summary.join(', ')}\n`);

  let failed = result.failures.length > 0;

  // Only repositories cloned by this invocation are branched. One that was
  // already here keeps whatever branch and changes it has.
  if (branch !== null && result.cloned.length > 0) {
    process.stderr.write('\n');
    const branched = await branchRepos(result.cloned, { branch });
    process.stderr.write(
      `\nrepwrk: ${branched.switched} of ${result.cloned.length} on ${branch}\n`,
    );
    for (const { repo, reason } of branched.failures) {
      process.stderr.write(`repwrk: ${repo.nameWithOwner} not on ${branch} — ${reason}\n`);
    }
    if (branched.failures.length > 0) failed = true;
  }

  return failed ? EXIT.RUNTIME : EXIT.SUCCESS;
}
