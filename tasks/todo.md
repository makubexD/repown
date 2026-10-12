# Test speed, and two push-URL leftovers

Status: Phase 5 (review).

Every test-speed task: no assertion removed or loosened, each test keeps a fresh directory,
full suite green, wall time measured after it (baseline median ~809 s).

- [x] 1. Plan: SPEC.md and this file. Docs: none.
- [x] 2. sandbox() copies a template repository instead of `git init` (spike for the riskiest
  assumption: config paths, locks, index stat data on Windows)
  - Docs: CLAUDE.md Tests (sandbox copies a per-process template).
- [x] 3. Fixture config written to `.git/config` in one write (pinGithub and the like)
  - Docs: none (test-only).
- [x] 4. Read-only suites build once: config-snapshot `before()` + parallel reads; guard
  check's `commitAs` caches HEAD and its tree
  - Docs: none (test-only).
- [-] 5. Dropped: built fixtures copied per test (test setup is 10% of spawns).
- [-] 6. Dropped: in-process `run()` for fixture-only CLI spawns (same reason).
- [-] 7. Won't fix after the doubt pass: ADR-026 already skips ownerless URLs; a mirror path
  would carry a warning nothing clears. ADR-026 2026-10-11 note.
- [x] 8. ⚠ (narrowed after the doubt pass) sign-in and later URLs share one push URL read
  (also: on git < 2.7 the destination and later URLs use different fallbacks; one list fixes it)
  - Docs: ADR-029 note (output unchanged).
- [x] 11. Spawn budget test: status, use, setup --no-input in a pinned clone, counted per
  command; RED at the target, lowered as 12-14 land
  - Docs: none (test-only).
- [-] 12. Won't fix after the doubt pass: a run-wide layout cache reverses ADR-029 and can
  report the guard on while core.hooksPath moved (ADR-029 2026-10-11 note).
- [-] 13. Won't fix, same reason (tool probes cached across a run's waits).
- [x] 14. ⚠ (narrowed after the doubt pass) one hook location per read: guardStateAt
  - Docs: ADR-029 note; CHANGELOG "faster on Windows" line for 12-14.
- [x] 9. Record before/after wall times and spawn counts - Docs: ADR-029 note.
- [ ] 10. Close-out: move facts from SPEC.md, delete SPEC.md and tasks/, memory.
