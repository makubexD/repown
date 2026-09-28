# Decisions

Why repown is shaped the way it is, one decision per file. Much of it was measured:
against `cli/cli` source, git's own documentation, and live probes on a machine with two
GitHub accounts and five Azure Repos clones. Where something wasn't measured, the ADR
says so.

**The name:** repo + own. Each repository owns its identity, so any clone, on any
account, host or sign-in method, can be returned to without switching anything. The
name was free on npm, and is now this package.

| ADR | Decision |
| --- | --- |
| [001](ADR-001-credential-manager-not-gh.md) | Git credentials come from the credential manager; gh is for the CLI |
| [002](ADR-002-guard-checks-commits.md) | The guard checks commits, not configuration |
| [003](ADR-003-hook-calls-installed-cli.md) | The hook calls the installed CLI, and refuses when it cannot |
| [004](ADR-004-destination-owner.md) | The destination owner is checked, and organisations are listed explicitly |
| [005](ADR-005-guard-opt-in-per-clone.md) | The guard is opt-in per clone, and suits single-author repositories |
| [006](ADR-006-mirror-exemption.md) | The mirror exemption is opt-in, and narrower than skipping the branch |
| [007](ADR-007-no-profile-store.md) | No profile store; a per-machine account registry instead |
| [008](ADR-008-no-identifiers-in-repos.md) | No names or addresses live in any repository |
| [009](ADR-009-hosts-claim-only-measured.md) | Hosts are a strategy, and claim only what was measured |
| [010](ADR-010-typescript-on-node.md) | Strip-only TypeScript on Node, with zero runtime dependencies (that line superseded by 016) |
| [011](ADR-011-refuse-vs-warn.md) | The guard refuses only what's irreversible; the rest is a warning |
| [012](ADR-012-hook-ownership.md) | Which pre-push hooks count as repown's, and where they are |
| [013](ADR-013-deliberately-not-done.md) | Deliberately not done |
| [014](ADR-014-json-for-scripts.md) | `--format json` is the contract for scripts; text is for people |
| [015](ADR-015-releases-from-tags.md) | Releases are tag-driven and published from CI by trusted publishing |
| [016](ADR-016-clack-for-the-setup-wizard.md) | One optional runtime dependency, @clack/prompts, for the setup wizard |
| [017](ADR-017-setup-suggests-detected-accounts.md) | Setup suggests the accounts it can see, never the machine default |
| [018](ADR-018-bare-repown-guides-new-clones.md) | Bare repown guides a clone that isn't set up; scripts still get status |
| [019](ADR-019-repown-signs-accounts-in-to-gh.md) | repown can sign an account in to gh; the terminal is handed over, never read |
| [020](ADR-020-setup-leaves-clone-ready.md) | Setup leaves the clone ready to work, in one of two modes |
| [021](ADR-021-bare-repown-always-opens-setup.md) | Bare repown always opens setup in a terminal; scripts still get status |
| [022](ADR-022-set-up-clone-opens-on-settled-screen.md) | A settled clone opens on the already-set-up screen; a no-op pin is left out |
| [023](ADR-023-status-and-doctor-say-what-matters-first.md) | Status and doctor say what matters first |

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
- **A hook turned on through `npx` calls a temporary copy.** `guard on` warns when that
  copy is in npm's `_npx` cache (not pnpm's, yarn's or bun's), but `repown` and `repown
  doctor` don't recheck a hook already installed that way
  ([ADR-003](ADR-003-hook-calls-installed-cli.md)).
- **`gh pr create` and `gh api` act as gh's active account,** and no git config affects
  them. `repown status` notes when that account is different; a query it could not
  run stays a warning. Nothing can enforce it
  ([ADR-023](ADR-023-status-and-doctor-say-what-matters-first.md)).
- **Commits already made with the wrong author** must be rewritten by hand.
- **Hosts with no provider don't get credential pinning,** and `repown` says so.
- **SSO authorization can't be seen in advance.** A credential that's valid but not
  SSO-authorized for an organisation looks fine until a push or fetch against that
  organisation fails ([ADR-013](ADR-013-deliberately-not-done.md)).
- **Submodules are separate clones.** Unless each one is pinned and guarded,
  `git push --recurse-submodules` (or `push.recurseSubmodules`) publishes its commits unchecked while the
  superproject's guard reads `on`. `repown` warns when a clone has submodules.
- **"Already on the remote" is read from remote-tracking refs.** With a `pushurl`
  pointing somewhere other than `url`, those refs describe the fetch side. A commit
  fetched from a private `url` is then treated as already public when pushing to a
  public `pushurl`. The same applies to stale refs ([ADR-002](ADR-002-guard-checks-commits.md))
  and to a mirror branch ([ADR-006](ADR-006-mirror-exemption.md)).
- **A clone with nothing to compare the destination against** (no `repown.account`, no
  legacy credential key, no `repown.allowOwner`) prints `destination not checked` until
  `repown use` runs again there ([ADR-004](ADR-004-destination-owner.md)).
- **Only email addresses are compared, never names.** A commit carrying the right address
  under another name passes.
- **Pushing to a URL instead of a remote name** (`git push https://… main`) matches no
  remote-tracking refs, so a new branch has its whole history checked and any foreign
  ancestor is refused.
- **The destination check compares the owner, not the host.**
- **What git's parser shows is what gets checked.**
  - An object crafted with `hash-object --literally` can carry a second
    `author`/`committer`/`tagger` line that git ignores. Hosts that fsck incoming pushes
    reject these.
  - Merging a signed tag embeds that tag's tagger in a `mergetag` header, which isn't
    checked. That tagger is usually upstream's, and already public.
- **Git versions.** CI tests the runners' current git; no minimum is claimed. The test
  suite itself needs git 2.32 (`GIT_CONFIG_GLOBAL`).
