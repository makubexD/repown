# Spec: config read through include.path

## Objective
`repown fix` must undo `gh auth setup-git` wherever git reads it from. Reported in the field:
the gh helper pair sat in `~/.gitconfig.local`, pulled in by `include.path` from
`~/.gitconfig`. `repown doctor` found it (an unscoped `--show-origin` read follows includes)
and said "fix: repown fix"; `repown fix` said "nothing to undo", because
`git config --global --get-all` does not follow includes. The user was left in a loop.

Root cause (measured, git 2.50): git turns `include.*` off whenever a scope or file is
named, unless `--includes` is passed. Every scoped READ repown makes has the same blind spot,
e.g. the machine default identity (`identity.ts`) reads `user.email` with `--global`, so one
kept in an included file reads as unset. And a scoped WRITE (`--global --unset-all`) edits
only the top file: it exits 5 and leaves the included file as it was.

## Items
1. **Scoped reads follow includes.** Every read `Git` sends with a scope passes `--includes`,
   and the snapshot's per-scope `--list -z` does too (ADR-029), so a scope means "what this
   scope contributes, includes and all", as git applies it. Writes are unchanged.
   Done: a value only in a file included from the global config is read by `getConfig`,
   `getAllConfig(Raw)`, `getBoolConfig` with `'global'`, and by a snapshot, identically.
2. **`fix` edits the file that holds gh's entries.** `planRepair` reads each scope once
   (`--show-origin --includes -z --get-regexp` over both hosts' helper keys), groups values by
   file, and plans one entry per (file, key) holding gh's value. `repair` rewrites that key in
   that file (`--file=`). The preview names the file, so the edit is reviewable.
   Done: with gh's pair in an included file, `doctor` and `fix` agree; `fix --yes` removes it
   from the included file, leaves the top file untouched, and `--get-urlmatch` then answers
   with the helper underneath. A gh pair in the top file behaves exactly as before.

## Out of scope (asked about separately)
- A sign-in git's helper holds that the host rejects (expired token, SAML SSO not
  authorised). Seeing that needs a network call; doctor is offline today.
- Following GitHub's documentation for changes over time.

## Success criteria
- A failing test per item first, then green; full suite and build green on the three OSes.
- Spawn budgets: the setup budget may rise by the 3 per-scope reads that now go to git
  instead of the snapshot; the reason goes into ADR-029.
- ADR-030 records the decision, measured; HOW-IT-WORKS fix card, CONFIGURATION, CHANGELOG.

## Riskiest assumption
That `--includes` on a scoped read never shows a value git would not use for that scope.
Measured: git applies an included file at the include's position, under the including
file's scope; `--includes` reports exactly that.
