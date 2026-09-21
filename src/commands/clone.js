import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { EXIT, RuntimeError, UsageError } from '../errors.js';
import { branchRepos } from '../git/branch.js';
import { currentBranch, isValidBranchName } from '../git/git.js';
import { GhError, runGh } from '../github/gh.js';
import { listRepos } from '../github/repos.js';
import { paletteFor } from '../color.js';
import { byName } from '../order.js';
import { Progress, formatDuration } from '../progress.js';
import { holdsRepository, isRepository } from '../workspace.js';

const plural = (count, one, many) => (count === 1 ? one : many);

/** Everything this module prints is commentary, and commentary goes to stderr. */
const note = paletteFor(process.stderr);

/** A dotfile nobody chose to put there — .git excepted, which says a great deal. */
const ignorable = (name) => name.startsWith('.') && name !== '.git';

/**
 * Entries in the working directory that are not repositories.
 *
 * Adding clones to a folder of clones is the ordinary thing to do. A folder
 * holding anything else might be somewhere the user did not mean to fill with
 * repositories, so that is worth saying out loud before it happens.
 *
 * Dotfiles do not count. A workspace picks up .DS_Store, .gitignore and the
 * like without anyone putting them there, and refusing to clone over a file
 * the operating system wrote is not a warning anyone asked for.
 *
 * .git is the exception. A directory that is itself a repository is not a
 * workspace, and filling one with clones of other repositories is exactly the
 * mistake this check exists to catch.
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
    .filter((entry) => !ignorable(entry.name) && !holdsRepository(entry, directory))
    .map((entry) => entry.name)
    .sort(byName);
}

/** Ask on the terminal. The question goes to stderr, and only an explicit yes is a yes. */
export async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * What cloning would do, worked out before anything happens: which of the
 * selected repositories are already here, and — when --branch was given —
 * which branch each of those is sitting on.
 *
 * The branch is only read, never changed. An existing clone may have work in
 * progress on it, so a mismatch is reported for the user to settle rather than
 * quietly switched underneath them.
 */
export async function surveyRepos(repos, { directory, branch = null }) {
  const survey = [];

  for (const repo of repos) {
    const target = path.join(directory, repo.name);
    const entry = { repo, path: target, present: existsSync(target), isRepo: false, on: null };

    if (entry.present) {
      entry.isRepo = isRepository(target);
      // Only worth asking git when there is a branch to compare against.
      if (entry.isRepo && branch !== null) entry.on = await currentBranch(target);
    }

    survey.push(entry);
  }

  return survey;
}

/** How one line of the preview reads. */
function describeEntry(entry, branch) {
  if (!entry.present) return '';
  if (!entry.isRepo) return note.yellow('  (already here, but not a git repository)');
  if (branch !== null && entry.on !== branch) {
    return `  (already here, on ${entry.on ?? 'an unknown branch'} — not ${branch})`;
  }
  return note.dim('  (already here, will be skipped)');
}

/**
 * Show what is about to happen. This is printed whether or not anything will
 * be asked, so an unattended run still records what it selected.
 */
export function previewClone(survey, { directory, branch }) {
  const fresh = survey.filter((entry) => !entry.present);

  process.stderr.write(
    `\nAbout to clone ${fresh.length} ${plural(fresh.length, 'repository', 'repositories')} ` +
      `into ${directory}:\n\n`,
  );
  for (const entry of survey) {
    process.stderr.write(`  ${entry.repo.nameWithOwner}${describeEntry(entry, branch)}\n`);
  }
  process.stderr.write('\n');

  return fresh;
}

/**
 * Repositories that were already here and are not on the requested branch.
 *
 * `clone --branch` only ever branches what it cloned itself, so these are
 * outside its remit — but silently leaving them on the wrong branch is how a
 * workspace ends up half on one branch and half on another.
 */
export function reportWrongBranch(survey, branch) {
  if (branch === null) return [];

  const elsewhere = survey.filter(
    (entry) => entry.present && (!entry.isRepo || entry.on !== branch),
  );
  if (elsewhere.length === 0) return elsewhere;

  process.stderr.write(
    `\nrepwrk: ${elsewhere.length} already here ${plural(elsewhere.length, 'is', 'are')} ` +
      `not on ${branch}, and ${plural(elsewhere.length, 'was', 'were')} left alone:\n`,
  );
  for (const entry of elsewhere) {
    const where = entry.isRepo ? `on ${entry.on ?? 'an unknown branch'}` : 'not a git repository';
    process.stderr.write(`  ${entry.repo.name} (${where})\n`);
  }
  process.stderr.write(`  to move them yourself: repwrk foreach git switch ${branch}\n`);

  return elsewhere;
}

/**
 * Whether cloning into `directory` may proceed: 'proceed', 'aborted' (the user
 * said no) or 'needs-confirmation' (there is a reason to ask and no terminal
 * to ask at).
 *
 * One question, carrying both things worth knowing: how many repositories are
 * about to arrive, and whether this directory looks like somewhere they were
 * meant to go.
 */
export async function checkWorkspace(directory, { cloneCount, confirm = true } = {}) {
  if (!confirm) return 'proceed';

  const foreign = await foreignEntries(directory);

  // Asking needs somewhere to read the answer and somewhere to show the
  // question. With stderr redirected the prompt lands in a file, and waiting
  // for an answer nobody can see reads as a hang.
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    // Nobody to ask. A directory full of unrelated files is still worth
    // refusing over; an ordinary workspace is not, or no script could clone.
    return foreign.length > 0 ? 'needs-confirmation' : 'proceed';
  }

  if (foreign.length > 0) {
    process.stderr.write(
      `This directory also holds ${foreign.length} ${plural(foreign.length, 'entry', 'entries')} ` +
        `that ${plural(foreign.length, 'is', 'are')} not a repository ` +
        `(${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}).\n`,
    );
  }

  const answer = await ask(
    `Clone ${cloneCount} ${plural(cloneCount, 'repository', 'repositories')} here?`,
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
      process.stderr.write(
        `${note.cyan('==>')} ${repo.nameWithOwner}: ${note.dim('already here, skipped')}\n`,
      );
      continue;
    }

    process.stderr.write(`${note.cyan('==>')} ${repo.nameWithOwner}: cloning\n`);
    try {
      await runGh(['repo', 'clone', repo.nameWithOwner, target]);
      cloned.push({ repo: { ...repo, fresh: true }, path: target });
      process.stdout.write(`${repo.name}\n`);
    } catch (error) {
      failures.push({ repo, message: error.message });
      process.stderr.write(`    ${note.red(`failed: ${error.message}`)}\n`);
    }
  }

  return { cloned, skipped, failures };
}

/** What the meter is counting through, in words. */
function listingLabel({ owner, team }) {
  if (team) return `repwrk: listing ${owner}/${team}`;
  if (owner) return `repwrk: listing ${owner}`;
  return 'repwrk: listing your repositories';
}

/**
 * Select the repositories to clone, reporting progress while GitHub is asked.
 *
 * A large organisation takes minutes to enumerate, so the listing is fetched a
 * page at a time and the meter is driven from the page boundaries. The meter
 * is taken down before anything else is printed, so whatever follows starts on
 * a clean line whether or not a terminal was there to draw on.
 */
export async function selectForClone({ owner, team, filter = [], language = [] }) {
  const progress = new Progress(listingLabel({ owner, team }));
  progress.update(0, 0);

  let repos;
  let total;
  try {
    // Without --owner the authenticated account is the owner, as before.
    ({ repos, total } = await listRepos({
      owner: owner ?? undefined,
      team: team ?? undefined,
      patterns: filter,
      language,
      onProgress: ({ fetched, total: count }) => progress.update(fetched, count),
    }));
  } catch (error) {
    progress.finish();
    if (error instanceof GhError) throw new RuntimeError(error.message, { component: 'api' });
    throw error;
  }

  const narrowed = filter.length > 0 || language.length > 0;
  progress.finish(
    `repwrk: listed ${total} ${plural(total, 'repository', 'repositories')} in ` +
      `${formatDuration(progress.elapsed)}${narrowed ? `, ${repos.length} matched` : ''}`,
  );

  return repos;
}

/**
 * `repwrk clone`.
 *
 * Selects repositories, shows what it would clone, asks, then clones the ones
 * that are missing and puts those on a branch if asked.
 */
export async function clone({ owner, team, filter = [], language = [], branch, confirm }) {
  if (branch !== null && !(await isValidBranchName(branch))) {
    // Checked before any cloning, so a typo costs a second rather than a
    // directory full of clones.
    throw new UsageError(`'${branch}' is not a valid git branch name`);
  }

  const directory = process.cwd();
  const repos = await selectForClone({ owner, team, filter, language });

  if (repos.length === 0) {
    process.stderr.write('repwrk: no repositories matched\n');
    return EXIT.SUCCESS;
  }

  const survey = await surveyRepos(repos, { directory, branch });
  const fresh = previewClone(survey, { directory, branch });

  // Nothing to clone is nothing to confirm, but a wrong branch is still worth
  // saying — it is the whole reason to re-run clone over a workspace.
  if (fresh.length === 0) {
    process.stderr.write('repwrk: every selected repository is already here\n');
    reportWrongBranch(survey, branch);
    return EXIT.SUCCESS;
  }

  const decision = await checkWorkspace(directory, { cloneCount: fresh.length, confirm });
  if (decision === 'needs-confirmation') {
    throw new RuntimeError(
      'the current directory holds entries that are not repositories, and there is no ' +
        'terminal to confirm at; pass --no-confirm to clone here anyway',
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

  reportWrongBranch(survey, branch);

  return failed ? EXIT.RUNTIME : EXIT.SUCCESS;
}
