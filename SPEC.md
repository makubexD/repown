# Spec: repown leaves you signed in, not just configured

## Objective
After `repown setup`, `repown doctor` or `repown status` says a clone is ready, `git pull` and
`git push` must work as the pinned account. A field report (2026-11) showed the gap: the
clone was pinned, but the stored token had been revoked and then SAML SSO refused the new
one. 0.6.0's `repown doctor --online` finds that, but only prints advice. A review
(2026-11-27) found more places that say "ready" when git would fail, and bugs in `--online`.

This work does three things:
- Fixes what repown already says, offline and online.
- Makes the online check a guided repair: check, explain, offer, wait, check again.
- Ends setup with that check.

## Decided (2026-11-27, with the user)
- repown guides and waits instead of only printing: it offers each fix, runs it on a yes, and
  checks again until origin accepts or the user stops. It does this in a terminal only;
  without one, output is today's print-only advice.
- Setup ends with the online check, as an asked last step.

## Behaviour

### A. What repown says offline (no network)
| Case | Today | After |
| --- | --- | --- |
| origin's URL names a user (`https://octo-work@github.com/…`) other than the pinned account | status: "ready: pushes use octocat" | status, doctor and setup's check say git signs in as `octo-work` from the URL, and give the fix: set origin's URL without the user. Never "ready". |
| Pinned over GCM, but GCM holds no sign-in for the account | status: "ready" | **Dropped (2026-11-27):** not a failure, since the first push in a terminal opens GCM's browser sign-in. Setup's online check (D) offers that sign-in. And status's output would then depend on the GCM installed on the machine running it, including CI runners. |

### B. `repown doctor --online` (fixes to 0.6.0)
- **The URL described is the one probed.** The account, helper, host and SSO link come from
  the push URL of the remote a plain `git push` uses (`push-destination.ts`), not the first
  fetch URL with credential keys.
- **The remote probed** is that push remote. If it isn't origin, the heading names it.
- **New verdicts** (wording to be measured, task 2):
  - SSH key refused (`Permission denied (publickey)`): FAIL, naming the key problem.
  - Host key not trusted (`Host key verification failed`): FAIL, saying run `ssh -T git@<host>` once to trust it.
  - A token without write access (`Write access to repository not granted`): FAIL.
  - A ref the remote rejects after signing in (porcelain `!`): OK. The sign-in passed.
- **Every FAIL has a next step.** Under gh or another helper, `rejected` and `no-sign-in`
  point to `repown fix` when gh is the helper, and otherwise to signing in with that helper.
- **A deploy key** (`denied to deploy`) is said as such, never as "use the pinned account".
- **A progress line** ("asking origin…") goes on stderr before the probe.
- **Exit codes:** 0 when it passes, 1 on a FAIL, **3 when the check couldn't run** (offline,
  timeout, no commit, no origin). With `--online` a skipped check must not read as a pass.
  Without `--online`, exit codes are unchanged.

### C. The guided repair (terminal only)
In a terminal, after a FAIL, repown offers the fix that matches the verdict. It asks before
every action, then checks again. It loops until the check passes, the user says no or quits,
or there is no fix left to offer.

| Verdict | Offer | On yes |
| --- | --- | --- |
| gh is the helper (offline, before the probe) | "Undo gh's helper so each clone signs in as its own account?" | `repown fix`'s own `run()` |
| rejected / no sign-in, GCM, github.com | "Sign in to GitHub as `<account>` now?" | hand the terminal to `git credential-manager github login --username <account> --browser --force` (`inherit`, as for `gh auth login` in ADR-019) |
| SSO, link on origin's own host over https | "Open the authorisation page?" then "Press Enter once you've authorised it (q to stop)" | open the link in the browser (measured opener per OS; without one, only print it), wait, check again |
| SSO, no usable link | print where to authorise, wait for Enter, check again | — |
| denied as another account, and `repown use <pinned>` would change something | "Pin `<pinned>` again?" | `repown use`'s own `run()` |
| user in origin's URL (A) | "Remove `<user>@` from origin's URL?" | `git remote set-url` through `exec.ts` (local config only) |
| anything else, or not checked | no offer; the verdict and its printed advice | — |

Rules:
- No credential passes through repown, and repown never reads one.
- Every spawn goes through `exec.ts`, with `shell: false`; the browser opener never runs a shell.
- The same offer is made at most once per run. A repeated FAIL after a yes says so and stops
  offering it, so there is no endless loop.
- `--no-input` or no terminal: no offers and no waits; the output is the B text.

### D. Setup's last step
- After setup's commands run with no blocker, in a terminal, setup asks: "Check the sign-in
  with origin now? (recommended)". The default is Yes.
- A settled clone's opening review (nothing to change, ADR-022) offers the same check. That is
  where the field report's clone was.
- Yes runs B and then C inside setup's frame. Setup says "done" only when the check passes. If
  it fails or is skipped, the closing line says what is left (`sign-in not checked online`, or
  the verdict). As with every blocker (ADR-026), the exit code stays setup's own.
- Not asked under `--no-input`, without a terminal, with no origin, or with no commit (it says
  why in one line).
- The spawn budget for setup in a fresh, non-terminal clone does not change.

## Boundaries
- Never in the push path: `guard check` and `status` make no network call (ADR-004).
- No JSON changes (ADR-014).
- Commands are offered only where measured (ADR-009). The GCM login is offered for github.com
  only; other hosts get the verdict and advice without an offer.
- New decisions go in ADR-032, which supersedes ADR-031's "run the sign-in for the user" and
  "check online in setup" rows. ADR-031 is amended, not rewritten.

## Success criteria
- Each row of A, B and C has a test. Pure parts (classification, which offer, loop stop
  rules) are unit tests. Probes run end to end against local bare repositories; no test
  touches the network. Offers are tested with a scripted prompter, as in
  `wizard-screens.test.ts`.
- Without a terminal, doctor --online's output is the B text, with no prompt.
- `repown doctor` without `--online`, and setup with `--no-input`, behave as today.
- Spawn budgets unchanged, or changed with a reason in ADR-029.

## Measure first (task 2)
1. Does a dry-run push that gets a 401 make git run `credential reject`, so GCM erases the
   stored token? If it does, ADR-032 says so, and the repair offers sign-in as the fix that
   puts one back.
2. GitHub's exact stderr for an SSH key it refuses, an untrusted host key, a fine-grained
   token without write access, and an OAuth app not authorised for SSO. Anything that can't
   be measured stays unclassified (a WARN), never a guess.
3. How to open a URL without a shell: `explorer.exe <url>` vs `rundll32 url.dll,…` on Windows,
   `open` on macOS, `xdg-open` on Linux. Check that a query string with `&` survives each.
4. `git credential-manager github login` when the account is already stored: does it replace
   the token, and does the next probe pass?

## Riskiest assumption
That handing the terminal to GCM's login is as safe as handing it to `gh auth login`: repown
sees nothing GCM prints, and GCM writes its own store. Task 2 point 4 checks it.
