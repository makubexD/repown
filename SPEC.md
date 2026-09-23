# Spec: make gid's goal obvious (README.md + CLAUDE.md)

Temporary. Deleted at close-out once every fact below has its permanent home.

## Objective

A reader can state gid's goal from the README's first screen: **use several git accounts on
one machine, and move between their repositories freely, with each clone always committing
and pushing as its own account, no switch command, and no wrong identity published.**
CLAUDE.md gives an agent only what it cannot infer from the code.

User: the owner, plus anyone with several git accounts on one machine deciding whether to
install it.

## Why

The README opens with the mechanism ("pin a git clone") and argues "switching is the problem".
There, "switch" means `gh auth switch`, the thing gid makes unnecessary. For the user,
switching *is* the goal: working in X, then Y, then Z. Half of the README's 303 lines are
design arguments already in docs/DECISIONS.md. CLAUDE.md is a file-by-file tour, and it is
untracked.

## Success criteria

1. The first ≤25 lines of the README give a one-line promise in outcome terms, the problem in
   ≤4 lines, and a 3-step quickstart.
2. All 8 commands (status, use, off, doctor, fix, guard, accounts, scan) are documented;
   `gid off` is missing today. Flags and output samples match `--help` and the `out.*` strings.
3. Every design argument that leaves the README has a home in docs/DECISIONS.md. The README
   keeps a single sentence plus a `§` link.
4. CLAUDE.md is ≤ ~70 lines, does not duplicate README/DECISIONS, and is committed together
   with `.claude/rules/code-quality.md`.
5. `npm test` and `npm run build` are green. The docs-drift review finds 0 false statements.
6. `test/docs.test.ts` fails whenever the README and the CLI's command list disagree.

## Out of scope

`src/` and `--help` text; a re-pin/restore or machine-wide switch command; npm publishing;
`.claude/settings.local.json`; `.claude/skills/`.

## Boundaries

- Always: use the placeholder identities octocat and `*.example.invalid`; stage files by name;
  one commit per task.
- Never: push; put real names or addresses in the docs.
