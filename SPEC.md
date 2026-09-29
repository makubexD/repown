# Spec: setup leaves the clone push-ready

## Objective

After `repown setup` says a clone is ready, the next commit, pull and push work. Where setup
cannot make that true, it says exactly what still blocks and never prints plain "done".

Field case (2026-09-29): setup pinned the clone, printed `done: this clone is set up for
makubexD`, and the next `git push` was refused by repown's own guard (51 commits by other
addresses). The clone also had a token in `branch.master.remote` and had never been fetched.

Evidence (Phase 1): a wizard audit (WIZ-1..10), a newcomer walk of 10 clone states through the
real setup screens (`play()`), and research on git, GCM, gh, GitHub Desktop, VS Code, lazygit,
git-town, git-filter-repo and clig.dev. Summary of states that fail after "done":

| State | Next operation | Setup today |
| --- | --- | --- |
| Unpushed commits by other addresses | push refused by the guard | warns, no fix step, prints done |
| Push destination never fetched | count and base can be wrong | says fetch (ADR-025), never fetches |
| Token URL as the branch's remote | pushes sign in with the token, not the pin | claims "pushes as <account>" |
| `GIT_*_EMAIL`, `GH_TOKEN`, `GITHUB_TOKEN` set | wrong commit address; every push refused | silent |
| Branch pushes to a remote other than origin (org-owned) | guard refuses the owner | asks only about origin's owner |
| Diverged from the remote | pull and push fail (git) | silent |
| No upstream after answering No | push and pull fail (git) | silent on supported git |
| Detached HEAD | push fails (git); unpushed check skipped | silent |
| Settled clone with any of these | — | "Nothing needs to change" |

## Decisions (analysis requested by the user; recorded as ADR-026 and amendments)

| Decision | For | Against | Verdict |
| --- | --- | --- | --- |
| ADR-013 "no rewriting history": partly superseded | The user's explicit goal is a push-ready clone; the fix is mechanical and local; research gives proven safeguards | Destructive; no mainstream onboarding tool does it; wrong addresses may be a colleague's | **Supersede in part** (ADR-026): only via `repown reauthor`, asked in both modes, default No, only commits the push destination provably lacks, backup ref, never force-push, undo printed |
| ADR-022 settled screen | Today it says "Nothing needs to change" above "the guard will refuse them" | A settled clone opened fast; blockers setup can't fix (env vars) would reopen it | **Amend**: "nothing needs to change" only with no blockers; otherwise the screen names them and "Continue" leads to the fixes |
| ADR-020 ask the guard question in Recommended when blockers exist | Guard would refuse known commits | With a re-author step the right fix is the commits, not turning the guard off | **Keep ADR-020**; the blocker is shown beside the guard step |
| ADR-011 env variables: setup and status warn | The guard refuses them every time; earlier is kinder | The push may run from another shell (IDE) with a different environment | **Amend** the table: warn "in this shell", never refuse |
| ADR-020/023 status shows unpushed commits the guard would refuse | Status says `ready` while the push will be refused | Status gets one `git log` per run | **Amend**: status prints the same lines and does not say ready |
| ADR-004 setup asks about the owner of the push destination, not only origin | The guard checks the destination; setup checked origin | none | Implementation gap, no amendment |
| ADR-025 rebase base: parent of the oldest FOREIGN unpushed commit, not the oldest unpushed | Never rewrites the user's own commits (walk s1: `--root` rewrote 3 own published commits) | none | Recorded in ADR-026 |
| Setup fetches the push destination (network) | Only a fetch makes the count and base true; setup already uses the network for gh sign-in (ADR-019) | Credentials/offline; ADR-004 keeps the GUARD offline, not setup | **Adopt** as a reviewed step, on in Recommended, prompts off (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`); a failure is "could not fetch", never clean |

## Behaviour

### 1. Push blockers (read offline, shown first)
`src/wizard/blockers.ts` (pure) turns facts read once into an ordered list; setup's review and the
settled screen show it before the steps, and the closing line reads it. Revised after the doubt
review of Tasks 3-7 (16 findings, most measured on git 2.54; reconciled in the table below).
- foreign unpushed commits (existing `unpushedLines`, with ADR-025's unknown-destination line)
- commits the guard refuses although another remote has them (a fork: on `upstream`, not on the
  destination), counted with the guard's own exclusion (`--remotes=<destination>`)
- a sign-in carried by the push path, never printed: userinfo in `branch.<b>.remote` (a URL),
  `remote.<dest>.url` or `remote.<dest>.pushurl`, or an `http.*.extraheader`
- identity/token variables set in this shell (names only), and `author.email`/`committer.email` config
- push destination owner not allowed (destination, not origin)
- diverged from `@{u}`, only when `@{u}` is on the push destination (a triangular workflow is not
  blocked): "main is N behind and M ahead of origin/main: push and pull fail until you git pull --rebase"
- no upstream, only where a plain `git push` would fail: `push.default` unset/simple/upstream, no
  pushRemote/pushDefault, and `push.autoSetupRemote` off
- detached HEAD
- a fact that could not be read is its own blocker ("could not …"), never absent

### 2. New steps in setup (each a reviewed step, printed as its real command)
Order in the plan: repoint → fetch → accounts add → allowOwner → fix → use → guard → upstream → reauthor.
- **Repoint** (Recommended: on when a remote has the URL's host and path): `git config --local <key> <remote>`.
  Flag `--repoint`. Never prints the URL. Listed in the run's "changed in this clone".
- **Fetch** (Recommended: on only when there are foreign unpushed commits AND the destination is a
  configured remote with no tracking refs; a clean clone never fetches): `git fetch <remote>`.
  Flag `--fetch`. Always returns 0: a failure prints `WARN fetch could not fetch <remote> (<reason>)`
  (reason sanitised, URLs redacted) and the destination stays unknown; the rest of the plan runs.
- **Re-author** (asked in both modes, default No, only when foreign unpushed commits exist): "Re-author
  your unpushed commits by a@, b@ as <account>? Only if you made them; repown shows the exact list
  after fetching, and keeps a backup." Flag `--reauthor`. Runs `repown reauthor --yes` last, so a
  refusal (exit 1, like any failed step) skips nothing else.
- `--no-input`: unanswered = No (existing rule); `--fetch`/`--repoint`/`--reauthor` opt in.
- setup-run dispatch gets explicit cases for the new argv (no fall-through to `accounts add` or allowOwner).

### Network hygiene (fetch and ls-remote, in setup and reauthor)
Environment = the whole `process.env` plus `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, and with
`GIT_ASKPASS`/`SSH_ASKPASS` removed; `-c core.askPass=`; `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` unless the
user set one; `--no-recurse-submodules`; timeout 120 s. Rebase timeout: 10 minutes.

### 3. `repown reauthor` (new command; cli skill grammar, like `use` and `fix`)
`repown reauthor [--yes] [--cwd <dir>]`
1. Refuse (exit 1, nothing changed) when: detached HEAD; tracked changes or skip-worktree /
   assume-unchanged entries; a rebase, merge, cherry-pick or bisect in progress; no pin;
   `GIT_*_EMAIL`/`GIT_*_NAME` set or `author.email`/`committer.email` config (the rewrite would not use the pin);
   `commit.gpgsign` true with no terminal; destination `url`/`pushurl`/`unnamed`/`unread`.
2. `git fetch <destination>` (network hygiene). On failure: refuse, "could not fetch; nothing rewritten".
3. Known = the destination has tracking refs. With none: `git ls-remote --heads <destination>`; no heads
   proves it empty; heads but no tracking refs (no fetch refspec, mirror refspec, single-branch)
   → refuse ("this clone does not track <remote>'s branches").
4. Foreign = `HEAD --not --remotes` (published anywhere is never rewritten) whose author or
   committer is not the pin. None → "nothing to re-author", exit 0.
5. Refuse when `base..HEAD` contains a merge, or is not exactly the unpushed set from base on
   (never flatten or rewrite a commit a remote has). Base = full hash of the parent of the
   topologically oldest foreign commit (`--topo-order`); `--root` only when that commit is a root
   AND step 3 proved the destination empty; a root with a non-empty destination → refuse.
6. Show count, addresses, base (short) and "author dates are reset"; without `--yes` ask (terminal
   only; no terminal and no `--yes` → exit 2 naming `--yes`).
7. Backup `refs/repown/backup/<branch>/<unix-time>` → HEAD (excluded from scan's `--all` counts). Then
   `git -c rebase.updateRefs=false rebase --no-update-refs <base> --exec "git commit --amend --no-edit --no-verify --reset-author --allow-empty"`.
8. Rebase fails or times out → `git rebase --abort`; if HEAD is not the backup, report and exit 1.
9. Verify: re-read `base..HEAD` identities; any not the pin → exit 1 with the backup named.
10. Success: `OK reauthor N commits now by <address>`;
    `undo: git reset --keep refs/repown/backup/... (drops commits made since)`. Never pushes.
    Setup lists "history rewritten: N commits (backup refs/repown/...)" under changes.

### 4. Closing line and status
- Setup: `done: this clone is set up for <account>` only with no blockers left after the run
  (re-read); otherwise `set up for <account>; the next push will fail: <first blocker> (and N more above)`.
  Exit code unchanged (0) unless a step failed (existing rule).
- Settled screen and `--no-input` on a settled clone print the blockers (WIZ-2, WIZ-3).
- `repown status`: blockers printed in ADR-023's first block; `ready:` only without them.

### Doubt review (Tasks 3-7), reconciled
| # | Finding | Class | Where |
| --- | --- | --- | --- |
| 1 | a merge in the range: rebase flattens it and rewrites others' commits | actionable | reauthor 5 |
| 2 | a successful fetch does not prove empty | actionable | reauthor 3 (ls-remote) |
| 3 | 30 s timeout kills rebase/fetch | actionable | hygiene, reauthor 8 |
| 4 | user hooks run per amend | actionable | `--no-verify` |
| 5 | `rebase.updateRefs` rewrites other branches | actionable | reauthor 7 |
| 6 | `author.email`/env override the pin | actionable | reauthor 1, 9; blockers |
| 7 | a failed step halts setup; dispatch fall-throughs | actionable | setup steps |
| 8 | askpass, ssh prompts, submodules; env replaced whole | actionable | hygiene |
| 9 | blockers exclude all remotes, the guard only the destination | actionable | blockers (fork line) |
| 10 | the question's count is stale; tags | actionable (wording) / trade-off (tags: the guard ignores them too) | re-author step |
| 11 | backup refs in `--all` | actionable | reauthor 7 |
| 12 | run report hides the rewrite | actionable | repoint, reauthor 10 |
| 13 | clean clones would fetch | actionable | fetch trigger |
| 14 | triangular divergence, push.default=current | actionable | blockers |
| 15 | credentials via url/pushurl/extraheader | actionable (insteadOf: trade-off, documented) | blockers |
| 16 | dates, gpg, undo, short hash, root, dirty definition, fetch reason | actionable | reauthor 1, 5, 6, 10; hygiene |

## Out of scope
Force-push, rewriting anything the destination has, `--single-branch` refspec coverage
(ADR-025 gap), cmd.exe quoting, background fetching, rewriting tags.

## Tech, commands, structure
TypeScript strip-only, Node 20+. `npm test`, `npm run build`. New: `src/wizard/blockers.ts`,
`src/commands/reauthor.ts` (+ `src/program.ts` table, help), git methods in `src/core/git.ts`
(fetch with env, ahead/behind, rebase, update-ref, status porcelain), exec env support in
`src/core/exec.ts` if absent. Changed: `setup-context.ts`, `setup-flow.ts`, `setup-run.ts`,
`review-text.ts`, `status.ts`, `unpushed.ts` (base).

## Testing strategy
- Characterization first: current review/plan/closing for clean clones stays byte-identical
  (existing wizard-setup/screens tests green before any edit, plus new locks for the clean case).
- `test/reauthor.test.ts` (sandbox, bare remotes): every refusal; fetch failure; base = oldest
  foreign; own commits before it untouched; backup ref; undo restores; push then passes the guard.
- `test/blockers.test.ts`: each blocker from a hand-built context.
- `test/wizard-screens.test.ts`: the field case played end to end (repoint, fetch, re-author Yes →
  closing "done"; re-author No → closing names the blocker); env var; diverged.
- `test/status.test.ts`: blockers and no `ready:`.
- Scenario walk re-run (`scratchpad/walk/harness.ts`) as the acceptance check.

## Boundaries
- Always: tests seen failing first; docs in the same commit; ADR-026 before code that rewrites.
- Ask first: any change to the guard's refusals, exit codes, JSON.
- Never: force-push, rewrite commits the destination has, print a URL or token, run without a clean tree.

## Success criteria
1. Field case, Recommended + re-author Yes: setup ends with `done`, and `git push` passes the
   guard as a fast-forward; the 15 published commits are untouched.
2. Same with re-author No: closing line names the 51 refused commits; status does not say ready.
3. Walk scenarios s1–s9: every failure is named before "done", or fixed by a step.
4. Clean clones: output unchanged (characterization tests).
5. README, HOW-IT-WORKS (cards 3, 8, 13), FAQ, CONFIGURATION, CONTRIBUTING map, CHANGELOG,
   ADR-026 and the amended ADRs' status lines describe it.

## Open questions
- `repown reauthor` name: alternatives `repown commits reauthor` (noun-verb). Proposed: top-level,
  like `use`/`fix`, since it acts on the pinned clone.
