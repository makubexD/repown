# ADR-001: Git credentials come from the credential manager; gh is for the CLI

**Status:** Accepted

## Context

The goal is to authenticate once per account, and then have every repository work
without a prompt, even after switching which account you act as.

`gh auth setup-git` makes gh the git credential helper. It writes two entries per host:

```ini
[credential "https://github.com"]
    helper =                                      # EMPTY
    helper = !'…/gh.exe' auth git-credential
```

`gitcredentials(7)` says an empty value **resets the helper list**. So a working
`credential.helper = manager` underneath is discarded, and gh becomes that host's only
helper.

gh's helper (`pkg/cmd/auth/gitcredential/helper.go`) looks up `ActiveToken(host)`. It
uses the username git asks for only to reject a request, never to look one up:

| git asks gh for | gh returns |
| --- | --- |
| the active account | that account |
| any other account | **nothing**, exit 1, even though its token is in the same keyring |
| no username | the active account |

This check is identical in every tag from v2.4.0 to v2.89.0. Multi-account support
(v2.40.0) added stored accounts but didn't make the helper aware of them. cli/cli #8875
is open, and PR #13468, which would have added `--account`, was closed unmerged.

So while gh is the helper, every `gh auth switch` causes a password prompt in every
repository pinned to another account. For an account behind SSO, there is no password
to type. A wrapper that saves and restores around a switch can't help: there is no
state to save. The other token is already in gh's keyring; gh just won't serve it.

Git Credential Manager (GCM) stores one credential per account, keyed
`git:https://<user>@github.com`, and picks one per repository from
`credential.<url>.username`. Supporting several accounts this way is a documented GCM
feature.

## Decision

- **GCM serves git.** `repown use` pins `credential.https://github.com.username` per clone.
- **`repown fix` removes gh's two entries per host.** It shows what it will remove and
  how to undo it first, because changes to global config should be reviewable.
  - It removes only gh's own value (`!gh auth git-credential`, with or without gh's path)
    and the empty reset directly before it.
  - A composite helper, another CLI's helper and any other empty reset stay, because
    `gh auth setup-git` would never restore them.
- **gh stays the CLI's account store.** `gh auth switch` no longer affects git, so repown
  doesn't wrap it. `repown use --gh` just calls it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| gh as the helper | Serves only the active account (above). |
| SSH with repo-local `core.sshCommand` | Workable and cryptographically stronger, but adds key management on machines that use no SSH. |
| A PAT in the remote URL | Puts a live secret in `.git/config`. |
| A `GH_CONFIG_DIR` per repository | Copies gh's whole config per repository to change one field. |

## Consequences

- Git never needs a switch. Each clone authenticates as its own account, permanently.
- "Honours it" in `repown` output is claimed only when GCM is the helper, because that's
  the only helper that was measured (`src/commands/status.ts`).
- Re-running `gh auth login` may offer to configure git again, which re-adds the two
  entries. Decline it. `repown` and `repown doctor` both detect the re-added helper and
  name the fix.
