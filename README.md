# repwrk

Work across many repositories at once. Clone a set of them into a folder, then run commands across all of them.

A workspace is just a directory holding clones. There is no config file, no state file, and no workspace registry — `repwrk` reads the directory each time it runs.

```console
$ repwrk clone --owner my-org --filter "customer-*" --branch feature/customer-permissions
$ repwrk foreach
customer-api
customer-web
$ repwrk foreach --parallel dotnet test
```

## Requirements

- [GitHub CLI](https://cli.github.com) (`gh`) on `PATH`, authenticated with `gh auth login` — for `clone`
- `git` on `PATH`
- Node.js 22 or newer

## Install

```bash
npm install -g @fubar83/repwrk
```

## The whole parameter surface

```
repwrk clone
  --owner <owner>
  --filter <glob>
  --branch <branch>
  --yes

repwrk foreach
  --at <glob>
  --parallel
  -- [optional]
  <command>
  [arguments...]
```

That is deliberately all of it. There are no parameters for workspace paths, repository paths, concurrency counts, project types, package managers, git state manipulation, config files, agents or task definitions.

## `repwrk clone`

Clones repositories into the current directory.

```bash
repwrk clone                                       # your own repositories
repwrk clone --owner my-org                        # everything in an organisation
repwrk clone --owner my-org --filter "customer-*"  # matching names only
repwrk clone --owner my-org --filter "customer-*" --branch feature/foo
repwrk clone --owner my-org --filter "customer-*" --yes
```

**`--owner <owner>`** is the user or organisation to clone from. Omitted, the scope is the account `gh` is authenticated as — `gh` has no default-organisation setting to fall back on, so working with an organisation means naming it.

```bash
repwrk clone --owner my-org --filter "customer-*"
```

Archived repositories are never in scope.

**`--filter <glob>`** applies to repository *names*, anchored and case-insensitive: `customer-*` matches `customer-api` but not `old-customer-api`. It does not affect local directory matching. Omitted, every repository in scope is selected.

**`--branch <branch>`** creates or checks out the branch in repositories **cloned by this invocation**. A repository that already exists locally is skipped and its git state is never modified — not its branch, not its working tree. The branch name is validated by `git check-ref-format` before any cloning, so a typo fails in a second rather than after thirty clones. A branch that already exists on the remote is checked out and tracked rather than recreated, so two machines don't start parallel histories under one name.

**`--yes`** skips the confirmation when the current directory contains files or directories that are not repositories. Adding clones to a directory of clones is the ordinary case and never prompts. Cloning into a directory holding anything else asks first, because that may not be where you meant to put thirty repositories. `--yes` does not override any other safety check, and nothing ever overwrites an existing directory.

## `repwrk foreach`

Discovers repositories and optionally runs a command across them.

```
repwrk foreach                        → list repositories
repwrk foreach --at <glob>            → list targets
repwrk foreach <command>              → execute at repository roots
repwrk foreach --at <glob> <command>  → execute at discovered targets
repwrk foreach --parallel <command>   → execute concurrently
```

### Listing

With no command, `foreach` lists what it would work on and starts nothing. Zero matches is not an error.

```console
$ repwrk foreach
api
web
infrastructure

$ repwrk foreach --at "**/*lambda/package.json"
api/services/bar-lambda
api/services/foo-lambda
web/functions/foo-lambda
```

Only direct child repositories are included, and the order is deterministic. That listing is the way to check what a command would hit before running it.

### Executing

```bash
repwrk foreach dotnet test
repwrk foreach git status --short
```

Each repository root is the working directory. The command is executed **directly, not through a shell**. Any failure makes the overall exit code non-zero, and every repository still gets its turn.

On Windows, `npm`, `pnpm` and `yarn` are `.cmd` batch files rather than executables, and a batch file can only be interpreted by `cmd.exe`. repwrk resolves the command through `PATH` and `PATHEXT` itself and, for a batch file, escapes the whole command line so that every argument survives `cmd.exe` and arrives exactly as written — `git log --author="John Doe"` and `--pretty=%s [%an]` included. No shell is involved for anything else, and none of this is visible from the outside: the same command line behaves the same on every platform.

### `--at <glob>`

Moves the unit of work from the repository root to paths inside each repository — what you want when a repository holds many projects.

```bash
repwrk foreach --at "**/*lambda" pnpm test
repwrk foreach --at "**/*lambda/package.json" pnpm audit
```

- The glob is evaluated independently per repository, relative to its root.
- A matching **directory** becomes a target; a matching **file** makes the directory holding it the target. So `**/*lambda/package.json` runs in the lambda directories, addressed by the file that identifies them.
- Zero, one or many targets per repository are all fine.
- Targets are deduplicated — two matches in one directory are one target.
- **Git ignore rules are respected.** Targets come from what git considers part of the repository, so anything in `.gitignore` is invisible. `node_modules` is skipped because the repository says so, not because this tool has opinions about it.
- Targets outside the repository are rejected.

### `--parallel`

```bash
repwrk foreach --parallel dotnet test
repwrk foreach --parallel --at "**/*lambda" pnpm test
```

Concurrency is bounded — never an unbounded number of processes — and there is no knob for it. Each target's output is held until it finishes and then printed under a header naming it, so output always identifies where it came from instead of interleaving. Every execution is allowed to finish even after an earlier one fails, and the overall exit code is non-zero if any did.

`--parallel` requires a command, so both of these are errors:

```console
$ repwrk foreach --parallel
error: --parallel requires a command

$ repwrk foreach --parallel --at "**/*lambda"
error: --parallel requires a command
```

## Option parsing

repwrk options come first. **The first non-option argument is the command**, and everything after it belongs to the command.

```bash
repwrk foreach --parallel pnpm audit --fix
#              ^^^^^^^^^^ repwrk's    ^^^^^ pnpm's
```

Once the command has started, repwrk stops parsing options:

```bash
repwrk foreach pnpm audit --parallel
#                        ^^^^^^^^^^ passed to pnpm; not a repwrk option
```

Command arguments are never interpreted or rewritten, and nothing goes through a shell that could re-split or re-glob them — `repwrk foreach git log --author="John Doe"` reaches git exactly as written.

An option repwrk does not recognise is an **error**, never something handed to the command, so a typo cannot quietly run the command without the option:

```console
$ repwrk foreach --paralel dotnet test
error: unknown option '--paralel'
```

`--` may end repwrk's options explicitly, but is never required:

```bash
repwrk foreach --parallel -- pnpm test
```

Parsing happens before anything else: a command line that cannot be understood discovers no repositories and starts no child process. Whether the command *exists* is not a parsing question — it is reported when execution begins:

```console
$ repwrk foreach made-up-command
error [api]: command not found: made-up-command
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success — including listing, and including matching nothing |
| `1` | Runtime failure: a command failed, a clone failed, a branch could not be created |
| `2` | Usage error: unknown option or command, a missing option value, `--parallel` without a command |

## Development

```bash
npm test
```

The parser tests are written from the specification's own examples, one test per rule. Workspace, branch and clone behaviour is tested against real temporary git repositories rather than mocks. Nothing in the suite touches the network.

## Licence

MIT
