# Spec: `repown setup` for someone who knows nothing, and a leaner README

## Objective
A first-time user understands every question, the review and the result of `repown setup`
without reading the docs, and a clone that needs nothing says so. The README keeps the
minimum a user needs; the detail moves to docs/.

## Boundaries
- Always: TDD per task; no other command's output, exit codes or prompts change
  (test/characterization.test.ts stays green); `--no-input` unchanged; CLAUDE.md hard rules.
- Ask first: anything that changes `use`, `guard`, `fix`, `accounts` (WIZ-2 stays held).
- Never: push; names or emails in the repo; clack outside src/wizard/clack.ts.

## Commands
    npm test · npm run build · npm run pack:check
    node --test test/wizard-screens.test.ts   # the scenarios below, replayed with keystrokes

## Success criteria
Each scenario below shows its "Planned change" in test/wizard-screens.test.ts (clack
driven through PassThrough streams with real keystrokes), and:
- settled clone: Done exits 0 and `git config --local --list` is byte-identical;
- the README follows the outline in tasks/todo.md task 5; docs.test passes.

## Scenarios: a first-time user, and the edge cases
| # | Situation | What the user sees today | Planned change |
|---|---|---|---|
| S1 | Already pinned to the account, guard on (the user's case) | "This runs: repown use makubexD", and "pinned to makubexD **now**" (reads as just done) | Settled screen, "This clone is already set up", with Done / Apply again / Change an answer; the detail says "currently pinned to X" |
| S2 | New machine, nothing recorded, org repo, 3 other authors in history | Hints under **text** questions lose the `│` gutter (a render bug in every text prompt); "(new: Octo Work <…>)" and the `--email` command wrap mid-token in the box; "3 other addresses are in this history" is unclear | Hints as the gutter-safe text clack draws (a `│` prefix, or the hint in clack's placeholder/`p.log`); review steps as short sentences, with the command on its own line; "3 other people's email addresses are in this repository's commits" |
| S3 | gh is git's credential helper | "gh serves only its active account, so other clones get a password prompt" | Say it plainly: "gh answers git's sign-in requests with its active account only, so your other accounts' clones get password prompts. Choosing Yes gives that job back to Git Credential Manager, for every repository on this machine" |
| S4 | Azure DevOps (no credential pin, ADR-009) | "pushes as: not pinned by repown on this host; its own sign-in decides" | "pushes as: whatever you sign in with for this host (repown can pin the sign-in on GitHub only)" |
| S5 | husky owns pre-push | "guard: left alone: another tool owns the pre-push hook" | Add what to do: "another tool (e.g. husky) owns the pre-push hook; to keep the check, call `repown guard check` from it: HOW-IT-WORKS card 10" |
| S6 | Types `octo cat`, then `OctoCat` (already recorded) | "use that account by that name" | "\"octocat\" is already recorded on this machine: type < to go back and pick it from the list" |
| S7 | Picks ← Back on the first question | The same question again (nowhere to go) | No ← Back on the first question asked |
| S8 | Change an answer, then Esc | The whole wizard is cancelled (exit 130) | A "← Back to the review" choice on the list; Esc there returns to the review |
| S9 | `git init`, no remote, nothing recorded, no gh | Name defaults to the login; email has no default and no example | Email hint gains an example: "on GitHub: <id>+<login>@users.noreply.github.com (Settings → Emails)"; name default kept |
| S10 | Clone pinned to octo-work, switching to octocat; history unreadable | "note: switches this clone from octo-work"; the history error is shown raw | "This clone moves from octo-work to octocat: its next commits and pushes use octocat" |
| S11 | Plain prompter (`NO_COLOR`) | Host choice "this host" (the generic provider's label); otherwise readable | Wizard-only labels: "GitHub", "Azure DevOps", "another host (GitLab, Bitbucket, self-hosted)". The provider label stays, because `status` prints it |
| S12 | Not in a repo / no terminal / `--no-input` missing an account | "Not a git repository: <path>"; the no-terminal lines are clear | Add "run it inside a clone: cd path/to/repo, then repown setup" |
| S13 | After Run | `use`'s own output, then "next: repown doctor" | "step 1 of 3: <what>" above each `> command`; at the end, "Done: this clone commits and pushes as X. Check it any time: repown · this machine: repown doctor". `use`'s own output is unchanged |
| S14 | Declined or Esc | "declined; nothing was changed." | Add "run repown setup again any time" |

## Open questions
None. Optional: record S1, S2, S8 with VHS if the user installs it.
