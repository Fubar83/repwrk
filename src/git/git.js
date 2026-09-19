import { spawn } from '../spawn.js';

/**
 * Run git and resolve with its exit code and output — never reject, because
 * callers here use a non-zero exit as an answer ("that ref does not exist")
 * as often as an error.
 */
export function runGit(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

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

    child.on('error', (error) => resolve({ code: 1, stdout: '', stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

export async function currentBranch(cwd) {
  const { code, stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return code === 0 ? stdout : null;
}

/** True when the working tree has uncommitted changes, staged or not. */
export async function isDirty(cwd) {
  const { code, stdout } = await runGit(['status', '--porcelain'], { cwd });
  return code === 0 && stdout.length > 0;
}

export async function refExists(ref, cwd) {
  const { code } = await runGit(['rev-parse', '--verify', '--quiet', ref], { cwd });
  return code === 0;
}

/** Ask git itself whether a branch name is legal, rather than guessing at the rules. */
export async function isValidBranchName(name) {
  const { code } = await runGit(['check-ref-format', '--branch', name]);
  return code === 0;
}
