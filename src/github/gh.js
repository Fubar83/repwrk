import { spawn } from '../spawn.js';

/** An error that should be reported to the user as a message, not a stack trace. */
export class GhError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'GhError';
    this.exitCode = exitCode;
  }
}

/** Run `gh` with the given arguments and resolve with its stdout. */
export function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });

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

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(
          new GhError(
            'gh (GitHub CLI) was not found on PATH. Install it from https://cli.github.com and run `gh auth login`.',
            127,
          ),
        );
      } else {
        reject(error);
      }
    });

    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GhError(stderr.trim() || `gh exited with code ${code}`, code ?? 1));
    });
  });
}

export async function ghJson(args) {
  const stdout = await runGh(args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GhError(`could not parse JSON from \`gh ${args.join(' ')}\``);
  }
}
