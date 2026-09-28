# Spec: what a real run of bare `repown`, `status` and `doctor` taught us

## Objective
Everything a set-up clone prints should be true, said once, and point to the right command.
An audit of one real session (bare `repown` twice, `git push`, `repown status`, `repown doctor`)
found:
- a stale hint and a step that does nothing
- wording narrower than what git does
- questions that led nowhere
- gh advice repeated three times
- status calling an optional thing a warning
- doctor ending without a verdict

## Boundaries
- Always:
  - TDD per task, one commit per task that ticks tasks/todo.md.
  - CLAUDE.md hard rules: strip-only TS, functions ≤20 lines and ≤4 params, `octocat` and
    friends only, ADRs cited as ADR-0NN.
  - `--no-input` and every setup flag behave as today.
- Ask first:
  - any `--format json` field (ADR-014)
  - any exit code
  - guard severity (ADR-011)
  - anything in `use`, `guard`, `fix` or `accounts` beyond the typography of task 6
- Never:
  - change bare-repown routing (ADR-021)
  - push
  - load clack outside src/wizard/clack.ts

## Commands
    npm test · npm run build
    node --test test/wizard-screens.test.ts     # setup's screens replayed with keystrokes
    node --test test/wizard-setup.test.ts test/status.test.ts test/doctor.test.ts

## Success criteria
- Each scenario below is a test that fails before its task and passes after it.
- A settled clone reaches Done with `git config --local --list` byte-identical.
- The status exit codes are unchanged. A clone whose only finding is gh still exits 0.
- Task 9 leaves every doc matching the code, sample output included. docs.test doesn't check
  sample output, so this is checked by hand.

## Scenarios
| # | Situation | Today | Planned |
|---|---|---|---|
| A1 | Any run that ends with the run summary or the settled screen | "check it any time: repown (this clone), repown doctor (this machine)"; settled: "See it any time: repown (this clone), …" (stale since ADR-021: bare repown opens setup) | "… repown status (this clone), repown doctor (this machine)" |
| A2 | Pinned to octocat and intact; push.autoSetupRemote unset; Recommended | Review: "1. Pin this clone to octocat …  repown use octocat" plus "2. Push new branches …"; step 1 changes nothing | Review lists only the git config step. If GCM holds no credential for octocat, a review note says: "No stored credential for octocat yet: the first push signs in once (your browser opens)". The run summary says "done: this clone is set up for octocat" as today |
| B3 | The auto-upstream step and the offer | "Push new branches without -u (this clone only)"; "OK upstream new branches push without -u in this clone"; "optional: push new branches without -u: …" | "Push branches without -u: the first push sets the upstream (this clone only)"; "OK upstream branches without an upstream push without -u in this clone"; "optional: push branches without -u: repown setup --auto-upstream" |
| B4 | gh acts as another account; the user says No to gh | "If you use gh here, later: fix: repown use octocat --gh" | "If you use gh here, later: repown use octocat --gh …" |
| B5 | Settled clone with push.autoSetupRemote true | commits as / pushes as / guard | Adds "upstream    the first push of a branch sets it" |
| C6 | Pinned intact, nothing left (auto-upstream true or not offered, no foreign owner, gh not the helper), bare `repown` or `repown setup` in a terminal | Asks mode, account and gh, then the settled screen | Opens on "This clone is already set up". What now? offers Done (change nothing), "Use another account" (goes on to the normal questions from the account one), and "Sign in to gh as octocat" (only when gh acts as another account; plans `repown use octocat --gh`) |
| C7 | Recommended, clone already pinned to the chosen account, gh acts as another account | "Sign in to gh as octocat too?" on every run; the advice printed in the review note and again as "optional, only if you use gh here: …" after the run | Recommended doesn't ask the gh question there (Step by step still does). The advice appears once per run: in the review or settled note, not repeated after the run |
| D8 | The guard passes; `use` finds no stored credential | "carries this clone’s identity" (curly quote); `No stored credential for "octocat" yet -- the first push …` | "carries this clone's identity"; the use line keeps its words, but with the same punctuation style as the rest of use's output (check use.ts and settle on one) |
| E7 | `repown status`, pinned, gh active as another account, push.autoSetupRemote true, branch without upstream | WARN gh … before OK identity; "ready: … · 1 warning (optional: gh)"; upstream "not set" | OK identity first; gh as a note line (not WARN), with its fix; "ready: commits and pushes use octocat · gh: optional"; upstream "the first push sets it (push.autoSetupRemote)". Exit code 0 as today |
| E8 | `repown doctor`, everything fine | GCM path with backslashes; the SSO paragraph always; no closing line | The path in one style consistent with status; the SSO paragraph only when a check failed or the store couldn't be read; a closing verdict such as "ready: every account repown knows can sign in" (or a tally of problems), mirroring status |

## Open questions (Grok answers these in its first run and reports them; I decide)
1. Do status or doctor have `--format json`? If they do, their fields must not change
   (ADR-014).
2. Does any exit code or test depend on gh being a WARN in status (ADR-011 says gh is never
   refused)?
3. For E8, what does doctor already count as a failure (return 1)? The verdict follows that
   count.
