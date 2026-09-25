# ADR-005: The guard is opt-in per clone, and suits single-author repositories

**Status:** Accepted

## Context

The guard refuses any foreign author in the range being pushed. That's right in a
repository where every commit should be yours. In a shared repository it's wrong,
because pushing a branch that contains a colleague's commit is ordinary work. A guard
that refuses ordinary work gets switched off, and the identity pin often goes with it.

## Decision

- `repown use` pins the identity only. `repown guard on` is a separate step, per clone.
- The docs say plainly where not to turn it on: for example, a maintainer who applies
  contributors' patches locally.
- Commits the remote already has are skipped ([ADR-002](ADR-002-guard-checks-commits.md)).
  So pulling, merging and pushing a collaborator's work that's already been pushed all pass.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Turn on the guard with `repown use` | Refuses ordinary work in shared repositories, so it gets switched off. |

## Consequences

- Some of a collaborator's commits are still refused: ones the remote has never seen,
  such as commits you cherry-picked or rebased, or fetched from their clone.
- For a team, the right control is a server-side ruleset on author addresses
  ([ADR-013](ADR-013-deliberately-not-done.md)).

## Amendments

- **2026-09-25, guided setup.** `repown setup` asks about the guard as its own question,
  per clone, defaulting to Yes and saying first how many other addresses are in the
  clone's history. It is still a separate, explicit step: shown in the review before
  anything runs, and never taken for granted without a terminal, where `--guard` must be
  passed. `repown use` still pins the identity only.
