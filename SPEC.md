# Spec: `repown setup`, a guided wizard over repown's own commands

Removed at close-out; lasting facts move to README, HOW-IT-WORKS, ADR-016 and the ADR-005 amendment.

## Objective
An enrich-only addition for newcomers: `repown setup` walks a clone through choosing (and, if
new, recording) an account, pinning it, optionally switching gh, allowing an organisation owner,
turning the guard on, and removing gh as the credential helper. It shows the equivalent commands
in a review, then runs those commands' own code. No existing behaviour or business rule changes.

## Surface
    repown setup [<account>] [--name <v>] [--email <v>] [--host github|azdo|generic] [--gh]
                 [--allow-owner <owner>] [--guard] [--fix] [--no-input]   (+ global --cwd)

Every flag maps to an existing command (`accounts add`, `use`, `guard on`, `fix --yes`) or the
line ADR-004 documents (`git config --local --add repown.allowOwner <owner>`).

## Contract
- Interactive only when stdin and stderr are terminals and `--no-input` is absent.
- No terminal, no `--no-input`: exit 2, naming the flags and the equivalent commands.
- `--no-input`: runs when every required value is given (a new account needs `--name` and
  `--email`; the guard needs `--guard`; fix needs `--fix`), else exit 2 naming them.
- Cancel (Esc or Ctrl-C, at a step, at the review or during the run) exits 130; decline exits 1.
- Nothing is written before Run. Prompts and chrome go to stderr; payload stays on stdout.
- Run order: accounts add, allowOwner, use, guard on, fix; stop at the first failure.

## UX
@clack/prompts (lazy-loaded, output on stderr): intro, a spinner while reading state, selects
with hints, text with defaults, confirm as Yes / No / Back, a review note, outro. A plain readline
prompter (numbered choices, words not symbols) when TERM=dumb or clack can't load.

## Boundaries
- Always: characterization tests before touching existing files; `git log --no-show-signature`.
- Never: change an existing command's behaviour, exit codes, prompts or stdout; load clack from
  any path `guard check` can reach; write before Run.
- ADRs: new ADR-016 supersedes ADR-010's zero-runtime-dependency line only; ADR-005 gets a dated
  amendment; no other ADR changes.

## Success criteria
1. `npm test`, `npm run build`, `npm run pack:check` pass.
2. The no-business-rule-change checklist in tasks/todo.md has a passing test per item.
3. A wizard-auditor validation pass finds no BREAKING or SAFETY finding.

## Riskiest assumption
clack renders cleanly to stderr in Windows terminals and honours NO_COLOR. Checked by hand in the
demo sandbox, else reported as not verified, with the plain prompter as the fallback.
