# Spec: bare `repown` guides a new clone; `repown status` explains itself

## Objective
Bare `repown` sends a newcomer into the wizard when their clone isn't set up, and never
changes behaviour for scripts. `repown status` says what it describes, where each value
comes from (this clone or this machine), and what to run next.

## Boundaries
- Always: TDD per task; with no terminal, bare `repown` is `repown status` and exits 0/1
  as today (its stdout carries the same facts, under headings); `repown status` never
  prompts; a registry that can't be read is reported, never skipped (a `Result`);
  CLAUDE.md hard rules (functions ≤20 lines, ≤4 params, strip-only TS, only
  `src/core/exec.ts` spawns, only `octocat`, `octo-org`, `octo-work`,
  `*.example.invalid`).
- Ask first: anything that changes `doctor`, `use`, `guard`, `fix` or setup's questions;
  any new exit code.
- Never: run the wizard without a terminal; route when any argument or flag was typed
  (`repown --cwd x` stays status); push.

"Set up" means status reports no identity FAIL: `identityProblems(repo)` in
src/commands/status.ts is empty. gh as the credential helper alone doesn't count; that
FAIL already points to `repown fix`.

## Commands
    npm test · npm run build
    node --test test/status.test.ts test/start.test.ts

## Success criteria
Every scenario below is asserted by a test, and `npm run build` and `npm test` pass.

## Scenarios
| # | Situation | Planned |
|---|---|---|
| S1 | `repown`, terminal, clone not set up | stderr: "This clone isn't set up yet, so repown is starting setup (repown status shows its settings)", then the wizard, with `repown setup`'s exit codes |
| S2 | `repown`, terminal, clone set up | the enriched status (S6-S9) |
| S3 | `repown`, no terminal, or output redirected | status; exit codes and facts unchanged, only the layout is new |
| S4 | `repown`, terminal, not a clone | the top help, exit 0 |
| S5 | `repown --cwd <dir>` or any other argument | status, as today (no routing) |
| S6 | `repown status` | title `repown status · current settings of this clone`, then the clone's path and branch (a detached HEAD shows its short hash) |
| S7 | fields grouped | "This clone": commits as, pushes as, account, origin, push guard. "This machine": default (what an unpinned clone inherits), helper, gh active |
| S8 | `account` field | pinned, recorded, name/email match: `octocat (recorded)`; mismatch: `octocat (recorded as <name> <email>)` plus a WARN, fix `repown use octocat`; not recorded: `octocat (not in this machine's registry)`; not pinned: `not pinned (recorded: octocat, octo-work)` or `not pinned (none recorded)`; unreadable registry: `registry could not be read: <why>` |
| S9 | failure pointers | an identity FAIL's fix reads `repown setup   (or: repown use <account>)`; a closing stderr line `N problem(s), M warning(s)`, plus `: run repown setup` when an identity FAIL is among them; a clean run prints none |
| S10 | `repown status` outside a clone | unchanged: `Not a git repository`, exit 1 |
| S11 | `repown`, a bare repository | the same as not a clone: the help and exit 0 in a terminal (S4), status and exit 1 otherwise (S3) |
| S12 | the account registry cannot be read | a WARN, included in the closing count; the field stays `registry could not be read: <why>`; not an identity problem, so no routing to setup and the exit code is unchanged |

## Open questions
None.
