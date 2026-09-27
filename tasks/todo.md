# Tasks: setup signs the account in to gh; doctor readiness

Each task: failing test, code, docs on its `Docs:` line, one commit.

- [x] 0. Plan. Docs: none
- [x] 1. Research (report only, nothing in the repo): the `gh auth login` flags for
  github.com with the browser. Does `-p https` prompt about, or run, `setup-git`? Does
  `--skip-ssh-key` apply? Is gh's `git_protocol` config written? From which gh versions?
  Recommend flags that never make gh git's helper; if impossible, ask before Task 3.
  Docs: none
- [x] 2. Status fix line (G7): `ghAdvice` picks switch vs login from
  `auth.gh.value.accounts`. Docs: HOW-IT-WORKS status card table
- [x] 3. `use --gh` signs in (G2–G5): a terminal-inheriting runner in `src/core/exec.ts`
  (`shell: false`, exec itself writes nothing); `ghLogin(host)` in
  `src/core/credential/gh.ts`; a pure `ghAction(account, auth, interactive)` →
  `'switch' | 'login' | 'advise' | 'none'`; `inspectAuth` again after a login.
  Docs: README `use` row, HOW-IT-WORKS `use` card, CLAUDE.md exec rule, FAQ on when gh
  contacts GitHub
- [ ] 4. Setup offers it (G1, G6): the gh step asks switch or sign-in by state, both
  planning `use --gh`; notes and done lines reuse `ghAdvice`; a wizard-screens scenario
  and `--no-input --gh`. Docs: HOW-IT-WORKS setup card
- [ ] 5. Doctor readiness (D1–D3): reuse `loadRegistry`, `auth.stored`, `auth.gh`,
  `repo.identity`; a pure `accountRows(...)`; characterization tests updated
  deliberately. Docs: HOW-IT-WORKS doctor card, README doctor row
- [ ] 6. ADR-019 (repown can sign an account in to gh; the terminal is handed over,
  never read) and a CHANGELOG Unreleased entry
- [ ] 7. Review phase
- [ ] 8. Close-out
