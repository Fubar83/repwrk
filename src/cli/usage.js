/**
 * Every option is spelled both ways wherever it appears — in the synopsis as
 * `-o|--owner`, in the options list as `-o, --owner`. A synopsis that shows
 * only one of them makes the other look unsupported, and which half gets
 * shown is exactly the thing nobody can remember.
 */

export const USAGE = `repwrk — work across many repositories at once

Usage:
  repwrk clone [-o|--owner <owner>] [-t|--team <team>] [-f|--filter <glob>]...
               [-l|--language <lang>]... [-b|--branch <branch>] [--no-confirm]
  repwrk foreach [-a|--at <glob>] [-p|--parallel] [--] [command] [arguments...]

Commands:
  clone      Clone repositories into the current directory
  foreach    List repositories or targets, or run a command in each

Run \`repwrk <command> --help\` for the options of a command.`;

export const CLONE_USAGE = `repwrk clone — clone repositories into the current directory

Usage:
  repwrk clone [-o|--owner <owner>] [-t|--team <team>] [-f|--filter <glob>]...
               [-l|--language <lang>]... [-b|--branch <branch>] [--no-confirm]

Options:
  -o, --owner <owner>     User or organisation to clone from. Defaults to
                          the account gh is authenticated as.
  -t, --team <team>       Only repositories this team can reach, by its URL
                          slug. Needs --owner, and a token with the read:org
                          scope. In a large organisation this is also much
                          the fastest way to select: GitHub applies it
                          itself, so only the team's repositories are listed.
  -f, --filter <glob>     Only clone repositories whose name matches this
                          glob. Repeatable, and repeats are OR-ed:
                            -f 'companyA*' -f '*packages.internal*'
                          A glob containing a slash is matched against
                          owner/name.
  -l, --language <lang>   Only repositories whose primary language matches
                          this glob, case-insensitively. Repeatable and
                          OR-ed, so -l C# -l 'Type*' keeps either. Combined
                          with --filter as AND: both must hold.
  -b, --branch <branch>   Create or check out this branch in newly cloned
                          repositories. Repositories that already exist
                          locally are skipped and never have their git state
                          changed; any of them not on the branch is reported.
      --no-confirm        Clone without asking for confirmation first. No
                          one-letter form on purpose: -y would not say what
                          is being agreed to.
  -h, --help              Show this help

The listing is fetched a page at a time, with progress on stderr; it is
complete, so a filter never silently misses repositories behind a limit.

Clone lists the repositories it selected and asks before cloning them.
Repositories that already exist locally are skipped, never overwritten.`;

export const FOREACH_USAGE = `repwrk foreach — list or run a command across repositories

Usage:
  repwrk foreach [-a|--at <glob>] [-p|--parallel] [--] [command] [arguments...]

Options:
  -a, --at <glob>   Execute at every path matching this glob inside each
                    repository, instead of at the repository root
  -p, --parallel    Execute concurrently; requires a command. Output is held
                    until each finishes, and commands are given no stdin, so
                    nothing that prompts belongs here
      --            Optional end-of-options marker
  -h, --help        Show this help

  repwrk foreach                        list repositories
  repwrk foreach --at <glob>            list targets
  repwrk foreach <command>              run at repository roots
  repwrk foreach --at <glob> <command>  run at discovered targets

With no command, repwrk lists what it would work on and starts nothing.
The first non-option argument is the command; everything after it is passed
to that command unchanged — so a one-letter option after the command is the
command's, not repwrk's.`;

export const FOREACH_HINT = `Usage:
  repwrk foreach [-a|--at <glob>] [-p|--parallel] [--] [command] [arguments...]`;

export const CLONE_HINT = `Usage:
  repwrk clone [-o|--owner <owner>] [-t|--team <team>] [-f|--filter <glob>]...
               [-l|--language <lang>]... [-b|--branch <branch>] [--no-confirm]`;
