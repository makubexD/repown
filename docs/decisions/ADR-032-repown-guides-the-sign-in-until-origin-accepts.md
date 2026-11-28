# ADR-032: repown guides the sign-in until origin accepts it

**Status:** Accepted. Supersedes two rows of ADR-031's alternatives: "Run the sign-in for the
user" and "Check online in status or setup" (setup only; status stays offline). Amends
ADR-031's exit code: a check that couldn't run is 3, no longer doctor's own code.

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

- **The URL described is the URL asked.** `--online` asks the remote a plain `git push`
  uses (`push-destination.ts`; origin when that is a URL or can't be read), and its account,
  helper, host and SSO link all come from that remote's push URL
  (`remote get-url --push`), not the first fetch URL with credential keys.
- **The account named is the username git sends.** A bare username in the push URL
  outranks the pinned `credential.<url>.username` (measured), so it is the one named. A
  user part that may be a secret (`user:pass`, a `ghp_`/`github_pat_` prefix, or anything
  that doesn't look like an account name, such as a 40-hex token) is never printed or passed
  on; it is the existing sign-in fact by key.
- **Offline, a username in the push URL is a blocker.** status and setup say git signs in
  as that user, not the pinned account, and print the `git remote set-url` command that
  removes it (`src/core/blockers.ts`). It is never "ready".
- **New verdicts, from measured text:** an SSH key refused, a host key not trusted, and a
  deploy key without write access (named as such, never as an account called "deploy"). A
  ref the remote rejects after the sign-in (a porcelain `!` line) is a pass. A token without
  write access and an OAuth app not authorised for SSO are not measured, so they stay
  unclassified (a WARN with git's reason).
- **Every FAIL names a next step**, by helper: `repown fix` under gh; GCM's measured
  github.com command; the helper's own sign-in elsewhere; installing GCM when no helper
  serves the URL.
- **Exit codes:** 0 on a pass, 1 on a FAIL, **3 when the check couldn't run** (offline, a
  timeout, no commit, no remote). A skipped check must never read as a pass.
- **In a terminal, repown guides the repair** (`src/core/signin-repair.ts`,
  `src/commands/signin-guide.ts`): after a FAIL it offers the one fix that matches, runs it
  on a yes, and checks again, until the check passes, the user says no (or q, or Ctrl-C), or
  nothing is left to offer:

  | Verdict | Offer | On yes |
  | --- | --- | --- |
  | rejected or no sign-in, gh as the helper | none of its own | `repown fix`'s own `run()`, which previews what it removes and asks (default No) |
  | rejected or no sign-in, GCM, github.com, a pinned (not URL) username | "Sign in to GitHub as `<account>` now?" | the terminal is handed to `git credential-manager github login --username <account> --browser --force` (`inherit`, as for `gh auth login` in ADR-019); repown sees nothing GCM prints |
  | SAML SSO | the link (on the push URL's own host) is printed with the verdict | wait for Enter, check again; as often as the user asks, until q |
  | denied as another account, where git sends a username that isn't the pinned one | "Pin `<pinned>` to this clone again now?" | `repown use`'s own `run()` |
  | denied as another account, where git already sends the pinned username | the GCM login above | the stored token is another account's |
  | anything else | no offer; the verdict and its advice | — |

  Each repair but the SSO wait is tried once; when the same one comes back after it ran,
  repown says it didn't help and stops. Each round re-reads the clone, since a repair
  changes the config the next check depends on. After a repair, doctor's closing line says
  the report above was read before it.
- **Setup ends with the check, asked.** Once setup's commands have run (or a settled clone's
  review ends with Done) and nothing blocks the next push, setup asks "Check the sign-in with
  the remote now? (one dry-run push: nothing is sent)", default Yes, and runs the same check
  and guided repair. The closing line says "done" with `· <remote> accepts the sign-in` only
  on a pass; a refusal replaces "done"; a no, a check that couldn't run, or a skip (no
  commit, no remote, said in the line) adds `· sign-in not checked online`. The exit code
  stays setup's own (ADR-026). Never asked under `--no-input` or without a terminal, so the
  spawn budget is unchanged.
- **Without a terminal nothing is offered or awaited**: doctor --online prints the verdict
  and its advice, as in ADR-031.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Open the SSO link in the browser | No opener is measured per OS without a shell, and the link is the remote's own text. It is printed, and repown waits. |
| Run `git remote set-url` for a username in the URL | That URL is a blocker, so the check never runs while it is there; status and setup already print the exact command. |
| Check online in status | Same reason as ADR-031: status is instant and offline (ADR-004). |
| Report "GCM holds no sign-in for the account" in status | Not a failure (the first push in a terminal signs in), and status's output would depend on the GCM of the machine running it. Setup's last step offers that sign-in instead. |
| `repown fix --yes` after the loop's own question | The yes would come before the user saw which entries, in which file, it removes. |

## Consequences

- After setup in a terminal, "done" means origin accepted the sign-in, or the closing line
  says what is left.
- GCM's `--force` login over an account it already holds (point 4) is unmeasured: it is
  offered on the strength of the command measured for a fresh sign-in. If it misbehaves, the
  loop says the repair didn't help and stops, and the printed advice remains.
- Ctrl-C at any of these questions stops the guide (as No) instead of cancelling the
  command, so setup's closing line and summary still print.
