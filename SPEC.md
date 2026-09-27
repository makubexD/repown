# Spec: setup leaves the clone ready to work

## Objective
Run `repown setup` once and the clone is ready: commits, the first push of a new branch,
and the guard all work without another command. Setup shows what it will do before it
runs and what it changed afterwards. A step-by-step mode explains and confirms each
change. An account from an earlier setup is switched to with no questions. Status says
"ready" when nothing blocks work, and labels gh advice as optional.
Decision record: [ADR-020](docs/decisions/ADR-020-setup-leaves-clone-ready.md).

## Boundaries
- Always: TDD per task; CLAUDE.md hard rules; `--no-input` keeps its meaning (an
  unanswered question is No); `--format json` fields unchanged (ADR-014); exit codes
  unchanged; the guard's decisions unchanged (ADR-011).
- Ask first: anything that writes global or system git config, or changes `use`,
  `guard` or `fix` output beyond what a task names.
- Never: push; answer a browser sign-in or a whole-machine change for the user
  (ADR-013, ADR-019); store a setup preference (ADR-007); names or emails in the repo.

## Commands
    npm test · npm run build
    node --test test/wizard-screens.test.ts   # the scenarios below, replayed with keystrokes
    node src/cli.ts setup [--step-by-step] [--auto-upstream]

## Success criteria
- Every scenario below has a test (status: `test/status.test.ts`; setup:
  `test/wizard-setup.test.ts` and, for screens, `test/wizard-screens.test.ts`).
- In a clone set up in Recommended mode on git 2.37+, `git push` of a new branch succeeds
  without `-u` (manual check in a scratch clone), and the guard still runs.
- `npm run build` and `npm test` pass after every task; docs.test.ts covers the new flags.

## Scenarios
| # | Situation | Today | Planned |
|---|---|---|---|
| S1 | Pinned clone, branch with no upstream, `push.autoSetupRemote` unset | Nothing said; `git push` fails with git's "no upstream branch" | Status field `upstream   none yet: git push -u origin <branch>` (not counted as a warning) |
| S2 | Branch tracks `origin/<b>` | Nothing | `upstream   origin/<b>` |
| S3 | `push.autoSetupRemote=true` (any scope) and no upstream | Nothing | `upstream   set on the first push (push.autoSetupRemote)` |
| S4 | Detached HEAD, or no remote | Nothing | No `upstream` field |
| S5 | No problems, only gh warnings | `1 warning` | `ready: commits and pushes use <account> · 1 warning (optional: gh)`. Where credential keys are empty: `ready: commits use <account>; pushes use this host's own sign-in`, with the same warning suffix |
| S6 | No problems, a non-gh warning (e.g. guard off) | `1 warning` | `ready: commits and pushes use <account> · 1 warning` where credentials are pinned; the unpinned form from S5 otherwise |
| S7 | A problem (FAIL) | `1 problem: run repown setup` | Unchanged; no `ready:` |
| S8 | Setup, git ≥ 2.37, autoSetupRemote not effectively true | Not offered | Question `Push new branches without -u?` (default Yes); plans `git config --local push.autoSetupRemote true` |
| S9 | Setup, git < 2.37 or version unreadable | Not offered | Not asked; review note: `the first push of a new branch needs: git push -u origin <branch>` |
| S10 | Setup, autoSetupRemote already effectively true | — | Not asked, not planned |
| S11 | Setup starts (interactive) | First question is the account | First question `How should setup work?`: Recommended (default) / Step by step |
| S12 | Recommended, recorded account, gh lists it but another is active | gh, allowOwner, guard asked | Asks only the account; gh switch, guard and upstream take their recommended values and show in the review. allowOwner (origin owned by someone else) is still asked (ADR-004) |
| S13 | Recommended, gh doesn't list the account (sign-in would open a browser) | Asked | Still asked (default No) |
| S14 | Recommended, gh is git's helper (`fix`, whole machine) | Asked | Still asked (default No) |
| S15 | `repown setup <recorded>` in Recommended mode | Asks gh/allowOwner/guard as needed | No question before the review, except allowOwner when origin belongs to someone else (default Yes) |
| S16 | Step by step, Run | Every step runs after one confirmation | Before each step: what it changes (config keys and values, or the gh action), why, the command; `Run this step?` Yes / Skip / Stop. Skip leaves that step's keys unchanged; Stop runs nothing more |
| S17 | `--step-by-step --no-input` | — | Usage error (exit 2): step by step needs a terminal |
| S18 | After any run, including skips, Stop, a failed step, and Apply again | `done:` and `check it any time:` | Plus `changed in this clone:` with `key: old -> new`, `(added)`, or `old -> (removed)`; allowOwner lists added or removed values; `push guard: off -> on`. `nothing changed in this clone` when the clone is unchanged. `use --gh` that leaves the account active: `gh: <a> is now gh's active account (every terminal)`, under `changed on this machine:` with `this machine's account registry: added <a>` when an account was recorded |
| S19 | Pinning to an address when unpushed commits on the current branch carry another author or committer | Nothing; the guard later refuses the push | Review note (setup) and warning (`use`): `N commits on <branch> not on any remote are by <addresses>; the guard will refuse them`, then `re-author it` or `re-author them`: `git rebase <base> --exec "git commit --amend --no-edit --reset-author"` (`--root` when that commit has no parent), or pin that address. No rebase command when the log cannot be read |
| S20 | `--auto-upstream` given | — | Answers S8's question Yes; with `--no-input`, unanswered stays No |

## Open questions
None.
