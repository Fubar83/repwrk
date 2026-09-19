export const USAGE = `repwrk — work across many repositories at once

Usage:
  repwrk clone [--owner <owner>] [--filter <glob>] [--branch <branch>] [--no-confirm]
  repwrk foreach [--at <glob>] [--parallel] [--] [command] [arguments...]

Commands:
  clone      Clone repositories into the current directory
  foreach    List repositories or targets, or run a command in each

Run \`repwrk <command> --help\` for the options of a command.`;

export const CLONE_USAGE = `repwrk clone — clone repositories into the current directory

Usage:
  repwrk clone [--owner <owner>] [--filter <glob>] [--branch <branch>] [--no-confirm]

Options:
  --owner <owner>     User or organisation to clone from. Defaults to the
                      account gh is authenticated as.
  --filter <glob>     Only clone repositories whose name matches this glob
  --branch <branch>   Create or check out this branch in newly cloned
                      repositories. Repositories that already exist locally
                      are skipped and never have their git state changed;
                      any of them not on the branch is reported.
  --no-confirm        Clone without asking for confirmation first
  --help              Show this help

Clone lists the repositories it selected and asks before cloning them.
Repositories that already exist locally are skipped, never overwritten.`;

export const FOREACH_USAGE = `repwrk foreach — list or run a command across repositories

Usage:
  repwrk foreach [--at <glob>] [--parallel] [--] [command] [arguments...]

Options:
  --at <glob>         Execute at every path matching this glob inside each
                      repository, instead of at the repository root
  --parallel          Execute concurrently; requires a command
  --                  Optional end-of-options marker
  --help              Show this help

  repwrk foreach                        list repositories
  repwrk foreach --at <glob>            list targets
  repwrk foreach <command>              run at repository roots
  repwrk foreach --at <glob> <command>  run at discovered targets

With no command, repwrk lists what it would work on and starts nothing.
The first non-option argument is the command; everything after it is passed
to that command unchanged.`;

export const FOREACH_HINT = `Usage:
  repwrk foreach [--at <glob>] [--parallel] [--] [command] [arguments...]`;

export const CLONE_HINT = `Usage:
  repwrk clone [--owner <owner>] [--filter <glob>] [--branch <branch>] [--no-confirm]`;
