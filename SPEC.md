# Spec: accurate docs after npm publishing, a README for new and advanced users

Removed at close-out; lasting facts move to README, CONTRIBUTING, SECURITY, RELEASING or an ADR.

## Objective
Every doc describes what repown 0.1.1+ does. README is a complete front page for a newcomer
(problem, try, install, two-account quickstart, day to day, configuration, uninstall).
CONTRIBUTING.md is the one place for running repown from a clone and trying it safely.
`repown guard on` warns when it runs from npx's cache, because the hook it writes points
there and refuses every push once that cache is cleared. Plus SECURITY.md, issue/PR
templates and Dependabot.

## Out of scope
Command changes other than the npx warning; documenting hidden aliases (`guard enable|disable`,
`accounts rm`); package managers other than npm (not measured); a demo GIF; a separate
local-development doc.

## Commands
    npm test
    npm run build
    npm run pack:check
    node src/cli.ts <args>

## Boundaries
- Always: CLAUDE.md hard rules; no names or emails (octocat, octo-org, *.example.invalid);
  sample output copied from a real sandboxed run; claims only what was measured.
- Ask first: any other behaviour change.
- Never: push; rewrite an ADR (amend with a dated note); document what help doesn't advertise.

## Success criteria
1. `npm test`, `npm run build`, `npm run pack:check` pass.
2. Every finding of the three reviews is fixed or listed as deferred with a reason.
3. test/docs.test.ts also checks CONTRIBUTING.md and SECURITY.md.
4. A test runs the CLI from a copy under `_npx/<hash>/node_modules/repown/` and sees the WARN.
5. A fresh agent reading README + CONTRIBUTING as a new and an advanced user finds no blocker.

## Riskiest assumption
npx's cache path always contains an `_npx` segment (npm 7+). Checked with a real npx run.
