# ADR-026: Setup says what blocks the next push, and says done only without it

**Status:** Accepted. Supersedes in part [ADR-013](ADR-013-deliberately-not-done.md) (rewriting unpushed commits, only when asked). Amends [ADR-022](ADR-022-set-up-clone-opens-on-settled-screen.md) (a
settled clone with a blocker is not "nothing needs to change"),
[ADR-011](ADR-011-refuse-vs-warn.md) (setup warns about the variables the guard refuses), [ADR-020](ADR-020-setup-leaves-clone-ready.md) (done only without blockers) and [ADR-023](ADR-023-status-and-doctor-say-what-matters-first.md) (`WARN push` first; status's closing line). Amended by its 2026-10-09 note: reauthor leaves alone what the destination's branches and tags reach; by its 2026-10-10 notes: a sparse checkout's left-out files are no hidden change, a timeout stops what git started, a sign-in is judged on the URLs git pushes with, and a later push URL owned by someone else is a blocker.

## Context

In a field test, `repown setup` pinned a clone, printed `done: this clone is set up for
octocat`, and the next `git push` was refused by repown's own guard (51 commits by other
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
  lines by one pure function (`src/core/blockers.ts`), shared by setup, its closing line and `repown status` (first among its warnings, `WARN push`; a missing upstream stays in its field there):
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
- **Setup can remove two blockers itself, as reviewed steps** (Recommended answers Yes; `--no-input`
  only with the flag):
  - *repoint* (`--repoint`): where the branch pushes to a URL naming the same host and path as a
    remote, `git config --local <key> <remote>`. The URL can hold a token, so the review, the step
    and the run's report show the key and the remote only;
  - *fetch* (`--fetch`): only where commits by another address wait behind a remote with no
    tracking refs (a clean clone never fetches), `git fetch <remote>` with prompts off, as
    `reauthor` does. A failure is a warning and the destination stays unknown: the other steps
    still run. The guard stays offline ([ADR-004](ADR-004-destination-owner.md): no network call in the push path); setup already uses the
    network for gh's sign-in ([ADR-019](ADR-019-repown-signs-accounts-in-to-gh.md)).
- **With the guard off, what only the guard would refuse blocks nothing.** Commits by another
  address, commits another remote has, the destination owner and `GH_TOKEN`/`GITHUB_TOKEN` are
  still said, as `the guard is off, so …`, but setup says `done` and status `ready`. A hook this
  clone does not own, or a redirected `core.hooksPath`, counts as guarded: it may call the
  guard, and saying a push will fail beats saying one will pass. Identity variables and config,
  a diverged branch, a sign-in in the URL and a detached HEAD block either way.
- **The settled screen offers Re-author them** where unpushed commits carry another address:
  it reviews the one `repown reauthor --yes` step, as Sign in to gh reviews `use --gh`.
- **Setup asks before it re-authors** (`--reauthor`): only where unpushed commits carry another
  address, default No and never filled in by Recommended, since only the user knows whether they
  made them. It runs `repown reauthor --yes` last, so a refusal skips no other step; like `fix`,
  Enter at the review is Decline and at the step is Skip.
- **Network calls never prompt** (setup's fetch; reauthor's fetch and `ls-remote`): the whole
  environment with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, no askpass,
  `-c core.askPass=`, and `--no-recurse-submodules`; ssh gets `BatchMode=yes` only where neither
  `GIT_SSH_COMMAND`, `GIT_SSH` nor `core.sshCommand` names a command already, since setting it
  would replace a per-account key. A fetch times out at 120 s, the rebase at 10 minutes.
- **`repown reauthor` rewrites, only when asked.** ADR-013 turned rewriting down as destructive
  and the owner's call; the owner now makes that call with one command, and repown makes the
  rewrite as narrow as it can be:
  - it refuses on a detached HEAD, uncommitted or hidden (skip-worktree) changes, an operation
    in progress, an unpinned clone, identity variables or `author.*`/`committer.*` config that
    would outrank the pin, `commit.gpgsign` without a terminal, and a destination that is not a
    remote it can fetch;
  - it fetches the push destination first, prompts off (a sign-in that would ask fails instead),
    and needs its tracking refs; with none, `git ls-remote` must show it empty, or it refuses;
  - it rewrites from the parent of the topologically oldest commit by another address that no
    remote has, and refuses when that range holds a merge or any commit a remote has;
  - a backup ref `refs/repown/backup/<branch>/<time>` first, then `git rebase` with
    `git commit --amend --no-edit --no-verify --reset-author --allow-empty` (hooks off, other
    branches' refs left alone); on failure the rebase is aborted; afterwards every rewritten
    commit is checked. It prints the undo (`git reset --keep <backup>`) and never pushes.

## Alternatives considered

| Option | For | Against |
| --- | --- | --- |
| Keep "done", put the warnings earlier | Smallest change | "done" still reads as ready; `--no-input` on a settled clone showed nothing |
| Exit non-zero when a blocker remains | Scripts would notice | Reverses ADR-020 ("a warning, never a refusal"); the setup itself succeeded |
| Ask the guard question in Recommended when commits would be refused | The user decides | Turning the guard off is the wrong fix for commits that should be re-authored |
| Check every remote's owner | Simple | The guard checks the destination; other remotes are irrelevant to the push |
| Keep rewriting out (ADR-013) | Nothing destructive in repown | The user asked for a clone ready to push; the manual `git rebase` advice was the step most likely to go wrong (its `--root` would have rewritten 15 published commits in the field) |
| `git filter-repo --mailmap` | Handles merges | A new dependency; rewrites every ref unless limited; refuses outside a fresh clone without `--force` |
| Rewrite without fetching | Offline | Only a fetch shows what the destination has; without it the range can include published commits |

## Consequences

- A clone whose next push would fail never ends on `done`, and says why, even from a settled
  clone with `--no-input`.
- The closing re-reads the clone once more (a few git reads).
- `url.*.insteadOf` rewrites that add credentials are not read.

## Notes

- **2026-10-03, the destination owner follows git.** Setup, status, `use` and the blockers read
  the owner from `git remote get-url --push` (`pushurl`, `pushInsteadOf`, `insteadOf` applied),
  the URL the pre-push hook hands the guard, instead of the raw `remote.<r>.pushurl`/`url`. A
  push straight to a URL is read through `ls-remote --get-url` (`insteadOf` only). Credentials
  written into a rewritten URL are still not read (the gap listed above).
- **2026-10-09, reauthor asks the destination what it has.** `--not --remotes` only sees
  tracking refs, so a clone that fetches only some branches (`--single-branch`, `--depth`, a
  negative refspec), or a pushed tag, hid commits the destination already had, and reauthor
  rewrote them. After its fetch, reauthor now lists the destination's branches and tags
  (`git ls-remote --heads --tags`), peels each to a commit here (`cat-file`, lazy fetching off),
  and leaves out what they reach, on stdin as `^<sha>` lines. A branch tip this clone lacks is
  a refusal (`<remote> has commits this clone has not fetched (…)`), with no command: a
  one-off fetch of every branch would leave refs no `fetch --prune` removes. A tag on a commit
  this clone lacks is skipped, since tags are fetched only when they follow a fetched branch.
  The `untracked` destination (ADR-025) is accepted on these terms. A destination whose push
  URLs, after `pushInsteadOf` and with every `url`, differ from its fetch URL is refused, and
  the advice treats it as unknown.
  For: the rewrite skips everything the destination's branches and tags reach, which is what
  the next push would otherwise collide with. Against: one more network call, and only heads
  and tags are listed (Gerrit's `refs/changes/*` and other namespaces are not: listing every
  ref would make GitHub's `refs/pull/*` a refusal everywhere). Other remotes still count only
  through their tracking refs. A tag on a commit this clone lacks could in principle sit on top
  of these commits; that case is accepted. The read-only advice stays offline (ADR-025), so it
  can offer a rebase reauthor then narrows or refuses.
- **2026-10-10, a sparse checkout is no hidden change.** Reauthor refused any skip-worktree
  entry, and sparse-checkout sets that bit on every file it leaves out, so it refused in every
  sparse checkout. With `core.sparseCheckout` on, an entry marked skip-worktree alone (`S` in
  `git ls-files -v`) whose file is not on disk now counts as left out; a test measured that the
  rebase keeps every commit's tree and leaves those files out. A skip-worktree file that is on
  disk, any assume-unchanged bit, and every skip-worktree bit outside a sparse checkout still
  refuse. The list now covers the whole work tree (`-- :/`), so running from a subfolder no
  longer misses a hidden file elsewhere.
  For: a sparse checkout can be re-authored, and nothing a rebase could overwrite is let
  through. Against: one `lstat` per left-out file, slow in a very large monorepo; and a file
  written between the check and the rebase is not seen, as with every other check here.
- **2026-10-10, a timeout stops what git started.** At its timeout `run` killed only its
  direct child, then waited for the output pipes to close. On Windows the `git` on PATH is
  often a wrapper (`cmd\git.exe`) whose real git outlives it, and a git alias's shell
  outlives git anywhere; both hold the pipes, so a timed-out fetch or rebase was reported only
  when it finished on its own. Now, on Windows, the whole tree is ended with
  `taskkill /PID <pid> /T /F` while the child still runs (repown holds its handle, so the PID
  is still its own), and the child itself is killed after; on POSIX the child gets SIGTERM as
  before. Either way `run` stops waiting 3 s later, with the result marked timed out and never exit
  0. A child that exits in time while something it started still holds the pipes gets the
  same 3 s, then resolves with its own exit code. A soft
  `taskkill` was measured as useless here: a console process can only be ended forcefully.
  The fetch and `ls-remote` calls also put `--` before the remote (ADR-025's 2026-10-10 note).
  For: a timed-out command is reported within seconds, and on Windows nothing it started
  keeps running. Against: a forced end runs no cleanup, so a lock git held (`index.lock`)
  stays for the person to remove, as the rebase failure message already says how to finish;
  on POSIX what git started (an `--exec` shell, ssh) can outlive the SIGTERM, since making the
  child a process-group leader would keep Ctrl-C from reaching it.
- **2026-10-10, not changed: setup stays offline after its one fetch.** A teammate's commit on
  a remote this clone never fetched is not seen, so setup can say done while the next push is
  non-fast-forward. Finding it needs a network call per remote; git's own refusal at push
  time already names it.
- **2026-10-10, a sign-in is judged on the URLs git pushes with.** The check read the last
  `remote.<r>.pushurl` or `url` as configured. A `url.<base>.insteadOf` or `pushInsteadOf`
  rule whose base holds a token signed every push in unseen, a token in an earlier value of a
  remote with several URLs was missed, and a rule that took a token out was still reported.
  Now each URL `git remote get-url --push --all` prints is checked. One that is a configured
  value is named by its key, as before; any other came from git's own rewriting, and the line
  names only the remote: `origin's push URL, as git resolves it, carries its own sign-in`.
  The rule is never named, since its key holds the token in its name. When git can't list the
  URLs (before 2.7, or config it refuses), the configured key is checked as before, and no
  error text is kept: git's message can quote the key. A push straight to a URL is unchanged.
  For: the line agrees with what git sends, rewrites and git 2.46's empty-value reset
  included, without repown copying git's matching rules. Against: a rewritten sign-in gets no
  key to fix by hand; `git config --show-origin --get-regexp '^url\.'` lists the rules.
- **2026-10-10, a later push URL owned by someone else is a blocker.** Git runs the pre-push
  hook once per push URL, so with two `pushurl`s (or two `url`s and none) the guard can refuse
  one while the other takes the push; the tracking ref then moves as if all of it landed.
  Setup and status read only the first URL's owner. Now a `pushurls` blocker, right after the
  owner one, names each later URL's owner and host (never the URL) that the chosen account and
  `repown.allowOwner` don't cover, with the command that allows it, and blocks while the guard
  is on. URLs come from `git remote get-url --push --all`, deduplicated, or from the
  configured values when git can't list them. A URL with no owner (a local path) is skipped,
  as the guard skips it. When the first URL is refused itself, the owner line speaks alone.
  For: the half-landed push is said before it happens, judged as the owner line judges the
  first URL. Against: the first-owner logic elsewhere (status's `origin` row, `use`'s warning,
  setup's allow question, scan's JSON) still names one owner: reporting every owner there was
  measured as a much wider change and rejected.
