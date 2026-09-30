# colour-safe tests and faster Windows CI

Status: Task 4 done; next: Task 5. The TEMP/Defender tweak is in ci.yml (WIN_TEMP_TWEAK=1) for measurement. One commit per task, TDD, and that commit ticks the line.

- [x] 0. Plan: SPEC.md + tasks/todo.md - Docs: none (scaffolding, removed at close-out)
- [x] 1. Colour-safe sandbox() and plainTerminal(), plus the forced-colour ubuntu Node 24 CI row (red first: the suite fails with FORCE_COLOR=1 and CLICOLOR_FORCE=1) - Docs: none (the colour rule is written in Task 5)
- [x] 2. Cache the fake gh.exe and git-credential-manager.exe builds, once per test process - Docs: none
- [x] 3. Write the sandbox [user] section with fs, instead of two git config spawns - Docs: none
- [x] 4. Shard the Windows test job (3 shards, Node 22 and 24); measure the TEMP/Defender tweak and keep it only if faster - Docs: none (ci.yml header comments are Task 5)
- [ ] 5. Docs sweep: CONTRIBUTING (one shard locally, the colour rule), CLAUDE.md Tests (what sandbox() clears), ci.yml header comments - Docs: CONTRIBUTING.md, CLAUDE.md, .github/workflows/ci.yml
- [ ] Phase 5 review (code, docs drift, Windows shard count and wall-clock)
- [ ] Phase 6 close-out: remove SPEC.md and tasks/todo.md, naming where each fact now lives (colour rule: CONTRIBUTING and CLAUDE.md Tests; shard, timing and the runner tweak: the ci.yml header)
