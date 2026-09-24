# ADR-008: No names or addresses live in any repository

**Status:** Accepted

## Context

A repository may be public, and anything committed to one is published permanently.

## Decision

- The tool contains no identifiers.
- Everything personal lives in `.git/config`, which git can't track, or in the
  per-machine registry ([ADR-007](ADR-007-no-profile-store.md)).
- Examples use `octocat`, `octo-org`, `octo-work` and `*.example.invalid`.
- `repown scan` prints domains and counts by default, not addresses, because its output
  gets pasted into chats. `--emails` shows the addresses.
- On GitHub, `repown use` suggests the account's noreply address,
  `<id>+<login>@users.noreply.github.com`. That address is meant to be published and
  still links the commit to the account.

## Consequences

- Setup is per machine, and a re-clone repeats `repown use`. This cost is deliberate.
- The noreply suggestion needs gh installed and signed in, because the numeric id comes
  from `gh api`. Without gh, the prompt has no default.
