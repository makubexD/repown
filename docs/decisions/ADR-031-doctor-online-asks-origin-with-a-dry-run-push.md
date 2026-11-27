# ADR-031: `repown doctor --online` asks origin with a dry-run push

**Status:** Accepted. Amends ADR-013's "Detecting SSO authorization in advance" row: it is
still not done in advance, but it can now be checked on request.

## Context

A field report (2026-11): a clone was correctly pinned, but git couldn't pull or push. The
stored sign-in had been revoked ("Invalid username or token. Password authentication is not
supported"), and once that was replaced, the organisation's SAML SSO refused the new token
(403, with an approval link). `repown doctor` reported the machine as ready, because it is
offline by design: ADR-004 keeps the network out of the push path, and ADR-013 found nothing
offline that can see SSO. The user had to diagnose git's errors with outside help.

## Decision

- **An opt-in flag, `repown doctor --online`.** Without it, doctor is unchanged and makes no
  network call. Nothing else calls the check: `guard check`, `status` and setup stay offline.
- **The check is one dry-run push**, `git push --dry-run --no-verify --porcelain origin
  HEAD:refs/heads/repown-sign-in-check`, run as every other network call is (`QUIET`,
  `quietEnv`: no terminal prompt, no askpass, GCM non-interactive), through `exec.ts`.
  - Through `origin`, git uses the push URL and the pinned `credential.<url>.username`, so
    the account that answers is the one a real push would use.
  - `--dry-run` stops after the ref advertisement and sends no pack: no ref is created
    (tested against a bare repository, and measured on github.com).
  - `--no-verify` keeps repown's own guard (or any pre-push hook) out of it.
  - `--no-recurse-submodules` overrides `push.recurseSubmodules`. With `on-demand`, a review
    measured git running each submodule's own dry-run push, which contacts that remote and
    runs that submodule's pre-push hook (`--no-verify` doesn't reach it); with `check`, an
    unpushed submodule commit turned the answer into "the remote end hung up".
  - **The account named is the username git sends**: the pinned
    `credential.<url>.username`, only where repown pins one over HTTPS. Over SSH, to a local
    path, or on a host repown doesn't pin (ADR-009), no account is named, since none signed
    in by name. `repown.account` is used only for the `repown use` fix when git signed in
    as someone else.
- **The whole stderr is classified** (`classifySignIn`, `src/core/signin-check.ts`), first
  match wins, SSO first, because its 403 also reads as "unable to access":

  | git said | Verdict |
  | --- | --- |
  | exit 0 | ok |
  | `SAML SSO` | sso, with the `visit <url>` link GitHub printed |
  | `Permission to … denied to <user>` | denied, naming who signed in |
  | `Invalid username or token`, `Authentication failed` | rejected |
  | `Repository not found` | not found |
  | `unable to get password`, `Cannot prompt because user interactivity has been disabled`, `could not read Username`, `terminal prompts disabled` | no sign-in stored |
  | a timeout, or anything else | unchecked: a WARN with git's cleaned last line (`networkReason`), never a pass |

- **repown prints the fix and runs nothing** (decided with the user). It never reads or
  writes a credential. The GCM command, `git credential-manager github login --username
  <account> --browser --force`, is printed only for origin on github.com over HTTPS with GCM
  as its helper, where it was measured (GCM 2.6.1), and only when `copyableCommand` can quote
  the account. Elsewhere the verdict comes without a command (ADR-009).
- **The SSO link is printed as GitHub sent it**, query included, because it is the fix. It
  goes to the user's own terminal (stderr); `networkReason`'s query masking is for reasons
  that get pasted, not for this line. The text is the remote's, so the link is shown only
  when its host is origin's own; otherwise the line says to authorise the sign-in in the
  organisation's SSO settings.
- **Exit code:** a FAIL makes doctor exit 1; a WARN keeps doctor's own code. No commit yet,
  no origin, or outside a clone is a WARN that says why.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| `git ls-remote` (a read) | Measured on github.com: a public repository answered with a bogus token, exit 0, because the host never asked for the credential. A revoked token would read as fine. |
| A command of its own | One more command for a question doctor already owns ("how this machine signs in"). Decided with the user. |
| Ask the host API (`gh api`, `/user`) | Tests gh's token, not the one git's helper holds, and needs gh. The push endpoint answers for the credential git actually sends. |
| Run the sign-in for the user (hand the terminal to GCM, as ADR-019 does for gh) | More surface for a rare repair; the printed command is one paste. Can be revisited. |
| Check online in status or setup | Puts the network and a 2-minute timeout where people expect an instant answer (ADR-004). |

## Consequences

- The field report's two failures each get a one-line cause and a one-paste fix.
- `--online` takes as long as one push handshake: usually under a second, and up to the
  2-minute network timeout when the host doesn't answer.
- The classification depends on GitHub's wording. A changed message becomes a WARN with
  git's own last line, never a wrong pass. New wording is a new pattern and a test.
- Hosts other than github.com get the verdicts their errors match (git's own "Authentication
  failed" is generic), but no command, until one is measured.
