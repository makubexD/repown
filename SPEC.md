# Spec: an opt-in sign-in check (`repown doctor --online`)

## Objective
In the field, a clone was correctly pinned, but git couldn't push: the stored sign-in had been
revoked ("Invalid username or token"), and later the org enforced SAML SSO on the token
("organization has enabled or enforced SAML SSO", 403). `repown doctor` is offline
(ADR-004, ADR-013), so it said everything was fine, and the user had to diagnose git's errors
by hand. `repown doctor --online` asks origin once, as the clone's pinned account, and turns
the answer into the fix.

## Decided (2026-11-27, with the user)
- Surface: a `--online` flag on `repown doctor`, not a new command. Without it doctor stays
  offline and unchanged.
- On a failure repown prints the exact command to run; it never runs a sign-in itself and never
  reads a credential.

## How (measured on git 2.50, GCM 2.6.1, github.com)
- `git push --dry-run --no-verify --porcelain origin HEAD:refs/heads/repown-sign-in-check`,
  with every prompt off (`QUIET`, `quietEnv`), through `exec.ts`. A dry run sends no objects;
  `--no-verify` keeps the guard hook out of it. Through `origin`, git uses its push URL and the
  pinned `credential.<url>.username`, so the account that answers is the one a push would use.
- A read (`ls-remote`) is no check: a public repository answered it with a bogus token
  (exit 0), because GitHub never asked for the credential. The push endpoint always asks:
  with the bogus token it answered "Invalid username or token ... Authentication failed".
- git's whole stderr is classified, not only its last line (`networkReason` keeps the last).
  The SSO answer's useful line is the `remote: To access this repository, visit <url>` before it.

## Answers (each a line in doctor, never a silent pass)
| git said | Verdict | Fix printed |
| --- | --- | --- |
| exit 0 | OK: origin accepts `<account>`'s sign-in for a push | none |
| `SAML SSO` | FAIL: the org enforces SSO and this sign-in isn't authorised | the `visit <url>` link git printed, then `repown doctor --online` |
| `Invalid username or token`, `Authentication failed` | FAIL: the host rejected the stored sign-in (expired or revoked) | GCM: `git credential-manager github login --username <account> --browser --force`; other helpers: sign in again with that helper |
| `Permission to … denied to <user>` | FAIL: signed in as `<user>`, who can't push here | `repown use <account>`, or ask for access |
| `Repository not found` | FAIL: `<account>` can't see origin (wrong account or no access) | check the account, or ask for access |
| `unable to get password`, `Cannot prompt because user interactivity has been disabled`, `could not read Username`, `terminal prompts disabled` | FAIL: no sign-in stored for `<account>` | GCM login command as above |
| timeout, `Could not resolve host`, anything else | WARN: couldn't check, with git's cleaned reason | none |
| unborn HEAD, no origin, outside a clone | WARN: nothing to check with, and why | none |

## Boundaries
- Never in the push path: `guard check`, `status` and setup stay offline (ADR-004).
- No JSON (doctor has none). Exit 1 on a FAIL above; a WARN keeps doctor's exit code.
- Advice names the host's commands only where measured: the GCM login command for github.com
  (ADR-009). Elsewhere the verdict is given without a command.

## Success criteria
- Classification is a pure function, tested on each measured stderr; the probe is tested end to
  end against a local bare repository (OK) and an unborn HEAD (WARN). No test touches the network.
- `repown doctor` without the flag prints byte for byte what it does today.
- ADR-031 (amends ADR-013's SSO row); README, HOW-IT-WORKS doctor card, CHANGELOG,
  CONTRIBUTING map.

## Riskiest assumption
That a dry-run push never changes the remote. git's dry run stops after the ref
advertisement and sends no pack; measured with `--porcelain` on a public repository.
