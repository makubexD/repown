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

## Assumptions

Revised after the doubt review (Task 1): the first draft used `FETCH_HEAD` as "was fetched".
Rejected: a FAILED fetch writes an empty `FETCH_HEAD` (measured, git 2.54), so does a fetch of
any other remote or a `git pull <url>`, and it is per worktree. Each of those brought `--root`
back. Nothing offline can tell an empty remote from an unfetched one, so the advice is made
conditional instead.

1. The destination is where `git push` with no arguments sends the branch:
   `branch.<b>.pushRemote`, else `remote.pushDefault`, else `branch.<b>.remote`, else `origin`
   if configured, else the only remote if there is exactly one. `.` (this repository) and no
   destination at all mean nothing is published: unchanged advice. Other remotes are ignored.
2. The destination is UNKNOWN when it is a configured remote with no ref under
   `refs/remotes/<name>/` (or that read fails: unknown, never "none"), or when it is not a
   configured remote at all (a URL; the field case's `branch.master.remote`). A URL keeps no
   tracking refs, ever.
3. Offline only: no `ls-remote`, no fetch.
4. The count sentence stays as it is. The next line says the guard skips what the remote has.
5. It stays a warning with an unchanged exit code (ADR-011, ADR-020); nothing is rewritten
   (ADR-013). Recorded as ADR-025.
6. Accepted gaps: a push by URL with no remote and no branch config leaves no trace (today's
   advice); a remote name nested in another's (`origin` and `origin/fork`), which `git remote
   add` refuses, can borrow the other's refs.

## Behaviour

| Destination | Lines after the count sentence |
| --- | --- |
| None, `.`, or a remote with tracking refs | unchanged: `re-author them: git rebase <base> ...` |
| Remote `origin`, no tracking refs | `origin has no remote-tracking refs, so some of these may already be on it (the guard skips those): git fetch origin, then repown use <account> to count again` then `if origin has none of them, re-author them: git rebase <base> ..., or pin that address` |
| A URL (key `branch.main.remote`), a configured remote `origin` has the same host and path | `this branch pushes to a URL, not a remote, so some of these may already be there (the guard skips those): git config --local branch.main.remote origin, git fetch origin, then repown use <account> to count again` then `if it has none of them, re-author them: ...` |
| A URL, no remote matches | the same first sentence, no fix clause; then `if it has none of them, ...` |

The URL itself is never printed (it may hold a token, as in the field case). Remote names go
through `shellWord`. Every rebase printed for an unknown destination is behind "if ... has none
of them", which is exactly when `--root`/`<base>` is right.

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
- origin holds the first commit (pushed by path, no tracking ref): fetch line + conditional
  rebase; after `git fetch origin` the base is origin's tip and the fetch line is gone.
- The field case: `branch.main.remote` = origin's URL: URL line suggesting
  `git config --local branch.main.remote origin`; the URL is not printed.
- A failed fetch (origin's path removed) still gives the fetch line, not a bare rebase.
- `branch.main.pushRemote` names an untracked remote while origin is tracked: unknown.
- No remote: unchanged (existing S19 tests untouched).
- Pure line tests in `test/wizard-setup.test.ts` for setup's review, incl. a remote name
  that needs quoting.

## Boundaries

- Always: tests first and seen failing; `npm test` + `npm run build` green; docs in the same commit.
- Ask first: changing the count sentence, the guard, `repown status`, or any JSON output.
- Never: network calls, writing git config, rewriting commits, pushing.

## Success criteria

1. The field case prints no unconditional `git rebase` and names how to count again.
2. After a successful fetch the base is the remote tip; after a failed one, still conditional.
3. No remote / tracked destination: output byte-for-byte as today; exit codes unchanged.
4. HOW-IT-WORKS, FAQ, CHANGELOG `[Unreleased]` and ADR-025 describe it.
