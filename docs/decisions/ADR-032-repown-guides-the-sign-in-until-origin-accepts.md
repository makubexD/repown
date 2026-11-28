# ADR-032: repown guides the sign-in until origin accepts it

**Status:** Draft. Supersedes two rows of ADR-031's alternatives: "Run the sign-in for the
user" and "Check online in status or setup" (setup only; status stays offline).

## Context

ADR-031 added `repown doctor --online`, which prints a fix and stops. The user's goal is
for repown to leave the clone ready, so it should offer the fix, run it on a yes, wait where
the user has to act (an SSO approval page), and check again. A review on 2026-11-27 also
found offline cases where repown said "ready" while git would sign in as someone else.

## Measurements (git 2.50.1.windows.1, OpenSSH, github.com, 2026-11-27)

1. **A 401 erases the stored credential.** A logging credential helper answered `get` with
   a bogus token for a dry-run push to a public github.com repository. GitHub answered
   "Invalid username or token…" and git then called the helper with `erase` for that
   username and password. So the probe, like any real push, makes the helper forget a
   rejected token, and a second `--online` run reports "no sign-in stored". Either way the
   fix is to sign in again. git's source erases on 401 only, so an SSO 403 keeps the token
   (from reading the source; not measured, since that needs an SSO organisation).
2. **SSH, with `BatchMode=yes`:**
   - Host key not trusted: `No ED25519 host key is known for github.com and you have
     requested strict checking.` / `Host key verification failed.`
   - Key refused: `git@github.com: Permission denied (publickey).`
   - Both end with git's `fatal: Could not read from remote repository.` / `Please make
     sure you have the correct access rights` / `and the repository exists.`, which is why
     the last line alone (`networkReason`) said nothing useful.
3. Opening a URL without a shell, per OS: not yet measured (needs a visible browser).
4. `git credential-manager github login` over an account GCM already holds: not yet
   measured (needs the user's account).
5. Fine-grained token without write access, OAuth app not authorised for SSO: not measured.
   Until they are, those answers stay unclassified (a WARN with git's reason), never guessed.

## Decision

To be written with the implementation (SPEC.md, sections A–D).
