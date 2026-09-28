# ADR-021: Bare repown always opens setup in a terminal

**Status:** Accepted; its note that status and doctor stay unchanged is superseded in part by [ADR-023](ADR-023-status-and-doctor-say-what-matters-first.md)

## Context

A pinned clone ran bare `repown` and got status, which said the clone was
ready. The next `git push` failed with git's own `The current branch <b> has
no upstream branch`. Setup would have offered `push.autoSetupRemote` in this
clone ([ADR-020](ADR-020-setup-leaves-clone-ready.md)), but it never opened:
[ADR-018](ADR-018-bare-repown-guides-new-clones.md) started setup only when
`identityProblems` was not empty, and a pin with no local auto-upstream is
not an identity FAIL.

The user decided: **bare `repown` triggers the wizard. `repown status` and
`repown doctor` stay exactly as they are** (no new warnings, and the closing
line is unchanged).

## Decision

- **Bare `repown`, with no arguments at all, starts setup whenever stdin,
  stdout and stderr are all terminals, in any clone.** Pinned or not. A clone
  with nothing left to do lands on setup's existing "This clone is already set
  up" screen, which lists what was checked and any optional offer. A pinned
  clone missing auto-upstream gets the normal review, with `Push new branches
  without -u` in the plan (Recommended answers Yes). The same terminal test as
  ADR-018 still applies: setup also requires stdout to be a terminal, so
  `repown > report.txt` or `repown | tee report.txt` still prints status.
  `src/commands/start.ts` then reads the working directory (`inspectRepo`) once
  and:
  - starts `repown setup` when stdout is a terminal, after one stderr line:
    - unpinned (`identityProblems` not empty): `This clone isn't set up yet,
      so repown is starting setup (repown status shows its settings).`
    - pinned: `Starting setup to check this clone (repown status shows its
      settings without asking anything).`
  - prints the top help, and exits 0, when the directory isn't a clone,
    including a bare repository, as ADR-018 already does;
  - prints status otherwise.
- **Without a terminal, or with stdout redirected, it is always status, with
  status's exit codes.** Unchanged from ADR-018. Setup with no terminal exits 2
  ([ADR-016](ADR-016-clack-for-the-setup-wizard.md)); this path never starts it.
- **Any argument bypasses the choice.** Unchanged from ADR-018.
  `repown status`, `repown doctor`, `repown --cwd <dir>`, `--help` and
  `--version` run as typed.
- **Status, doctor, and setup's questions and flags are unchanged.** gh as the
  credential helper, a drifted record, the guard off, or gh active as another
  account still print status when `repown status` is typed, or when there is
  no terminal. They do not gain a new warning. Setup's settled path still
  exits 0.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Route only when a step is left | The user wants one entry point. The settled screen already says when nothing is left, including the optional auto-upstream offer. |
| A status warning for missing auto-upstream | Status and doctor stay intact. The closing line is unchanged. Setup already asks and lists that step. |
| Keep ADR-018's identity-FAIL router | That is the bug: a pin with no auto-upstream looked ready, then `git push` failed. |

## Consequences

- **In a terminal, a pinned clone no longer prints status from bare `repown`.**
  `repown status` still does. The help summary for status says so
  (`bare repown when output isn't a terminal`). Scripts, CI, and
  `repown > file` are unchanged.
- **ADR-018's routing bullet is superseded in part.** Its terminal test, the
  help path outside a clone, and "any argument runs as typed" still hold. Its
  Status line records the supersession; its body is not rewritten.
- **One extra repository read before routing,** and only in a terminal, as
  before. The chooser calls `inspectRepo` once, then setup reads the clone
  again. Without a terminal the chooser returns before that read.
