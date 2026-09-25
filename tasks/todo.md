# npm publishing

Status: Phase 4, task 5 next (gate before npm publish). Spec: SPEC-npm-publish.md

- [x] Phase 0-3: size, clarify, spec, plan (approved)
- [x] 1. Release tool skeleton + `changelog` group, seeded CHANGELOG.md - Docs: CHANGELOG
- [x] 2. `check` and `package check` - Docs: none (task 4 documents the routine)
- [x] 3. package.json: drop npm `private`, publishConfig, npm scripts - Docs: README Development
- [x] 4. ⚠ CI workflow_call + release.yml - Docs: ADR-015, ADR index, docs/RELEASING.md, CLAUDE.md
- [ ] 5. ⚠ First publish 0.1.0 (gate before `npm publish`) - Docs: README badges/install, CHANGELOG, HOW-IT-WORKS uninstall
- [ ] 6. User: `npm trust github`, disallow tokens, delete dev token - Docs: RELEASING.md (already)
- [ ] Phase 5: review (code, docs drift, security, cli-auditor)
- [ ] Phase 6: close-out
