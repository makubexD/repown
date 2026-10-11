# Test speed, and two push-URL leftovers

Status: Phase 4 (build), task 3. Wall: baseline ~809 s; after task 2: 799 s.

Every test-speed task: no assertion removed or loosened, each test keeps a fresh directory,
full suite green, wall time measured after it (baseline median ~809 s).

- [x] 1. Plan: SPEC.md and this file. Docs: none.
- [x] 2. sandbox() copies a template repository instead of `git init` (spike for the riskiest
  assumption: config paths, locks, index stat data on Windows)
  - Docs: CLAUDE.md Tests (sandbox copies a per-process template).
- [ ] 3. Fixture config written to `.git/config` in one write (pinGithub and the like)
  - Docs: none (test-only).
- [ ] 4. Read-only suites build once: config-snapshot `before()` + parallel reads; guard
  check's `commitAs` caches HEAD and its tree
  - Docs: none (test-only).
- [ ] 5. Built fixtures copied per test: use's `publishedThenLocal`, reauthor's `field()` (one
  copy in `test/reauthor-helpers.ts`), setup-closing's `clean()`, push-state's first commit
  - Docs: CLAUDE.md Tests (the copy helper; absolute paths rewritten after a copy).
- [ ] 6. In-process `run()` where a CLI spawn only builds a fixture (wizard-setup-terminal,
  setup-context `pin`, status helpers where the spawn isn't the subject)
  - Docs: none (test-only).
- [ ] 7. ⚠ A later push URL with no readable owner is said, never blocking (leftover)
  - Docs: ADR-026 note, HOW-IT-WORKS status card, CHANGELOG.
- [ ] 8. ⚠ readPushFacts reads the push URL list once for sign-in, later URLs and destination
  - Docs: ADR-029 note (output unchanged).
- [ ] 9. Record before/after wall times - Docs: ADR-029 note.
- [ ] 10. Close-out: move facts from SPEC.md, delete SPEC.md and tasks/, memory.
