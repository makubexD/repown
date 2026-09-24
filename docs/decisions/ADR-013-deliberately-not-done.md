# ADR-013: Deliberately not done

**Status:** Accepted

## Context

Each item below would fix something real. Each was weighed and turned down, for the
reason given.

## Decision

| Not done | What it would fix | Why not |
| --- | --- | --- |
| `includeIf "gitdir:…"` in global config | The gap between `git clone` and `repown use`, where a commit inherits the machine's identity | It adds new behaviour to global config, where `repown fix` only ever removes. The guard catches those commits at push time. |
| A `pre-commit` hook | Catching a wrong-author commit as it's made | `commit --no-verify`, merge, rebase, cherry-pick and revert all skip it. It only partly covers a risk that the range check ([ADR-002](ADR-002-guard-checks-commits.md)) covers fully. |
| Rewriting existing history | Commits that already carry the wrong address | Destructive, and only the owner can weigh that. `repown scan` reports them. |
| Detecting SSO authorization in advance | A credential that's valid but not yet SSO-authorized for an organisation looks fine until the push fails | Nothing offline can see it (below). |
| A server-side ruleset on author addresses | The only control `git push --no-verify` can't bypass | It's a setting per repository, not per machine. Worth doing if `--no-verify` becomes a habit, or for a team ([ADR-005](ADR-005-guard-opt-in-per-clone.md)). |

**Why SSO authorization can't be seen in advance.** This was measured, not assumed.
- `gh auth status --json hosts` (gh v2.89.0, and `pkg/cmd/auth/status/status.go` on
  `trunk`) has three `state` values: `success`, `timeout` and `error`. `error` means only
  that resolving the token's login failed. It's never scoped to one organisation.
- SAML/SSO is enforced per organisation when a resource is accessed. So the only way to
  observe it is a request to that organisation's resources, and that's the network
  dependency [ADR-004](ADR-004-destination-owner.md) rejects.
- `git credential-manager diagnose` writes free-form logs for a person to read, not
  anything a program can check.

## Consequences

See the [residual risks](README.md#residual-risks) these choices leave.
