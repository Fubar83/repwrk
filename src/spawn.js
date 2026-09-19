import { spawn as childSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * Spawning a command on Windows, without a shell.
 *
 * On Windows `npm`, `pnpm` and `yarn` are not executables — they are `.cmd`
 * batch files. Three things break as a result:
 *
 *   spawn('npm')                ENOENT  CreateProcess only ever appends .exe,
 *                                       and never consults PATHEXT
 *   spawn('npm.cmd')            EINVAL  Node refuses to spawn .cmd/.bat
 *                                       without a shell (CVE-2024-27980)
 *   spawn('C:\...\npm.cmd')     EINVAL  same refusal; the path does not help
 *
 * Only cmd.exe can interpret a batch file, so a `.cmd` has to be run as
 * `cmd.exe /d /s /c "<command line>"`. That means turning the argument array
 * back into a string which cmd.exe will split into exactly the same array —
 * which is what most of this file is about.
 *
 * Everywhere other than Windows, and for real executables on Windows, this is
 * an ordinary spawn with an argument list and no shell involved.
 */

const isWindows = process.platform === 'win32';

/** Batch files are interpreted by cmd.exe; everything else can be executed. */
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathExtensions(env) {
  return (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
}

/**
 * Find the file that a command name actually refers to, the way the shell
 * would: each directory on PATH, each extension in PATHEXT.
 *
 * Returns null when nothing matches, which the caller turns into ENOENT.
 */
export function resolveCommand(command, { cwd = process.cwd(), env = process.env } = {}) {
  if (!isWindows) return command;

  const extensions = pathExtensions(env);
  const hasExtension = path.extname(command) !== '';

  const candidatesIn = (directory) => {
    const base = path.resolve(directory, command);
    const withExtensions = extensions.map((extension) => base + extension);
    // Windows runs a file only if its extension is in PATHEXT, so a name with
    // no extension is never used as-is. This matters: npm ships a `npm` POSIX
    // shell script right next to `npm.cmd`, and picking the extensionless one
    // yields a file Windows cannot execute.
    return hasExtension ? [base, ...withExtensions] : withExtensions;
  };

  // A command containing a separator is a path, not something to look up.
  if (command.includes('/') || command.includes('\\')) {
    return candidatesIn(cwd).find(isFile) ?? null;
  }

  const searchPath = env.Path ?? env.PATH ?? '';
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const found = candidatesIn(directory).find(isFile);
    if (found) return found;
  }

  return null;
}

/**
 * Quote one argument so that it survives both parsers between here and the
 * program: cmd.exe, and then the C runtime that splits the command line back
 * into argv.
 *
 * The C runtime layer is the backslash-before-quote rule: a run of backslashes
 * is literal, unless it precedes a quote, in which case it must be doubled.
 *
 * The cmd.exe layer is everything cmd treats as syntax rather than text —
 * `& | < > ( ) ^ " ! %`. Each is prefixed with `^`, which cmd strips before
 * the C runtime ever sees the line. Without this, an argument containing `&`
 * would start a second command, and one containing `%PATH%` would be replaced
 * by the value of PATH.
 */
export function escapeForCmd(value) {
  let escaped = String(value);

  // Double any backslashes that precede a quote, then escape the quote.
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
  // Double a trailing run of backslashes, which would otherwise escape the
  // closing quote we are about to add.
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  // Now hide every cmd.exe metacharacter, including the quotes just added.
  escaped = escaped.replace(/[()%!^"<>&|]/g, '^$&');

  return escaped;
}

/**
 * Escape the command itself, which cannot be quoted the way an argument is.
 *
 * `^"` produces a literal quote, not a grouping quote, so quoting a path with
 * spaces would leave cmd.exe looking for a program called `"C:\Program`.
 * Instead every character cmd treats as syntax — the space included — is
 * caret-escaped, which keeps the path a single token.
 */
export function escapeCommandForCmd(value) {
  return String(value).replace(/[()[\]{}%!^"`<>&|;, *?]/g, '^$&');
}

/** The full `cmd.exe /d /s /c` command line for running a batch file. */
export function buildBatchCommandLine(file, args) {
  return [escapeCommandForCmd(file), ...args.map(escapeForCmd)].join(' ');
}

/**
 * Spawn `command` with `args`, never through a shell.
 *
 * Mirrors child_process.spawn, except that a Windows batch file is routed
 * through cmd.exe with the arguments escaped so they arrive unchanged.
 */
export function spawn(command, args = [], options = {}) {
  if (!isWindows) return childSpawn(command, args, options);

  const resolved = resolveCommand(command, { cwd: options.cwd, env: options.env });
  if (resolved === null) {
    // Report this the way a failed spawn does, so callers need no special case.
    const child = childSpawn(command, args, options);
    return child;
  }

  if (!BATCH_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return childSpawn(resolved, args, options);
  }

  return childSpawn(
    'cmd.exe',
    ['/d', '/s', '/c', `"${buildBatchCommandLine(resolved, args)}"`],
    // Node must not re-quote the line we just built by hand.
    { ...options, windowsVerbatimArguments: true },
  );
}
