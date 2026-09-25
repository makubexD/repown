# repown setup wizard

Status: Phase 4 done; Phase 5 review next

- [x] 1. Characterization tests (fix --dry-run snapshot, use org hint, help exit codes, no clack in the static import graph) - Docs: none (tests only)
- [x] 2. Export fix's preview lines (byte-identical) - Docs: none (no behaviour change)
- [x] 3. ⚠ ADR-016 + @clack/prompts (exact pin, shrinkwrap) - Docs: ADR-016, ADR-010, CLAUDE.md, README, SECURITY, CONTRIBUTING, CHANGELOG
- [x] 4. Engine + plain prompter + scripted tests - Docs: none (no user surface yet)
- [x] 5. ⚠ repown setup flow + command - Docs: README, HOW-IT-WORKS, help, CHANGELOG, ADR-005 amendment
- [x] 6. clack adapter + smoke test + Windows check - Docs: ADR-016, CONTRIBUTING, README
- [ ] Phase 5 review (incl. wizard-auditor)
- [ ] Phase 6 close-out (GATE 6)

## No business rule changes (each a test)
- [x] allowOwner written only --local, once per owner; global config untouched
- [x] no hook without an explicit Yes or --guard; foreign hook / core.hooksPath untouched
- [x] hookBody unchanged; guard check's import graph has no clack
- [x] existing guard/cli/docs tests unchanged and green
- [x] azdo/generic: no credential-pin claim when credentialKeys is empty
- [x] fix default No; --no-input needs --fix
- [x] existing commands' exit codes, prompts and stdout unchanged
- [x] every git log passes --no-show-signature; no prompt text on stdout
