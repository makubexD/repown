# An opt-in sign-in check

Status: task 3 done; next task 4.

- [x] 1. Plan: SPEC.md and this file. Docs: none.
- [x] 2. Classify git's answer to a dry-run push (pure)
  - Accept: each row of SPEC's table, from measured stderr, gives its verdict and fix; the SSO
    link is the `visit <url>` git printed; unknown text is a WARN with the cleaned reason.
  - Where: `src/core/signin-check.ts`.
  - Docs: none yet.
- [x] 3. `repown doctor --online`
  - Accept: the flag runs one dry-run push to origin (prompts off, hook skipped) and prints the
    verdict above doctor's closing line; exit 1 on FAIL; a local bare origin is OK; an unborn
    HEAD or no origin is a WARN; without the flag doctor's output is unchanged.
  - Where: a probe in `src/core/git.ts`, the option and a print in `src/commands/doctor.ts`.
  - Docs: ADR-031, README, HOW-IT-WORKS doctor card, CHANGELOG, CONTRIBUTING map.
- [ ] 4. Docs sweep and close-out.
