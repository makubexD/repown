# ADR-028: The start screen returns to its menu after a machine-level action

**Status:** Accepted. Supersedes in part [ADR-024](ADR-024-bare-repown-outside-a-clone-opens-a-start-screen.md):
what happens after an action.

## Context

ADR-024 made every start-screen action an existing command's own `run()`, and the
screen ended with that command. A user recorded an account, saw `OK accounts …`, and
had to run `repown` again to see it in the summary, or to record a second one. The
machine-level actions (record an account, check this machine, stop gh serving
credentials) are often done in a row, and none of them leaves the folder or hands the
terminal to another flow.

In the same change, Record an account began asking setup's own new-account questions
in the frame (login, host, name, email) and running `accounts add` with every answer as
a flag. Its closing `OK` and `Use it in any clone` lines are `accounts add`'s own, as
before.

## Decision

- **After Record an account, Check this machine or Stop gh serving credentials, the
  start screen opens again**: a new frame, the folder read afresh (so the summary shows
  the new account, or gh no longer serving credentials), and the menu.
- **Set up a clone found here, Show help and Quit still end the screen.** Setup is its own
  flow with its own ending, and help is for reading.
- **Quit exits 0, Esc and Ctrl-C exit 130,** as before. An action that failed has already
  said so in its own output (`FAIL …`), and the menu that follows lets the user retry or
  leave.
- Each action is still the command's own `run()`, printed first as the command it stands
  for (ADR-024).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep ending after every action (ADR-024) | The summary is stale at once, and a second account means starting again. |
| Return to the menu without re-reading | Shows the old summary: "2 recorded" right after recording a third. |
| Quit exits with the last action's code | Quit is a choice, not a failure; the failure was already shown, and a script never reaches this screen (it needs a terminal on every stream). |
| Return after setup too | Setup ends on its own closing line (done, or what blocks the next push); a menu after it buries that. |

## Consequences

- One more read of the folder (the bounded walk of ADR-024) after each machine-level
  action.
- Leaving the start screen after an action takes one more key: Quit, Esc or Ctrl-C.
- The exit code no longer reports a failed action on this path; the action's own output
  does. Typed commands (`repown accounts add`, `repown doctor`, `repown fix`) are unchanged.
