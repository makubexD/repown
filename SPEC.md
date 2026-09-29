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
`src/wizard/blockers.ts` (pure) turns the context into an ordered list; setup's review and the
settled screen show it before the steps, and the closing line reads it.
- foreign unpushed commits (existing `unpushedLines`, with ADR-025's unknown-destination line)
- a branch remote that is a URL with userinfo (never printed): "this branch pushes to a URL that
  carries its own sign-in; pushes use it, not <account>"
- identity/env variables set in this shell (names only)
- push destination owner not allowed (destination, not origin)
- diverged from the tracked ref: "main is N behind and M ahead of origin/main: git pull --rebase first"
- no upstream and `push.autoSetupRemote` stays off: "the first push needs git push -u origin <b>"
- detached HEAD: "HEAD is detached: git switch <branch> before pushing"; foreign commits counted

### 2. New steps in setup (each a reviewed step, printed as its real command)
Order in the plan: repoint → fetch → accounts add → allowOwner → fix → use → guard → upstream → reauthor.
- **Repoint** (Recommended: on when a remote has the URL's host and path): `git config --local <key> <remote>`.
  Flag `--repoint`. Never prints the URL.
- **Fetch** (Recommended: on when the push destination is a configured remote with no tracking
  refs, or diverged may be stale): `git fetch <remote>` with prompts off, via `exec.ts`.
  Flag `--fetch`. A failure prints `WARN fetch could not fetch <remote> (<reason>)` and the
  remote stays unknown.
- **Re-author** (asked in both modes, default No, only when foreign unpushed commits exist):
  "Re-author N commits by a@, b@ as <account>? Only if you made them. A backup is kept."
  Flag `--reauthor`. Runs `repown reauthor --yes`.
- `--no-input`: unanswered = No (existing rule); `--fetch`/`--repoint`/`--reauthor` opt in.

### 3. `repown reauthor` (new command; cli skill grammar, like `use` and `fix`)
`repown reauthor [--yes] [--cwd <dir>]`
1. Refuse (exit 1, nothing changed) when: detached HEAD, dirty tree, rebase/merge in progress,
   no pin, or the destination is `url`/`pushurl`/`unnamed`/`unread` ("point the branch at a remote first").
2. `git fetch <destination>` (prompts off). On failure: refuse, "could not fetch; nothing rewritten".
   After success the destination is known: tracking refs, or none because it is empty.
3. Foreign commits = `HEAD --not --remotes` whose author or committer is not the pinned address.
   None → "nothing to re-author", exit 0.
4. Base = parent of the oldest foreign commit (`--root` only when it has none and the fetch
   showed the destination empty). Show the count, addresses and base; without `--yes` ask
   (terminal only; no terminal and no `--yes` → exit 2 naming `--yes`).
5. Backup: `refs/repown/backup/<branch>/<unix-time>` → HEAD. Then
   `git rebase <base> --exec "git commit --amend --no-edit --reset-author --allow-empty"`.
   Commit signing, if configured, applies to the new commits; existing signatures are dropped (said).
6. Rebase fails → `git rebase --abort`, branch back at the backup, exit 1.
7. Success: `OK reauthor N commits now by <address>`; `undo: git reset --keep refs/repown/backup/...`.
   Never pushes; never touches anything the destination has.

### 4. Closing line and status
- Setup: `done: this clone is set up for <account>` only with no blockers left after the run
  (re-read); otherwise `set up for <account>; the next push will fail: <first blocker> (and N more above)`. Exit code unchanged (0).
- Settled screen and `--no-input` on a settled clone print the blockers (WIZ-2, WIZ-3).
- `repown status`: blockers printed in ADR-023's first block; `ready:` only without them.
  `--format json` unchanged (no status JSON exists; scan/accounts untouched).

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
