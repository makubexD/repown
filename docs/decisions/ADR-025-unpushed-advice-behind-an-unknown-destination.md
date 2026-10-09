# ADR-025: Unpushed-commit advice is conditional where no tracking ref reaches

**Status:** Accepted. Narrows the advice of [ADR-020](ADR-020-setup-leaves-clone-ready.md)'s
"pinning names unpushed commits"; the warning itself, its severity and its exit code are
unchanged. Amended by its 2026-10-09 note: a remote is known only for a branch its fetch
refspecs map, and its tracking refs are read where those refspecs write them.

## Context

`repown use` and setup's review count the commits on the current branch that no remote has,
and give a rebase that re-authors them: `git rebase <base>`, or `--root` when the oldest has
no parent. Both come from `HEAD --not --remotes`, which only knows remote-tracking refs.

A field test hit a clone whose `origin` had never been fetched. It had no tracking refs,
and its `branch.master.remote` was a URL with a token in it, left by an earlier
`git push -u <url>`. GitHub's `master` was 15 commits into local history. repown counted 66
unpushed commits and advised `git rebase --root`. The guard, which reads the tip the push
reports, refused 51. Following the advice would have rewritten 15 published commits and
needed a force-push.

The first fix treated `FETCH_HEAD` as "this remote was fetched", since a fetch of an empty
remote writes it but creates no tracking ref. A doubt review, with measurements on git 2.54,
disproved that. A FAILED fetch writes an empty `FETCH_HEAD`. So does a fetch of any other
remote, and a `git pull <url>`. The file is also kept per worktree. Each case brought
`--root` back.

## Decision

- **The destination is where `git push` with no arguments sends the branch:**
  `branch.<b>.pushRemote`, then `remote.pushDefault`, then `branch.<b>.remote`, then `origin`.
  There is no "only remote" fallback: with one remote not named `origin` and none of these
  set, `git push` fails with "No configured push destination" (measured, git 2.54). Other
  remotes are ignored. `.` or no destination means nothing is published, and the advice is
  unchanged.
- **The destination is unknown** when:
  - it is a configured remote with no ref under `refs/remotes/<name>/`, or that read fails;
  - it is a configured remote whose `pushurl` differs from its `url` (fetched from one
    place, pushed to another), however fetched;
  - it is not a configured remote: a URL, which never gets tracking refs, or a name that
    matches no remote;
  - `git remote` itself fails.

  Offline, an empty remote can't be told from an unfetched one, so the advice doesn't try.
- **Behind an unknown destination, the fact comes first, then the rebase only on a
  condition:**
  - `origin has no remote-tracking refs, so some of these may already be on it (the guard skips any already on the branch you push to): git fetch origin, then repown use <account> to count again`
  - then `if origin has none of them, re-author them: git rebase <base> ...`

  For a URL, the line names a configured remote with the same host and path, if there is
  one, with the config key that named the URL: `git config --local <key> <remote>`, then
  fetch. With none, it has no command. The URL itself is never printed. Remote names, keys
  and the account are shell-quoted, and a name git would read as an option (a leading `-`)
  gets no command at all.
- `src/core/push-destination.ts` holds the rule; `src/core/unpushed.ts` renders it.

## Alternatives considered

| Option | For | Against |
| --- | --- | --- |
| `FETCH_HEAD` as "fetched" | Offline; tells an empty fetched remote apart | A failed fetch, another remote's fetch or a URL pull writes it too; per worktree. Measured |
| `git ls-remote` for the real tip | Exact | Network and credentials in a read-only check; the pin may have just changed which account signs in |
| Print no rebase at all when unknown | Can't mislead | An empty new repository, the most common unknown case, would lose its only fix |
| Check every remote, not the push destination | Simple | An unrelated stale remote would suppress correct advice, and a pushRemote would be missed |

## Consequences

- The count sentence is unchanged, so behind an unknown destination it can overcount. The
  next line says so. The guard skips only what the pushed branch's remote tip already has
  (and only when that commit is here), so commits the remote holds on other branches are
  still refused.
- An empty remote stays unknown after a fetch, so it keeps the conditional line, which is
  right for it.
- A push by URL with no remote configured and no branch config leaves no trace; it keeps
  today's advice.
- A remote whose name nests in another's (`origin` and `origin/fork`, which `git remote add`
  refuses) can borrow the other's refs. Narrowed by the 2026-10-09 note.
- Known meant SOME tracking ref, not one for this branch. Fixed by the 2026-10-09 note.

## Notes

- **2026-10-09, known only for a branch the refspecs map.** A `--single-branch` clone
  (`--depth` implies it) fetches `+refs/heads/main:refs/remotes/origin/main`, so a feature
  branch pushed from it gets no tracking ref, yet the remote read as known and the plain
  rebase was offered over commits that push had published. Now `src/core/refspec.ts` reads
  `remote.<name>.fetch` as git does (globs, a short source name, `^` negative refspecs), and a
  remote is unknown (`untracked`) when its refspecs map no tracking ref for the branch a plain
  push updates: the upstream's under `push.default=upstream`, else the branch's own name. The
  line is `origin's <branch> is not fetched here (remote.origin.fetch leaves it out), so some
  of these may already be there (…)`, with no command: a fetch would not help.
  Tracking refs are now looked for where the remote's own refspecs write them (a remote that
  fetches into `refs/remotes/mirror/` was "never fetched"), minus any other remote's namespace
  nested inside (`refs/remotes/origin/x/` for a remote `origin/x`). A branch of origin's own
  named `x/...` is then not counted either: from refs alone the two can't be told apart.
  For: the plain rebase is offered only where a tracking ref would show what is published;
  asking git (`%(push)`) was measured and rejected: it is empty for any branch with no
  upstream under the default `push.default=simple`, so every new branch would have warned.
  Against: repown now reads refspecs itself, so a refspec form git adds later is read as
  "maps nothing", which errs towards the conditional line.
  Not changed: the advice lists commits in `git log`'s order, `repown reauthor` in
  `--topo-order`. They differ only around a merge, and reauthor refuses a merge in its range.
