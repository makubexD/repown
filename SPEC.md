# Spec: unpushed-commit advice on a never-fetched remote

## Objective

`repown use` and setup's review warn about commits on the current branch that no remote has,
and give a `git rebase <base> --exec "... --reset-author"` to fix them (`src/core/unpushed.ts`).
Both "unpushed" and `<base>` come from `HEAD --not --remotes`, which only knows remote-tracking
refs. In a clone whose remote was never fetched there are none, so every commit looks unpushed
and the advice is `git rebase --root`. That rewrites commits the remote already has, and a push
then needs `--force`.

Field case (repown 0.3.0): `origin` never fetched; its `master` was 15 commits into local
history. Setup said 66 unpushed and advised `--root`; the guard, which uses the pushed tip,
refused 51. Following the advice would have rewritten 15 published commits.

User: anyone pinning a clone they committed in before fetching (a repo made locally and pushed
once with a token URL, a clone whose tracking refs were deleted).

Success: repown never prints a rebase command that can reach below what a never-fetched remote
may already have. It says to fetch first instead.

## Assumptions (correct these at the gate)

1. "Never fetched" = the clone has a remote with no ref under `refs/remotes/<name>/`, AND no
   `FETCH_HEAD` in the git dir (`rev-parse --git-path FETCH_HEAD`). Measured on git 2.54: a
   fetch of an EMPTY remote creates no tracking ref but does write an empty `FETCH_HEAD`, so
   without the second condition a brand-new empty GitHub repo would be told to fetch forever.
2. Offline only: no `ls-remote` (network, credentials; repown's checks here are read-only and
   local).
3. The count sentence stays as it is ("N commits on <b> not on any remote are by ..."). It is
   still literally true of the tracking refs; the new line says why it may be too high.
4. The remote named is the branch's own remote if it is a configured remote name, else
   `origin`, else the first never-fetched remote. A branch whose `branch.<b>.remote` is a URL
   (the field case) falls through to `origin`.
5. It stays a warning with an unchanged exit code (ADR-011, ADR-020); nothing is rewritten
   (ADR-013).

## Behaviour

| Clone | Line after the count sentence |
| --- | --- |
| No remote at all | unchanged: `re-author them: git rebase --root ...` (or `<base>`) |
| Remote fetched (tracking refs or `FETCH_HEAD`) | unchanged |
| Remote never fetched | `origin has never been fetched, so some of these may already be on it: git fetch origin, then pin again to recount` — and no rebase command |

`them`/`it` and the `, or pin that address` tail follow the existing wording rules only where a
rebase line is printed.

## Tech stack, commands, structure

TypeScript on Node (strip-only), no framework tests. `npm test`, `node --test test/use.test.ts`,
`npm run build`. Code: `src/core/unpushed.ts` (fact + lines), `src/core/git.ts` (reads: reuse
`remotes()`; add at most one reader for "has tracking refs / FETCH_HEAD"). Callers unchanged:
`src/commands/use.ts:276`, `src/wizard/setup-context.ts:168`, `src/wizard/setup-flow.ts:658`.

## Code style

As the file already is: small pure functions, `Result` for failures, text through `show()`.

```ts
function reauthorLine(count: number, base: string | null): string[] {
  if (!base) return [];
  ...
}
```

## Testing strategy

`sandbox()` from `test/helpers.ts`, commits via the existing `commitAs` in `test/use.test.ts`.
- Never fetched: a bare remote holding the first commits, `remote add origin`, no fetch →
  warning has the fetch line, no `git rebase`.
- Same clone after `git fetch origin` → base is the short hash of the remote's tip; count drops.
- Empty remote fetched once (FETCH_HEAD, no tracking refs) → `--root`, as today.
- No remote → unchanged (existing S19 tests stay green, untouched).
- Setup's review shows the same line (`test/wizard-setup.test.ts`).

## Boundaries

- Always: tests first and seen failing; `npm test` + `npm run build` green; docs in the same commit.
- Ask first: changing the count sentence, the guard, `repown status`, or any JSON output.
- Never: network calls, writing git config, rewriting commits, pushing.

## Success criteria

1. The field case prints no `git rebase`, and names `git fetch origin`.
2. After the fetch the base is the remote tip, not `--root`.
3. An empty remote that was fetched still gets `--root`.
4. Existing S19 tests pass unchanged; exit codes unchanged.
5. HOW-IT-WORKS (unpushed rows), FAQ and CHANGELOG `[Unreleased]` describe the new line.

## Open questions

- Wording of the new line (proposal above).
- Should `repown status` also warn here? Proposed: no, out of scope (it doesn't show the
  unpushed warning today).
