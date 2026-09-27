# SPEC: setup signs the account in to gh; doctor shows per-account readiness

Temporary. Removed at close-out, once each fact has a permanent home.

## Objective

After `repown setup`, a GitHub account can also be used by gh, or setup says exactly
what is left. Every gh fix repown prints is one that works. `repown doctor` shows, for
each account, whether git and gh are ready to use it.

Found in a real run: setup only asks the gh question when the account is already
signed in to gh (`ghOffered`, `src/wizard/setup-flow.ts`), so a new account skipped it
silently. `repown status` then advised `gh auth switch -u <account>`, which fails
because gh has no such account. `repown doctor` never mentions the accounts repown
recorded.

## Boundaries

**Always**
- TDD: failing test first.
- The hard rules in CLAUDE.md: functions ≤20 lines, ≤4 params, only `src/core/exec.ts`
  spawns, only octocat/octo-org/octo-work and `*.example.invalid` in the repo, failures
  are a `Result`.
- The gh sign-in never runs without a terminal.
- A gh, GCM or registry lookup that failed shows as `unknown`, never as "not signed in".

**Ask first**
- Making `gh auth login` a step if it cannot avoid gh becoming git's credential helper
  (Task 1 decides).
- Any new exit code; any change to doctor's exit codes.

**Never**
- Read gh's or GCM's tokens. Only the lists of logins, as today.
- Leave gh installed as git's helper without saying so.
- Push.

## Scenarios

| # | Situation | Planned |
|---|---|---|
| G1 | Setup: a GitHub account not signed in to gh; gh installed and queryable | New question "Sign in to gh as octocat too?". Hint: gh is GitHub's command-line tool (`gh pr create`); git pushes don't need it; Yes opens your browser to sign in, and gh then acts as octocat in every terminal. Default No, like the switch question. Yes plans `repown use octocat --gh` |
| G2 | `repown use X --gh` in a terminal, X not in gh | Runs `gh auth login` for the host with Task 1's flags, handing it the terminal. Then checks gh's active account: X → `OK gh signed in as X`; someone else → WARN naming who signed in and how to retry. Then the pin, as today |
| G3 | `repown use X --gh` with no terminal, X not in gh | No login. WARN `X isn't signed in to gh`, `fix: gh auth login, then repown use X --gh` |
| G4 | X already in gh | Unchanged: switch |
| G5 | After a login, gh became git's credential helper | WARN with `fix: repown fix` (Task 1 decides whether this can happen) |
| G6 | Setup: gh sign-in not offered or declined, and gh acts as another account | The review's notes and the closing "done" lines say gh still acts as `<active>`, with the command from `ghAdvice` |
| G7 | Status's gh WARN | X in gh: `fix: gh auth switch -u X`. X not in gh: `fix: repown use X --gh   (signs X in to gh)` |
| D1 | `repown doctor` | Title `repown doctor · how this machine signs in to git hosts`. "This machine": helper, GCM, gh active. "Accounts": one row per account recorded by repown or known to GCM or gh: git `stored` / `not yet (the first push signs in)` / `unknown`; gh `active` / `signed in` / `not signed in` / `unknown`; plus `not recorded by repown` where true and `(this clone)` beside the clone's pinned account. Diagnosis below and exit codes unchanged |
| D2 | Registry, GCM or gh unreadable | Its cells read `unknown` and a WARN says why. Never omitted |
| D3 | A non-GitHub recorded account | git `your host's own sign-in` (not pinned, ADR-009); no gh cell |
