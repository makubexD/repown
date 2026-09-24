# Decisions

Why repown is shaped the way it is, one decision per file. Much of it was measured:
against `cli/cli` source, git's own documentation, and live probes on a machine with two
GitHub accounts and five Azure Repos clones. Where something wasn't measured, the ADR
says so.

**The name:** repo + own. Each repository owns its identity, so any clone, on any
account, host or sign-in method, can be returned to without switching anything.

| ADR | Decision |
| --- | --- |
| [001](ADR-001-credential-manager-not-gh.md) | Git credentials come from the credential manager; gh is for the CLI |
| [002](ADR-002-guard-checks-commits.md) | The guard checks commits, not configuration |
| [003](ADR-003-hook-calls-installed-cli.md) | The hook calls the installed CLI, and refuses when it cannot |
| [004](ADR-004-destination-owner.md) | The destination owner is checked; organisations are listed explicitly |
| [005](ADR-005-guard-opt-in-per-clone.md) | The guard is opt-in per clone, and suits single-author repositories |
| [006](ADR-006-mirror-exemption.md) | The mirror exemption is opt-in, and narrower than skipping the branch |
| [007](ADR-007-no-profile-store.md) | No profile store; a per-machine account registry instead |
| [008](ADR-008-no-identifiers-in-repos.md) | No names or addresses live in any repository |
| [009](ADR-009-hosts-claim-only-measured.md) | Hosts are a strategy, and claim only what was measured |
| [010](ADR-010-typescript-on-node.md) | Strip-only TypeScript on Node, with zero runtime dependencies |
| [011](ADR-011-refuse-vs-warn.md) | The guard refuses only what's irreversible; the rest is a warning |
| [012](ADR-012-hook-ownership.md) | Which pre-push hooks count as repown's, and where they are |
| [013](ADR-013-deliberately-not-done.md) | Deliberately not done |

**Adding one:** create the next number, using the same sections: Status, Context,
Decision, Alternatives considered, Consequences. Cite it as `ADR-0NN`. Never delete or
rewrite an accepted ADR. To reverse one, write a new ADR and mark the old one
`Superseded by ADR-0NN`.

## Residual risks

- **Hooks are advisory.** `git push --no-verify` skips the guard, and so does any tool
  that pushes through libgit2 rather than the `git` binary.
- **Environment variables outrank config.** The guard refuses when it can **see** them
  set. That's a check, not a guarantee.
- **A fresh clone has no hook** until `repown guard on` runs.
- **`gh pr create` and `gh api` act as gh's active account,** and no git config affects
  them. `repown` warns when that account is different; nothing can enforce it.
- **Commits already made with the wrong author** must be rewritten by hand.
- **Hosts with no provider don't get credential pinning,** and `repown` says so.
- **SSO authorization can't be seen in advance.** A credential that's valid but not
  SSO-authorized for an organisation looks fine until a push or fetch against that
  organisation fails ([ADR-013](ADR-013-deliberately-not-done.md)).
- **Submodules are separate clones.** Unless each one is pinned and guarded,
  `git push --recurse-submodules` publishes its commits unchecked while the
  superproject's guard reads `on`. `repown` warns when a clone has submodules.
- **"Already on the remote" is read from remote-tracking refs.** With a `pushurl`
  pointing somewhere other than `url`, those refs describe the fetch side. A commit
  fetched from a private `url` is then treated as already public when pushing to a
  public `pushurl`. The same applies to stale refs ([ADR-002](ADR-002-guard-checks-commits.md))
  and to a mirror branch ([ADR-006](ADR-006-mirror-exemption.md)).
- **A clone with no account to compare** prints `destination not checked` until
  `repown use` runs again there. That covers Azure DevOps and generic hosts pinned
  before `repown.account` existed ([ADR-004](ADR-004-destination-owner.md)).
- **The destination check compares the owner, not the host.**
- **What git's parser shows is what gets checked.**
  - An object crafted with `hash-object --literally` can carry a second
    `author`/`committer`/`tagger` line that git ignores. Hosts that fsck incoming pushes
    reject these.
  - Merging a signed tag embeds that tag's tagger in a `mergetag` header, which isn't
    checked. That tagger is usually upstream's, and already public.
- **Git versions.** CI tests the runners' current git; no minimum is claimed. The test
  suite itself needs git 2.32 (`GIT_CONFIG_GLOBAL`).
