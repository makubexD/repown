# ADR-006: The mirror exemption is opt-in, and narrower than skipping the branch

**Status:** Accepted

## Context

Some forks have a branch (for example `master`) that only fast-forwards to upstream. It
legitimately carries other people's addresses.

The previous design had an exemption written for one mirror branch, and it applied by
default. It quietly covered every feature branch as well.

## Decision

- **`repown.mirrorBranch` names the branch, and only in local config.** Unset means no
  exemption.
- **On that branch, the guard skips commits on any remote.** A commit already on any
  remote-tracking ref, upstream's included, is public already and doesn't count.
- **Commits made here are still checked.** A commit on no remote was made in this clone.
  Skipping the branch outright would let `git push origin feature:master` publish anything.
- **Tags get the same wider rule on such a clone.** Their taggers are still checked, and
  a fork names upstream's taggers in `repown.allowTagger`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Exempt the mirror branch by default | That's how every feature branch ended up exempt. |
| Skip the branch entirely | Lets any commit be pushed to it. |
| Name the upstream remote in its own key | Would close the private-remote gap below, at the cost of another setting for a case no user has. |

## Consequences

- Fetch upstream before pushing the mirror branch.
- A commit that only a **private** remote has isn't public, yet on the mirror branch it
  doesn't count. So a clone with a private remote shouldn't set `repown.mirrorBranch`.
