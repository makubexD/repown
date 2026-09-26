# Docs end-to-end review: accurate, not repeated, to the point, traceable

Status: Phase 4, task 1 next.

Spec: the approved plan (findings from a three-agent audit of README vs src/). Docs and
tests only; no command's behaviour or output changes.

- [x] 0. Plan: docs end-to-end review
- [ ] 1. Traceability test: every declared option documented, every help env var in
      CONFIGURATION, a feature map in CONTRIBUTING with a row per command/action and real
      src/ paths. Docs: CONTRIBUTING, CLAUDE.md Tests.
- [ ] 2. README rewritten top to bottom: one quick-start block, "Commands, by when you use
      them" replaces Day to day + Commands, fixes (husky, Keys, profile email, exit codes,
      amend scope, fix wording), troubleshooting rows (env var refusal, --no-verify). Docs: README.
- [ ] 3. Every other doc reviewed end to end by parallel agents; fixes applied, repeats cut
      to links. Docs: HOW-IT-WORKS, CONFIGURATION, FAQ, CONTRIBUTING, SECURITY, CHANGELOG.
- [ ] 5. Review: code-reviewer, docs-drift, junior + senior persona walkthroughs, cli-auditor.
- [ ] 6. Close-out: delete tasks/.

Deferred: status suggesting `repown setup` (behaviour change); WIZ-10; pushInsteadOf
username; context read once.
