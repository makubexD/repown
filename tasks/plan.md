# Implementation Plan: unpushed-commit advice on a never-fetched remote

Spec: [../SPEC.md](../SPEC.md).

## Overview

`readUnpushed` gains one fact, the never-fetched remote (or null). `unpushedLines` prints
the fetch line in place of the rebase line when it is set. `repown use` and setup's review
both render `unpushedLines`, so the fix reaches both without touching their callers.

## Architecture decisions

- Signal: a configured remote with no `refs/remotes/<name>/*` and no `FETCH_HEAD` in the
  git dir. A fetch of an empty remote writes `FETCH_HEAD` (measured, git 2.54), so a fetched
  empty remote still gets `--root`.
- Reads through `Git` (`remotes()` exists; add one method for "has tracking refs" and one for
  the `FETCH_HEAD` path, or a single `fetchedEver`). No network. `exec.ts` stays the only spawner;
  the `FETCH_HEAD` existence check is a filesystem stat.
- Remote choice: the branch's remote if it names a configured remote, else `origin`, else the
  first never-fetched remote.
- `UnpushedFact.unfetched: string | null` (required), so every literal in tests states it.
- No new ADR: ADR-020's decision stands; this fixes its advice.

## Dependency graph

Git readers → `readUnpushed` fact → `unpushedLines` → (use.ts, setup-flow.ts, unchanged)

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Worktrees keep `FETCH_HEAD` per worktree | Low: a linked worktree may be told to fetch once | `rev-parse --git-path FETCH_HEAD`; a fetch there cures it |
| Stale tracking refs still undercount the remote | Existing, bounded (check.ts notes it) | Out of scope |
| Clone of an empty repo: no `FETCH_HEAD` | Told to fetch once, then `--root` | Accepted: fetch is harmless |

Tasks and checkpoints: [todo.md](todo.md).
