# ADR-022: A settled clone opens on the already-set-up screen

**Status:** Accepted

## Context

An audit of one real session (bare `repown` twice, a push, `repown status`,
`repown doctor`) read every line against the code. Two of its findings belong here, beside
[ADR-020](ADR-020-setup-leaves-clone-ready.md) and
[ADR-021](ADR-021-bare-repown-always-opens-setup.md).

The clone was already pinned, and the pin matched what was recorded. Recommended
still put `repown use <account>` first in the review, then the `push.autoSetupRemote`
line. Running that pin changed nothing. The same run asked **Sign in to gh as
`<account>` too?** even though the clone was already that account, and then printed
the same advice again after the commands: once in the review, and once as
`optional, only if you use gh here`.

ADR-021 sends every terminal `repown` into setup, including a clone with nothing
left to do. That clone still answered the mode, account and gh questions before
the screen that says nothing needs to change.

## Decision

- **A pin that would write nothing is left out of the plan.** `use` is omitted when
  the account is not new, it equals the pin, the pin is intact, and this run is not
  passing `--gh`. Any one of those failing keeps `use`, including a pin that has
  drifted: the review still says pinning again restores it. The settled screen is
  an empty plan, under the same extra conditions as before: gh is not the credential
  helper, and origin's owner is not one the guard would refuse. The done line names
  the account from the answers when the pin was the thing left out. `--no-input` on
  a settled clone writes nothing, so `git config --local --list` is unchanged.
  When the plan has no `use`, the host pins credentials, and Git Credential
  Manager's store was read and does not list the account, the review says
  `No stored credential for <account> yet: the first push signs in once (your
  browser opens).` `use` prints its own line when it runs, so the note stays out
  then.
- **That settled screen is the first screen** when no flag was given and Recommended's
  answers for the pinned account are already settled. **Done** exits 0 with
  `Nothing changed: this clone was already set up`. **Use another account**
  continues at the account question, in Recommended; Back returns to this screen.
  **Sign in to gh as `<account>`** is offered only when gh acts as another account.
  It reviews `repown use <account> --gh` and nothing else. When gh already lists
  the account, the option is **Make `<account>` gh's active account**. The opening
  screen has no **Change an answer**, because nothing has been asked. Step by step
  can still reach the same screen after its questions, and then **Change an answer**
  is offered. There is no **Apply the same settings again**: the plan is empty, so
  a re-run would have nothing to run. The headline's `upstream` line is the tracked
  ref (for example `origin/main`) when there is one, otherwise
  `set on the first push (push.autoSetupRemote)` when that setting is on, otherwise
  the line is absent. Those are the words `repown status` uses, apart from status's
  `none yet` when neither applies, in line with commits as, pushes as and guard.
- **Recommended does not ask the gh question when the chosen account is the pin.**
  The answer stays No, so the review still says how to point gh at that account
  later. Step by step still asks. A gh switch for a different account is unchanged.
  The advice is printed once. When a review was shown and it carried the note, the
  line after the run is left out. `--no-input` has no review, so that line is where
  the advice appears.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep the no-op `use` so the settled screen can offer to apply it again | The real run showed a step that changes nothing. An empty plan has nothing to re-run |
| Open on the settled screen only from bare `repown`, and let `repown setup` keep asking | ADR-021 already starts setup from both. The questions were the waste, not which command opened them |
| Start **Use another account** at the mode question | The hint is to choose a different account. Recommended is the mode the settled screen came from, and Back still returns there. Step by step stays reachable with **Change an answer** after a later review |
| Drop **Change an answer** from every settled screen | Step by step can still arrive there after answering, and those answers are what the option changes |
| Ask the gh question in Recommended and only hide the second copy of the advice | The question's answer was No on every settled run. The note already says the command |

## Consequences

- **ADR-020's first question, and its automatic gh switch, are superseded in part.**
  The mode question is still first when the clone is not settled. Recommended still
  switches gh without asking when gh lists the account and the clone is pinned to
  someone else. The rest of ADR-020 stands, including `--no-input` answering an
  ungiven question No.
- **A settled clone no longer rewrites its pin to say it is set up.** Flags keep
  their meaning: `repown setup <account> --gh` still runs `use --gh`, and
  `--no-input` still does not borrow Recommended's Yes answers.
- **The gh advice moved, it was not removed.** A review shows it, or the run does,
  not both.
