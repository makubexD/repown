# ADR-026: Setup says what blocks the next push, and says done only without it

**Status:** Accepted. Amends [ADR-022](ADR-022-set-up-clone-opens-on-settled-screen.md) (a
settled clone with a blocker is not "nothing needs to change") and
[ADR-011](ADR-011-refuse-vs-warn.md) (setup warns about the variables the guard refuses).

## Context

In a field test, `repown setup` pinned a clone, printed `done: this clone is set up for
makubexD`, and the next `git push` was refused by repown's own guard (51 commits by other
addresses). The review had mentioned the commits, but after the steps, just before "Run them",
and "done" read as the opposite. The same clone pushed through a URL carrying a token.

A wizard audit and a newcomer walk of ten clone states through the real setup screens found
more states setup could see but never named, each making the next commit, pull or push fail:
identity or token variables in the shell, `author.email` in config, a destination owned by
someone else (setup asked only about origin), a branch diverged from its remote, no upstream
after answering No, a detached HEAD, and commits a fork's upstream has but its origin lacks.
The user's goal was a clone "ready to start coding and make any git operation without any
problem".

## Decision

- **Push blockers are read once, offline** (`src/core/push-state.ts`) and turned into ordered
  lines by one pure function (`src/wizard/blockers.ts`), shared by setup and its closing line:
  - commits by another address no remote has (the existing lines), and those another remote
    has but the push destination lacks, counted with the guard's own exclusion;
  - a sign-in carried by the push path: userinfo with a password or token in
    `branch.<b>.remote`, `remote.<dest>.url` or `pushurl`, or an `http.*.extraheader`. Reported
    by config key, never by value. A bare username (Git Credential Manager's own advice) is not one;
  - `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL`, `GH_TOKEN`, `GITHUB_TOKEN` set (names only), and
    `author.email` / `committer.email` in config;
  - the push destination's owner, when it is not the account or allowed;
  - divergence from the tracked ref, only when that ref is on the destination (a triangular
    workflow is not blocked);
  - no upstream, only where a plain `git push` fails for it (`push.default` simple/upstream,
    no pushRemote, no `push.autoSetupRemote`);
  - a detached HEAD. A fact that could not be read is a blocker of its own.
- **The review opens its notes with them.** The settled screen says
  `Its settings need no change, but the next push will fail:` instead of
  `Nothing needs to change.` when there are any.
- **The closing line is `done` only when a re-read after the run finds none.** Otherwise:
  `set up for <account>; the next push will fail: <first> (and N more below)`, then every
  blocker's lines. Exit codes are unchanged.
- The re-author advice offers `or pin that address` only when one address made them all.

## Alternatives considered

| Option | For | Against |
| --- | --- | --- |
| Keep "done", put the warnings earlier | Smallest change | "done" still reads as ready; `--no-input` on a settled clone showed nothing |
| Exit non-zero when a blocker remains | Scripts would notice | Reverses ADR-020 ("a warning, never a refusal"); the setup itself succeeded |
| Ask the guard question in Recommended when commits would be refused | The user decides | Turning the guard off is the wrong fix for commits that should be re-authored |
| Check every remote's owner | Simple | The guard checks the destination; other remotes are irrelevant to the push |

## Consequences

- A clone whose next push would fail never ends on `done`, and says why, even from a settled
  clone with `--no-input`.
- The closing re-reads the clone once more (a few git reads).
- `url.*.insteadOf` rewrites that add credentials are not read.
