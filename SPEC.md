# Spec: `repown setup` offers the accounts it detects

## Objective
On a machine with nothing recorded, setup's first question lists the accounts repown can
already see (origin's owner, gh's accounts, Git Credential Manager's stored accounts) and
suggests the one that owns the repository. The machine's global identity is shown, never
assumed: it is often another account's (a work identity in a personal clone).

## Boundaries
- Always: TDD per task; `--no-input` and the positional `<account>` path unchanged; no
  other command's output, exit codes or prompts change (test/characterization.test.ts
  stays green); CLAUDE.md hard rules (functions ≤20 lines, strip-only TS, only `octocat`,
  `octo-org`, `octo-work`, `*.example.invalid`; a failed lookup is a `Result`).
- Ask first: anything that changes `use`, `accounts`, `guard`, `fix`, `status`, `doctor`.
- Never: push; preselect an account known only from gh or GCM; preselect the machine
  identity.

## Commands
    npm test · npm run build
    node --test test/wizard-screens.test.ts   # the scenarios below, replayed with keystrokes

## Success criteria
Each scenario below is played in test/wizard-screens.test.ts or asserted in
test/wizard-setup.test.ts; `npm run build` and `npm test` pass.

## Scenarios
| # | Situation | Today | Planned |
|---|---|---|---|
| D1 | Nothing recorded; owner `octocat` is a User; gh has `octo-work` (the reporter's case) | Types a login, no default | List: `octocat` (owns this repository, **preselected**), `octo-work` (signed in to gh; stored in Git Credential Manager), "a new account". Picking `octocat` skips the login question |
| D2 | Owner is an organisation `octo-org`; gh has `octo-work` | Types a login | `octo-org` not listed; `octo-work` listed, **not** preselected; "a new account" is the default |
| D3 | gh missing or can't be queried; owner `octocat` | Types a login | `octocat` listed as "owns this repository; may be an organisation", not preselected |
| D4 | Same login from owner, gh and GCM, differing in case | n/a | One entry; every source in its hint |
| D5 | A detected login is already recorded | n/a | Listed once, as the recorded account |
| D6 | Origin not on GitHub (Azure DevOps, generic) | Types a login | Nothing detected: owner, gh and GCM candidates are GitHub's only |
| D7 | New account; global `user.email` set | Not mentioned | name/email keep the profile suggestion as default; detail: "this machine's default is <name> <email>; type it only if this account should use it" |
| D8 | "a new account" picked | Login with no default | Login defaults to the owner only when it's a confirmed User |
| D9 | Picks a detected account, then ← Back | n/a | Back at the list with that choice kept |
| D10 | `repown setup octocat --no-input …` | Works | Unchanged |

## Open questions
None.
