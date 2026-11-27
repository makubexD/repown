# Config read through include.path

Status: task 3 done; next task 4.

- [x] 1. Plan: SPEC.md and this file. Docs: none.
- [x] 2. Scoped reads follow include.path (item 1)
  - Accept: a key only in a file included from the global config is read by every scoped
    getter and by a snapshot; the machine default identity sees an included `user.email`.
  - Where: `scoped` reads in `src/core/git.ts`, `listArgs`/`configRead` in `src/core/config-snapshot.ts`.
  - Docs: ADR-029 note, CLAUDE.md snapshot line.
- [x] 3. `fix` edits the file that holds gh's entries (item 2)
  - Accept: gh's pair in an included file is planned with its file, removed from that file
    only, and the preview names the file; top-file behaviour unchanged; doctor and fix agree.
  - Where: `src/core/credential/repair.ts`, a file-targeted read/write in `src/core/git.ts`,
    `previewLines` in `src/commands/fix.ts`.
  - Docs: ADR-030, HOW-IT-WORKS fix card, CHANGELOG.
- [ ] 4. Docs sweep and close-out: every doc against the code, sample output included;
  facts moved out of SPEC.md; SPEC.md and tasks/ removed.
