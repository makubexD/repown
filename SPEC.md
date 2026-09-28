# Spec: bare `repown` outside a clone opens a start screen

## Objective
Someone who has read no docs runs `repown` somewhere that isn't a clone (their home folder,
a projects folder) and is guided. repown reads the machine and the clones below, says what
it found, and offers the next step. Setting up a clone it found goes straight into the
existing setup wizard in that clone. Today that case prints the top help
([ADR-018](docs/decisions/ADR-018-bare-repown-guides-new-clones.md), kept by
[ADR-021](docs/decisions/ADR-021-bare-repown-always-opens-setup.md)).

## Boundaries
- Always: TDD per task. The start screen is read-only until the user picks an action.
  Every action runs that command's own `run()` and prints the command it stands for. Bare
  `repown` with no terminal (status), with stdout redirected (help outside a clone, status
  inside), and inside a clone (setup) is unchanged. So are `repown --help`, `repown help`
  and every command's output, prompts and exit codes (test/characterization.test.ts stays
  green). CLAUDE.md hard rules apply: functions of 20 lines or fewer, 4 params or fewer,
  strip-only TS, spawns only through `src/core/exec.ts`, and `@clack/prompts` only via
  `src/wizard/clack.ts` behind a dynamic import.
- Ask first: changing `scan`'s own walk or output, or adding a new command or option.
- Never: push; names or emails in the repo; loading the start screen's modules from
  `guard check` or from any typed command.

## Commands
    npm test · npm run build
    node --test test/start.test.ts test/home.test.ts test/wizard-screens.test.ts

## Behaviour
| Where | Bare `repown` does |
| --- | --- |
| stdin, stdout and stderr are terminals, inside a clone | setup (unchanged, ADR-021) |
| the same terminals, outside a clone or in a bare repository | **the start screen** |
| stdin and stderr terminals, stdout redirected, outside a clone | top help, exit 0 (unchanged) |
| stdin or stderr not a terminal | status (unchanged; exit 1 outside a clone) |

The start screen is a summary, then one menu:

    repown · not a clone: C:\Users\octocat

      Accounts   2 recorded: octocat, octo-work
      Helper     gh serves git's credentials: run repown fix
      Clones     3 below this folder: 2 not set up, 1 set up

    ? What next?
      > Set up a clone found here (2 not set up)
        Stop gh serving credentials (repown fix)
        Record an account (repown accounts add)
        Check this machine (repown doctor)
        Show help
        Quit

- **Summary.** Accounts come from the registry. The helper line appears only when gh is
  git's credential helper, detected the way `fix`'s preview does. The clones line counts
  what discovery found below cwd; "set up" means `identityProblems(repo)` is empty.
  A registry that can't be read says `could not read <path>`, never `none`.
- **Discovery.** Reuse scan's `discover` (exported) at depth 2. The start screen skips
  dot-directories, `node_modules`, and on Windows `AppData`. Only the start screen adds
  those skips; `repown scan` is unchanged. Unreadable directories are skipped silently here;
  `scan` stays the command that reports them. `busy()` shows while reading. At most 20
  clones are listed, then `and N more: repown scan`.
- **Set up a clone found here.** A list of the clones found (not set up first, then set up),
  each as its path relative to cwd with a short state. Picking one prints
  `> repown setup --cwd <path>` and runs setup's own `runSetup` in that clone, with the same
  prompter. Its exit code is repown's. `← Back` returns to the menu.
- **Stop gh serving credentials**: shown only when gh is the helper. Runs `fix`'s `run()`,
  which asks its own confirmation.
- **Record an account**: runs `accounts add`, asking for the login first.
- **Check this machine**: runs `doctor`'s `run()`.
- **Show help**: prints the top help, exit 0. **Quit** exits 0. Esc or Ctrl-C exits 130,
  the same cancel setup uses. Neither changes anything.
- **No clones found**: the clones line says `none below this folder (2 levels)`, and the menu
  shows a note: `cd into a clone (or git clone one), then run repown`.
- **Routing.** `Program.chooseDefault` may return a runner (`() => Promise<number>`) as
  well as a command name or `'help'`. Dispatch runs the runner and uses its exit code, so
  dispatch stays generic for `scripts/release.ts`. `start.ts` returns a runner that
  dynamically imports `src/wizard/home-run.ts`.

## Success criteria
- Every scenario below is a test: routing in test/start.test.ts, the pure context and flow
  in test/home.test.ts, and the screens with keystrokes in test/wizard-screens.test.ts
  (`play()`).
- After Quit, the sandbox's global and local config and the registry are byte-identical.
- `npm run build` is clean, and docs.test passes after the docs sweep.

## Scenarios
| # | Situation | Expected |
|---|---|---|
| H1 | Terminal, not a clone | `chooseStart` → home runner (was `'help'`) |
| H2 | Terminal, bare repository | home runner (was `'help'`) |
| H3 | stdout redirected, not a clone | `'help'` (unchanged) |
| H4 | No terminal, not a clone | `'status'` (unchanged) |
| H5 | Two clones below, one pinned, one not | Clones: 2 below, 1 not set up, 1 set up; the not-set-up one is listed first |
| H6 | No clones below | Clones line says none; the cd note shows; no "Set up a clone" item |
| H7 | gh is the credential helper | Helper line and the fix item appear; they are absent otherwise |
| H8 | Registry unreadable | Accounts: could not read <path>; menu still works |
| H9 | Clones in `.hidden/`, `node_modules/`, depth 3 | Not found (depth 2, skips) |
| H10 | 25 clones below | 20 listed + `and 5 more: repown scan` |
| H11 | Pick "Set up a clone", pick one | `> repown setup --cwd <path>` printed, then setup's first screen in that clone |
| H12 | "Set up a clone", then ← Back | Back at the menu |
| H13 | Show help | Top help printed, exit 0 |
| H14 | Quit / Esc | Quit exits 0; Esc or Ctrl-C exits 130. Config and registry unchanged |

## Open questions
- Should "Record an account" start setup's account questions instead of `accounts add`?
  Default for now: `accounts add`, which is what setup runs too.
