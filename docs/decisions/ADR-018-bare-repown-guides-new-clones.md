# ADR-018: Bare repown guides a clone that isn't set up; scripts still get status

**Status:** Accepted

## Context

Bare `repown` printed status. On a clone that wasn't set up, that was a table of fields
and a FAIL whose fix was `repown use <account>`. The fix needs an account name, which a
newcomer may not know, and `repown setup`, the command that asks for it, had to be
discovered.

Status didn't say what the report described, or which values came from the clone and
which from the machine. One list held who commits, who pushes, origin, the helper, gh's
active account and the guard. The machine's default identity, what an unpinned clone
inherits, was absent. So was whether this clone's account is one the machine has
recorded.

"Not set up" is an identity FAIL: no local name or email, so the next commit inherits
the machine, or a GitHub https clone with no push account pinned. Those are the FAILs
[ADR-011](ADR-011-refuse-vs-warn.md) already assigns to `repown` rather than to the
guard. gh as the credential helper is a FAIL of its own, and its fix is `repown fix`.

## Decision

- **Bare `repown`, with no arguments at all, starts setup only when stdin, stdout
  and stderr are all terminals.** A terminal means stdin and stderr are both
  terminals, the same test `repown setup` uses before it will ask a question.
  Setup also requires stdout to be a terminal, so `repown > report.txt` or
  `repown | tee report.txt` still prints status. `src/commands/start.ts` then
  reads the working directory (`inspectRepo`) and:
  - starts `repown setup` when stdout is a terminal and `identityProblems` is not
    empty, which is when status would report an identity FAIL, after one stderr
    line saying setup is starting and that `repown status` shows the settings;
  - prints the top help, and exits 0, when the directory isn't a clone. A bare
    repository is not a clone: `git rev-parse --is-bare-repository` is true, and
    there is no work tree to pin a commit identity in. That help still prints when
    stdout is redirected; only a missing terminal (stdin or stderr) sends the
    directory to status;
  - prints status otherwise.
- **Without a terminal, or with stdout redirected, it is always status, with
  status's exit codes.** 0 when there is no FAIL, including when the only lines
  are warnings; 1 on a FAIL, including `Not a git repository` outside a clone. A
  script, a CI job or an alias that runs `repown` still gets that report.
  Setup with no terminal exits 2
  ([ADR-016](ADR-016-clack-for-the-setup-wizard.md)); this path never starts it.
- **Any argument bypasses the choice.** Dispatch calls `chooseDefault` only for an empty
  argument list (`src/ui/dispatch.ts`). `repown status`, `repown --cwd <dir>`, `--help`
  and `--version` run as typed. The chooser is loaded only for that empty list, so a
  program that doesn't set `chooseDefault`, the release tool, is unchanged.
- **gh as the credential helper, alone, stays on status.** It is not an identity FAIL.
  Status still reports it, and the fix line stays `repown fix`. A warning doesn't route
  either: a drifted record, the guard off, or gh active as another account still prints
  status.
- **Status says what it shows, and which side each value comes from.** The title is
  `repown status · current settings of this clone`, then the clone's path and branch. A
  detached HEAD shows its short hash. `rev-parse --short` still names a commit,
  including one of forty zeros, so the place line has no separate unknown label.
  **This clone:** commits as, pushes as, account, origin, push guard. **This machine:** default (what an unpinned clone inherits: the effective
  name and email, system config and conditional includes included, when this clone
  sets neither local name nor email; otherwise global, falling back to system;
  `none` when that is unset), helper, gh active.
  The account field says the account is recorded; recorded under another name or email,
  plus a warning whose fix is `repown use <account>`; not in this machine's registry; or
  not pinned, listing what is recorded. A registry that can't be read is reported in
  that field (`registry could not be read: <why>`) and as one warning, counted in the
  closing tally, pointing at `repown accounts list`. That report is not an identity
  FAIL, so it doesn't start setup. An identity FAIL's fix points at `repown setup`
  (or `repown use <account>`). A run with
  any problem or warning ends with a count on stderr of whichever are present
  (`1 problem`, `2 warnings`, or `1 problem, 2 warnings`), and adds `: run repown setup`
  when an identity FAIL is among them. A clean run prints no count. Status's own exit
  codes are unchanged, and outside a clone it still prints `Not a git repository` and
  exits 1.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Bare `repown` is always setup | Breaks scripts that read status. Setup without a terminal exits 2 ([ADR-016](ADR-016-clack-for-the-setup-wizard.md)). |
| Status, then offer "Set up now? (Y/n)" | A prompt inside a report command, and `repown status` must never prompt. |
| A flag or env var to opt in | A newcomer wouldn't know to set it. |
| Route on any FAIL, including gh as helper | Setup's first question is the account, not the helper. `repown fix` is the direct fix. |

## Consequences

- **Behaviour differs by terminal, and by whether stdout is a terminal.** The top
  help, the [README](../../README.md#commands) commands table and
  [HOW-IT-WORKS card 5](../HOW-IT-WORKS.md#5-check-where-you-are) say so. One exit
  code changes, and only in a terminal: a directory that isn't a clone, including a
  bare repository, prints help and exits 0, where status would have exited 1.
  Without a terminal, or with stdout redirected, that case is still status, exit 1.
  An unset clone whose stdout is redirected prints status and does not start setup.
- **An unreadable account registry is a warning.** It is counted with the other
  warnings. It does not change the exit code and it does not start setup. The
  account field still says the registry could not be read, so it cannot be read as
  "none recorded".
- **The status text layout changed.** Text isn't a contract
  ([ADR-014](ADR-014-json-for-scripts.md)). `repown status` has no `--format json`. That
  flag exists only on `scan` and `accounts list`, and neither changed. A script's
  answer from status is still the exit code.
- **One extra repository read before routing,** and only in a terminal. The chooser
  calls `inspectRepo`, then status or setup reads the clone again. Without a terminal
  the chooser returns before that read.
