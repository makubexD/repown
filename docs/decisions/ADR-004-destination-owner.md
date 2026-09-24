# ADR-004: The destination owner is checked, and organisations are listed explicitly

**Status:** Accepted

## Context

A push can carry the right identity to the wrong repository. The guard compares the
destination's owner, parsed from the URL, with the clone's account, `repown.account`.
`repown use` writes that key on every host.

Before `repown.account` existed, the account came only from the credential key. Azure
DevOps and generic hosts never had that key. On those hosts the check had nothing to
compare, and it passed silently.

An organisation's name is never an account name. On its own, the check would refuse
every push to an organisation's repository, which covers most repositories at work.

## Decision

- **Organisations are listed per clone.** `repown.allowOwner` lists additional owners,
  one per entry. It's read only from the clone's own config, and so are
  `repown.mirrorBranch` and `repown.allowTagger`. A global entry would quietly widen
  every clone on the machine.
- **An unchecked destination is reported.** When the owner can't be compared, the guard
  prints `destination not checked`. This happens with a local path, a URL with no owner,
  or no account pinned.
- **The owner comes from the URL path, never from userinfo.** So
  `https://octocat@github.com/someone-else/repo` doesn't pass.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Look up organisation membership from the host API | Puts a network call and an auth dependency in the push path, where a rate limit or an offline laptop becomes a failed push. |
| Read `allowOwner` from global config | Widens every clone at once. |

## Consequences

- Listing one owner widens nothing else. Every other owner is still refused.
- `repown use` and `repown` print the exact `git config --local --add repown.allowOwner <org>`
  to run when they see an owner that isn't allowed.
- The check compares the owner, not the host. A clone pinned to `octocat` passes a push
  to `gitlab.com/octocat/...`. Commit identity is still checked there.
- Clones pinned by older versions still keep their destination check. Those versions
  wrote `credential.<scheme>://<host>.username` for every remote, SSH included. The guard
  reads that as the account when `repown.account` is missing.
