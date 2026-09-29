# Spec: bare `repown` draws every line inside its frame

## Objective
A manual run in a real terminal showed that bare `repown` picks the right screen, but some
of its lines land outside the frame `@clack/prompts` draws (`│` down the left):

- Outside a clone, on the start screen:
  - The summary goes to stdout with no gutter, followed by a blank line.
  - The `> repown setup --cwd <path>` line is indented to column 7, outside the frame.
  - The start screen's frame is never closed before setup opens its own.
- Inside a clone, the line `This clone isn't set up yet, so repown is starting setup ...`
  (or the pinned variant) is printed before setup's frame opens.

Goal: one frame per screen, with every line of it inside the frame, from both entry points.

## Boundaries
- Always:
  - TDD per task.
  - Layout only. Routing
    ([ADR-021](docs/decisions/ADR-021-bare-repown-always-opens-setup.md),
    [ADR-024](docs/decisions/ADR-024-bare-repown-outside-a-clone-opens-a-start-screen.md)),
    exit codes, what each action runs, and the words themselves are unchanged.
  - The plain prompter shows the same lines, indented two spaces.
  - Typed `repown setup` is unchanged.
  - CLAUDE.md hard rules apply: functions of 20 lines or fewer, 4 params or fewer,
    strip-only TS, and `@clack/prompts` only in `src/wizard/clack.ts`, behind a dynamic import.
- Ask first: changing any wording, or reworking setup's own screens beyond the lead line.
- Never: push; names or emails in the repo.

## Commands
    npm test · npm run build
    node --test test/start.test.ts test/home.test.ts test/wizard-screens.test.ts test/wizard-plain.test.ts test/wizard-clack.test.ts

## Target screens (clack)
Outside a clone:

    ┌  repown · not a clone: /home/octocat/code
    │
    ◇  Reading this folder
    │
    │  Accounts   1 recorded: octocat
    │  Clones     2 below this folder: 2 not set up, 0 set up
    │
    ◇  What next?
    │  Set up a clone found here
    │
    ◇  Which clone?
    │  need
    │
    └  > repown setup --cwd '/home/octocat/code/need'

    ┌  repown setup
    │
    ◇  Reading this clone and this machine

Inside a clone:

    ┌  repown setup
    │
    │  This clone isn't set up yet, so repown is starting setup (repown status shows its settings).
    │
    ◇  Reading this clone and this machine

## Design
- `Prompter.show?(lines)`: lines of information, drawn in the prompter's frame.
  - clack: `p.log.message`, wrapped within the gutter.
  - plain: each line indented two spaces, the same as `note`.
  - Optional; a caller without it falls back to `out.line` or `out.note`.
- The start screen:
  - `row()` loses its leading two spaces, and the summary and the "and N more" line go
    through `show`.
  - A hand-over closes the frame with `outro('> ' + command)` before setup, fix, doctor or
    accounts add runs. Show help does the same with `> repown --help`, then prints the help
    to stdout.
- Inside a clone:
  - `SetupDeps.lead?` is drawn with `show` right after setup's `intro`.
  - `startDefault` prints nothing itself. For setup it returns a runner, which imports
    `setup-run.ts` and calls `runSetup` with the lead.
  - `chooseStart` still returns `'setup'`.

## Scenarios
| # | Given | Then |
| --- | --- | --- |
| F1 | start screen, clack | every Accounts/Clones line starts with the gutter `│` |
| F2 | start screen, clack | no empty line between the summary and `What next?` |
| F3 | pick a clone | `└  > repown setup --cwd <path>` is drawn before setup's `┌  repown setup` |
| F4 | Show help | the frame closes on `> repown --help` before the help on stdout; exit 0 |
| F5 | bare repown in an unpinned clone | the "isn't set up yet" line is after `┌  repown setup`, in the gutter; nothing on stderr before the `┌` |
| F6 | bare repown in a pinned clone | the same for "Starting setup to check this clone" |
| F7 | plain prompter | the summary and lead lines are indented two spaces |
| F8 | typed `repown setup` | no lead line |

## Success criteria
- F1-F8 pass, `npm test` and `npm run build` are green, and existing scenarios H1-H14 and
  S1-S4 keep their meaning.
- A manual run in a real terminal matches the target screens, both in a folder of clones
  and inside a clone.

## Open questions
- None.
