import { spawn } from '../spawn.js';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { EXIT, RuntimeError } from '../errors.js';
import { resolveWorkUnits } from '../workspace.js';

/**
 * How many commands may run at once under --parallel.
 *
 * There is deliberately no option for this: the point of --parallel is "use
 * this machine", not "tune a number". Bounded so a hundred repositories do not
 * become a hundred compilers.
 */
export const CONCURRENCY = Math.max(1, Math.min(availableParallelism(), 8));

/**
 * Run one command in one directory.
 *
 * The command and its arguments go to the OS as a list, never through a shell,
 * so an argument like `--author=John Doe` arrives exactly as written and
 * nothing re-splits or re-globs it.
 */
function runCommand(command, args, { cwd, capture }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('error', (error) => resolve({ code: 1, stdout, stderr, spawnError: error }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * A spawn fails with ENOENT both when the command does not exist and when the
 * directory it would run in does not, so the two are told apart by looking. A
 * directory that has gone away is one unit's problem, not the whole run's.
 */
function missingDirectory(result, unit) {
  return result.spawnError?.code === 'ENOENT' && !existsSync(unit.path);
}

/** A command that cannot start fails identically everywhere, so stop the run. */
function assertStartable(result, command) {
  if (result.spawnError?.code === 'ENOENT') {
    throw new RuntimeError(`command not found: ${command}`, { component: 'api' });
  }
  if (result.spawnError) {
    throw new RuntimeError(`could not start ${command}: ${result.spawnError.message}`, {
      component: 'api',
    });
  }
}

async function runSequentially(units, command, args) {
  const failures = [];

  for (const unit of units) {
    process.stderr.write(`\n==> ${unit.name}\n`);
    const result = await runCommand(command, args, { cwd: unit.path, capture: false });

    if (missingDirectory(result, unit)) {
      failures.push({ unit, code: result.code });
      process.stderr.write('    directory no longer exists, skipped\n');
      continue;
    }

    assertStartable(result, command);
    if (result.code !== 0) {
      failures.push({ unit, code: result.code });
      process.stderr.write(`    exited with ${result.code}\n`);
    }
  }

  return failures;
}

/**
 * Run with bounded concurrency, holding each unit's output until it finishes
 * so results stay readable instead of interleaving line by line. Every unit is
 * allowed to finish even when an earlier one failed.
 */
async function runInParallel(units, command, args) {
  const results = new Array(units.length);
  let next = 0;

  const worker = async () => {
    while (next < units.length) {
      const index = next;
      next += 1;
      results[index] = await runCommand(command, args, {
        cwd: units[index].path,
        capture: true,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, units.length) }, () => worker()),
  );

  const failures = [];
  // A unit that could not start stops the run, but only once every unit has
  // reported: the work is already done, and throwing first would discard it.
  let unstartable = null;

  results.forEach((result, index) => {
    const unit = units[index];
    // Every line of output is attributable: the header names the unit it
    // belongs to, and a unit's output is never split across other units'.
    process.stderr.write(`\n==> ${unit.name}\n`);
    if (missingDirectory(result, unit)) {
      failures.push({ unit, code: result.code });
      process.stderr.write('    directory no longer exists, skipped\n');
      return;
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.spawnError) {
      unstartable ??= result;
      return;
    }
    if (result.code !== 0) {
      failures.push({ unit, code: result.code });
      process.stderr.write(`    exited with ${result.code}\n`);
    }
  });

  if (unstartable) assertStartable(unstartable, command);

  return failures;
}

/**
 * `repwrk foreach`.
 *
 * With no command this is a discovery operation: it lists what it would work
 * on, one per line, and starts no child process. Finding nothing is not an
 * error.
 */
export async function foreach({ at, command, args, parallel }) {
  const units = await resolveWorkUnits(process.cwd(), at);

  if (command === null) {
    if (units.length > 0) {
      process.stdout.write(`${units.map((unit) => unit.name).join('\n')}\n`);
    }
    return EXIT.SUCCESS;
  }

  if (units.length === 0) {
    process.stderr.write(
      at ? `repwrk: nothing matches ${at}\n` : 'repwrk: no repositories here\n',
    );
    return EXIT.SUCCESS;
  }

  const failures = parallel
    ? await runInParallel(units, command, args)
    : await runSequentially(units, command, args);

  if (failures.length > 0) {
    process.stderr.write(
      `\nrepwrk: ${failures.length} of ${units.length} failed: ` +
        `${failures.map(({ unit }) => unit.name).join(', ')}\n`,
    );
    return EXIT.RUNTIME;
  }

  process.stderr.write(`\nrepwrk: ${units.length} succeeded\n`);
  return EXIT.SUCCESS;
}
