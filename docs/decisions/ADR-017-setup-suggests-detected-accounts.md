# ADR-017: Setup suggests the accounts it can see, never the machine default

**Status:** Accepted

## Context

With nothing recorded, setup asked for a login and offered no default, although it
had already read origin's owner, the accounts signed in to gh, and the accounts
Git Credential Manager stores.

The machine's global identity is the wrong thing to offer. It is often another
account's: a work identity on a machine that also holds personal clones. The
identity FAIL in `repown` exists precisely because inheriting it is the mistake.
No local `user.email` is a fail, because the next commit would carry the machine's
address ([ADR-011](ADR-011-refuse-vs-warn.md)).

## Decision

- **The first question lists the GitHub logins setup can already see.** Origin's
  owner, gh's accounts and Git Credential Manager's stored accounts are merged
  case-insensitively: one entry, the first spelling, every source in the hint, in
  that order (owner, then gh, then Git Credential Manager). A login already
  recorded is excluded and shown once, as the recorded account. Nothing is listed
  unless origin is on GitHub. Owner, gh and Git Credential Manager were measured
  for GitHub, and a host claims only what was measured
  ([ADR-009](ADR-009-hosts-claim-only-measured.md)).
- **Preselect the owner, and only an owner that is an account.** In order: the
  account this clone is already pinned to, when that account is recorded (the
  registry's spelling); else origin's owner when it is already recorded and is
  not known to be an organisation (the registry's spelling; a recorded account
  whose kind is unknown is still preselected); else the owner only when GitHub
  says it is a user. A recorded organisation stays in the list and is not the
  default: the next recorded account is, or **a new account** when it is the
  only one. The kind comes from one `gh api --hostname github.com users/<owner>`
  lookup, reading `type`: `User` is a user, `Organization` is an organisation.
  That lookup is skipped when the owner is already one of gh's accounts on
  github.com (gh lists accounts that signed in, never organisations) and when
  setup will not prompt (`--no-input`). A login seen only in gh or Git Credential
  Manager is never preselected. An organisation owner that is not recorded is
  not listed; the allow-owner question covers pushing to it. With no owner to
  preselect, the first recorded account is the default, or **a new account**
  when nothing is recorded.
- **The machine identity is shown on the name and email questions, and never
  filled in.** When the account still has to be recorded and this machine has a
  default name, the name question says "not this machine's default name
  (<name>), unless this account uses it". The email question gives the GitHub
  noreply tip first, then, when this machine has a default address, "; not this
  machine's default address (<email>), unless this account uses it". The name
  starts from the account's profile, or from the login; the email starts from
  the profile. On GitHub the profile's address is the noreply address
  ([ADR-008](ADR-008-no-identifiers-in-repos.md)).
- **A failed lookup only shortens the list.** When gh's accounts or Git Credential
  Manager's can't be read, those logins are absent. The failure stays a `Result`.
  A shorter list is not a passed check that found nothing
  ([CLAUDE.md](../../CLAUDE.md#hard-rules)). A `type` lookup that fails leaves the
  kind unknown: the owner stays on the list, the hint says it may be an
  organisation, and it is not preselected unless that login is already recorded.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Import the global identity as the first account | It is the identity that caused the problem in mixed machines. |
| Preselect gh's active account | Usually the work account. Same trap. |
| Record every detected account at once | Records accounts the user never picked. The registry stays a lookup table the user fills ([ADR-007](ADR-007-no-profile-store.md)). |
| No network lookup, treat the owner as a user | Would offer an organisation as an account. |

## Consequences

- Setup asks `gh api --hostname github.com users/<owner>` for `type` only when
  origin is on GitHub, origin has an owner, setup will prompt, and that owner
  is not already one of gh's accounts on github.com. `--hostname github.com`
  keeps `GH_HOST` from sending the lookup to another host.
  [docs/FAQ.md](../FAQ.md#questions) lists the call.
- Without gh, or when that lookup fails, the owner is listed and not preselected.
- A recorded organisation stays in the list and is not preselected.

## Notes

- **2026-10-02, the wording changed, not the decision.** The machine identity now reads
  "your default git name here is <name>: use it only if this account does too" (and the
  same for the address). The name question also says when it starts as the login ("GitHub
  shows no name for <login>, so this is the login"), and the email question names a
  prefilled noreply address as GitHub's private one instead of giving the `1234+` example.
