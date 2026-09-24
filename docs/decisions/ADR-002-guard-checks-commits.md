# ADR-002: The guard checks commits, not configuration

**Status:** Accepted

## Context

A push from the wrong account can be undone. The account isn't a collaborator, so the
push fails with a 403 and nothing is published.

A commit from the wrong author can't be undone. `user.email` is baked into the author
and committer fields. Once pushed to a public repository, it stays in the history, in
forks, in mirrors and with scrapers. If the address is verified on another account, the
host credits the commit to that account.

Checking "is the config right at this moment" is only a proxy. A commit made before
setup, or on a branch where the identity was never applied, passes as soon as the
config is corrected.

## Decision

The `pre-push` hook reads the refs being pushed from stdin. It checks the author **and**
committer address of every commit in the range being published. That covers commits made:
- before setup, or after `repown off`;
- on any branch;
- by a merge, rebase or cherry-pick;
- in an IDE with its own identity.

The range leaves out what the remote already has (`--not --remotes=<remote>`). A commit
on a remote-tracking ref became permanent when it was first published, so pushing it to
another branch publishes nothing new. Without this, a fork that merges upstream into its
release branch would be refused for every upstream commit.

The guard also refuses when:
- `GH_TOKEN` or `GITHUB_TOKEN` is set: gh's helper then sets `gotUser = "x-access-token"`
  and skips its username check entirely;
- `GIT_AUTHOR_EMAIL` or `GIT_COMMITTER_EMAIL` is set: each quietly overrides the config
  that was just checked.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Check the config at push time | A proxy: commits made before the config was fixed pass. |
| A `pre-commit` hook | See [ADR-013](ADR-013-deliberately-not-done.md). It only partly covers the risk. |

## Consequences

- A remote-tracking ref can be stale, for example a branch that was deleted or
  force-pushed on the server. It can then exclude a commit that isn't really published
  any more. `git fetch --prune` fixes this.
- Commits already made with the wrong address are reported (`repown scan`), never rewritten.
