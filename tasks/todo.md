# Tasks: unpushed-commit advice on a never-fetched remote

Status: Phase 5 review; Tasks 1-2 done; spec revised after the doubt review (FETCH_HEAD dropped, ADR-025)

- [x] Phase 1 clarify (quality bar: CLAUDE.md + .claude/rules/code-quality.md)
- [x] Phase 2 spec (SPEC.md approved)
- [x] Phase 3 plan (GATE 3)

## Task 1 ⚠ — `repown use` tells a never-fetched clone to fetch, not to rebase from the root [x]

Reads git config (`remote`, refs, git dir). Size S-M.

- Acceptance:
  - [ ] never-fetched remote holding the first commits: the warning names `git fetch origin`,
        prints no `git rebase`; exit 0
  - [ ] after `git fetch origin`: the base is the remote tip's short hash, the count drops
  - [ ] an empty remote fetched once: `--root`, as today; no remote: unchanged (S19 tests untouched)
- Verify: `node --test test/use.test.ts`, then `npm test` + `npm run build`
- Files: `src/core/git.ts`, `src/core/unpushed.ts`, `test/use.test.ts`,
  `test/wizard-setup.test.ts` (fact literals gain `unfetched: null`)
- Docs: `docs/HOW-IT-WORKS.md` (unpushed rows ~216, ~456), `docs/FAQ.md` (~46),
  CHANGELOG `[Unreleased]` → Fixed

## Task 2 — setup's review shows the same fetch line [x]

Depends on Task 1. Size XS.

- Acceptance:
  - [ ] `reviewNotes` with `unfetched: 'origin'` has the fetch line and no `git rebase`
- Verify: `node --test test/wizard-setup.test.ts`, then `npm test` + `npm run build`
- Files: `test/wizard-setup.test.ts` (code only if the test shows a gap)
- Docs: none — the HOW-IT-WORKS row from Task 1 covers setup's review, which prints the same lines

## Checkpoint: after Task 2

- [ ] `npm test` and `npm run build` green
- [ ] scratch copy of the field case: `node src/cli.ts use makubexD` before and after `git fetch`
- [ ] Phase 5 review (code-reviewer, docs drift, security-auditor for ⚠)
- [ ] Phase 6 close-out (move SPEC facts, delete SPEC.md and tasks/)
