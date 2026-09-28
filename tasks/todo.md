# Setup audit fixes

Status: Task 0 done (plan committed); next: Tasks 1, 2, 6.

- [x] 0. Plan: SPEC.md + tasks/todo.md
- [ ] 1. The stale "check it any time" hint and the doubled "later: fix:" (A1, B4). Tests: wizard-setup, wizard-screens. Files: src/wizard/setup-run.ts, setup-flow.ts. Docs: HOW-IT-WORKS card 13
- [ ] 2. Auto-upstream wording: branches, not "new branches" (B3). Tests: wizard-setup, wizard-screens. Files: setup-flow.ts, setup-run.ts, setup option help. Docs: README, HOW-IT-WORKS, CONFIGURATION, ADR-020 untouched
- [ ] 3. No no-op re-pin; a "no stored credential yet" note (A2). Tests: wizard-screens (pinned intact + upstream unset = 1 step). Files: setup-flow.ts, setup-run.ts. Docs: ADR-022 (new), card 13, CHANGELOG
- [ ] 4. Settled screen first, with the What now? options and the upstream line (C6, B5). Tests: wizard-screens, wizard-setup. Files: setup-flow.ts, engine.ts, review-text.ts. Docs: ADR-022, card 13, README transcript, CHANGELOG
- [ ] 5. gh asked once and noted once (C7). Tests: wizard-setup, wizard-screens. Files: setup-flow.ts, setup-run.ts. Docs: ADR-022, card 13
- [x] 6. Typography: plain apostrophe in guard, one punctuation style in use (D8). Tests: guard, use, cli. Docs: README sample, HOW-IT-WORKS samples
- [ ] 7. status: identity first, gh as a note, the auto-upstream line (E7). Tests: status. Files: src/commands/status.ts, src/ui/format.ts if a note level is needed. Docs: ADR-023 (new), card 5, README, CHANGELOG
- [ ] 8. doctor: path style, SSO paragraph on failure only, a verdict line (E8). Tests: doctor. Files: src/commands/doctor.ts. Docs: ADR-023, the doctor card, README, CHANGELOG
- [ ] 9. Documentation sweep: README, HOW-IT-WORKS, CONFIGURATION, FAQ, CONTRIBUTING, SECURITY, decisions/README, CHANGELOG, CLAUDE.md match the code, sample output included
- [ ] Review: /grok-build:critique on the branch; fix what survives
- [ ] Close-out: remove SPEC.md and tasks/todo.md, naming where each fact lives
