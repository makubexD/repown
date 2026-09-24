# ADR-009: Hosts are a strategy, and claim only what was measured

**Status:** Accepted

## Context

An author address means the same thing on every host. So commit pinning and the guard
work everywhere, even on hosts no provider knows.

Credential pinning is different. It needs the host's credential model to be understood.
A provider that guesses is worse than none: it writes config that **looks** like
configuration but selects nothing.

## Decision

Each host is one provider file in `src/core/hosts/`. A provider may pin credentials only
where that was measured:

| Host | Commit identity | Guard | Credential pinning |
| --- | --- | --- | --- |
| GitHub | yes | yes | yes over https ([ADR-001](ADR-001-credential-manager-not-gh.md)); over SSH, the SSH key decides and no helper is consulted |
| Azure DevOps | yes | yes | **no** |
| anything else | yes | yes | no |

**Azure DevOps is recognised but not pinned.** Leaving it to the generic provider would
be wrong, because its URL forms disagree about where the organisation is:

```
https://<org>.visualstudio.com/<project>/_git/<repo>    organisation is the SUBDOMAIN
https://dev.azure.com/<org>/<project>/_git/<repo>       organisation is the PATH
git@ssh.dev.azure.com:v3/<org>/<project>/<repo>         organisation follows v3/
<org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo> organisation follows v3/
```

A generic "the first segment is the owner" rule would report the *project* as the owner
on the legacy form. The guard would then let a push to another organisation pass.

Its credentials are left alone because what was probed didn't support pinning:
- `credential.https://dev.azure.com.usehttppath=true` ships in Git for Windows' system
  config, but doesn't apply to a `*.visualstudio.com` remote.
- With `credential.azreposcredentialtype=pat`, GCM's `azure-repos` namespace stays empty:
  the PAT is stored under the generic credential key and never appears there.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Pin Azure DevOps like GitHub | Not supported by what was measured. It would select nothing while looking configured. |
| Generic provider for Azure DevOps | Reads the wrong owner on the legacy URL form. |

## Consequences

- An empty `credentialKeys()` means "can't pin", never a guess. `repown` says so.
- Pinning Azure DevOps needs the PAT and OAuth paths each checked against a live remote.
  `src/core/hosts/azdo.ts` records the open questions.
