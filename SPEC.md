# Spec: split the docs by purpose

## Objective
Each document has one purpose and one owner per fact, so a person or an agent reads only
what the question needs.
- **README.md:** what repown is, why it exists, how to install it, and the commands.
- **docs/HOW-IT-WORKS.md:** every scenario and its troubleshooting.
- **docs/decisions/:** one ADR per decision, referenced as `ADR-0NN`. This replaces `docs/DECISIONS.md` and its `§N` references.
- **CLAUDE.md:** the rules for agents.

## Out of scope
- Any change in behaviour or output: code changes are limited to comments.
- The /feature skill.
- The demo GIF.
- Publishing to npm.

## Commands
    npm test          # includes test/docs.test.ts
    npm run build

## Boundaries
- **Always:**
  - use no names or emails, only octocat, octo-org and *.example.invalid;
  - make every link resolve;
  - keep README's Commands table, which docs.test needs.
- **Never:**
  - lose a still-true fact;
  - keep a fact in two places, except for a one-line pointer;
  - push.

## Success criteria
- `npm test` and `npm run build` pass.
- `docs.test.ts` checks, for README.md, CLAUDE.md and docs/**/*.md:
  - that every relative link and anchor resolves;
  - that none of them references `DECISIONS.md` or `§`;
  - that every `repown …` run in HOW-IT-WORKS uses real commands and options.
- `git grep "§\|DECISIONS.md"` finds nothing.
- README is about 150 lines or fewer.
- Each ADR has Status, Context, Decision, Alternatives and Consequences.
- The three wrong statements are fixed:
  - the SSH credential key;
  - "doctor warns";
  - "five of six branches".
- The four inconsistencies are fixed:
  - the registry path;
  - the rebase command;
  - the uninstall order;
  - the sample noreply address.

## Open questions
None.
