# repown leaves you signed in

Status: task 8 done; next task 9.

- [x] 1. Plan: SPEC.md and this file. Docs: none.
- [x] 2. Measure (SPEC "Measure first", points 1–4), no code
  - Accept: each point answered with the command run and git/GCM's output (names replaced);
    anything unmeasured is listed as unclassified.
  - Docs: ADR-032 draft (measurements section).
- [x] 3. `--online` probes the URL and remote a push uses (SPEC B, first two bullets)
  - Accept: HTTPS fetch + SSH push names no account and offers no GCM command; a GHE push
    URL keeps its SSO link; `branch.<b>.pushRemote` is probed and named.
  - Where: `src/commands/doctor-online.ts`, `src/core/push-destination.ts`.
  - Docs: none yet.
- [x] 4. New verdicts, a next step for every FAIL, a progress line (SPEC B)
  - Accept: the measured SSH, host-key and write-access texts; porcelain `!` is OK; deploy
    key; gh/other-helper FAILs name `repown fix` or the helper.
  - Where: `src/core/signin-check.ts`.
  - Docs: none yet.
- [x] 5. Exit 3 when `--online` couldn't check (SPEC B)
  - Accept: offline, timeout, no commit, no origin exit 3; existing tests updated.
  - Where: `src/commands/doctor.ts`.
  - Docs: HOW-IT-WORKS exit-code note.
- [x] 6. A user in origin's URL is never "ready" (SPEC A, row 1)
  - Accept: status, doctor and setup's check name the URL user and the fix.
  - Where: `src/core/push-state.ts`, `src/commands/status.ts`, `src/wizard/setup-flow.ts`.
  - Docs: none yet.
- [x] 7. ~~No stored GCM sign-in is said in status~~ dropped: see SPEC A, row 2.
- [x] 8. The guided repair loop (SPEC C)
  - Accept: each offer row, with a scripted prompter; each offer at most once; quit stops it;
    no terminal means no offers; the browser opener never runs a shell.
  - Where: a pure planner (`src/core/signin-repair.ts`), a runner shared by doctor and
    setup, the opener in `src/core/exec.ts` callers only.
  - Docs: none yet.
- [ ] 9. Setup ends with the check (SPEC D)
  - Accept: after a run and from a settled opening review; default Yes; "done" only on a
    pass; not asked under `--no-input`, without a terminal, origin or commit; exit code and
    spawn budget unchanged; new scenarios in `wizard-screens.test.ts`.
  - Where: `src/wizard/setup-run.ts`, `engine.ts`, `review-text.ts`.
  - Docs: none yet.
- [ ] 10. Review: an independent pass (code-reviewer, security-auditor) on the branch.
- [ ] 11. Docs sweep and close-out: ADR-032 (supersedes ADR-031's two rows), ADR index,
  README, HOW-IT-WORKS (doctor and setup cards), CONFIGURATION, FAQ, CONTRIBUTING map,
  SECURITY (what repown runs for you), CHANGELOG, CLAUDE.md; remove SPEC.md and this file.
