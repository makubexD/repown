# setup offers the accounts it detects

Status: Task 3 done; next: Task 4.

- [x] 0. Plan: SPEC.md + tasks/todo.md - Docs: none
- [x] 1. Detection in readContext: `detected`, `ownerIsUser`, `machineIdentity`; optional provider `accountKind` (GitHub: `ghProfileField(login, 'type')`) (D4, D5, D6) - Docs: docs/FAQ.md network note
- [x] 2. The account step lists candidates: `DETECTED_PREFIX`, `accountOf`/`isNew`, `newAccount` only for "a new account", preselection (D1-D3, D8, D9, D10) - Docs: README Quick start, HOW-IT-WORKS card 13
- [x] 3. ⚠ Machine identity as a detail line on name/email (D7); a recorded owner is preselected (D11) - Docs: card 13
- [ ] 4. ADR-017 (cites ADR-007, ADR-008, ADR-011) + CHANGELOG Unreleased - Docs: those
- [ ] Review phase (grok review + critique at high, Opus review)
- [ ] Close-out
