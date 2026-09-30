# Tasks: setup leaves the clone push-ready

Status: Phase 4 build done (T1–T8). Checkpoint B next: walk, Phase 5 review, Phase 6 close-out

- [x] Phase 1 clarify (audit WIZ-1..10, newcomer walk s1–s9, research; scope: detect + fix + opt-in re-author)
- [x] Phase 2 spec (SPEC.md approved; command name `repown reauthor`)
- [x] Phase 3 plan (GATE 3)

## Task 1 — Lock today's clean-clone output [x]
- Acceptance: characterization tests pin setup's review, plan and closing for a clean clone, the
  settled screen with no blockers, and `repown status` on a ready clone; green before any edit.
- Verify: `node --test test/characterization.test.ts test/wizard-screens.test.ts`
- Files: `test/characterization.test.ts` (and/or `test/wizard-screens.test.ts`)
- Docs: none — tests only, no behaviour change

## Task 2 — Rebase base: the parent of the oldest FOREIGN unpushed commit [x]
- Acceptance: own commits before the first foreign one are never in the rebase; `--root` only
  when the oldest foreign commit is the root; ADR-025 behaviour otherwise unchanged.
- Verify: `node --test test/use.test.ts test/wizard-setup.test.ts`
- Files: `src/core/unpushed.ts`, `src/core/git.ts`, `test/use.test.ts`
- Docs: HOW-IT-WORKS card 3 row and card 8, FAQ ("parent of the oldest of those commits"), CHANGELOG

## Task 3 ⚠ — Blockers: what will make the next commit, pull or push fail [x]
Reads git config and the environment.
- Acceptance: `blockers(ctx)` returns, in order: foreign unpushed; sign-in URL remote (never
  printed); `GIT_*_EMAIL`/`GH_TOKEN`/`GITHUB_TOKEN` set; destination owner not allowed; diverged
  (N behind, M ahead); no upstream with autoSetupRemote off; detached HEAD (+ foreign count).
  A failed read is a blocker "could not read …", never absent.
- Verify: `node --test test/blockers.test.ts test/wizard-setup.test.ts`
- Files: `src/wizard/blockers.ts`, `src/wizard/setup-context.ts`, `src/core/git.ts`,
  `src/core/unpushed.ts` (detached count), `test/blockers.test.ts`
- Docs: none — no user-visible output until Task 4

## Task 4 — Setup says it: blockers first, honest settled screen and closing line [x]
- Acceptance: review lists blockers before the steps; settled screen says "nothing needs to
  change" only with none (ADR-022 amended) and otherwise names them; `--no-input` on a settled
  clone prints them; closing is `done` only when a re-read finds none, else
  `set up for <a>; the next push will fail: …`; exit codes unchanged; owner question uses the
  push destination; "pin that address" only for one address; T1 locks green.
- Verify: `node --test test/wizard-setup.test.ts test/wizard-screens.test.ts test/characterization.test.ts`
- Files: `src/wizard/setup-flow.ts`, `src/wizard/setup-run.ts`, `src/wizard/review-text.ts`, tests
- Docs: HOW-IT-WORKS cards 3 and 13, ADR-022 status (amended), ADR-011 table + status (env
  warning), CHANGELOG

## Checkpoint A (after T1–T4)
- [ ] `npm test`, `npm run build` green; walk s5–s9 named before the closing line

## Task 5 ⚠ — `repown reauthor` [x]
Rewrites history (recoverable only through the backup ref).
- Acceptance: refusals (detached, dirty, rebase in progress, no pin, url/pushurl/unnamed/unread
  destination, fetch failed, no terminal without `--yes` → exit 1, as `fix`); fetch first, prompts off;
  foreign-only base; backup `refs/repown/backup/<branch>/<time>`; a failed rebase aborts and
  restores; success prints count and undo; the push afterwards passes the guard as a
  fast-forward and the destination's commits are untouched; `--help` from its declaration.
- Verify: `node --test test/reauthor.test.ts test/docs.test.ts test/cli.test.ts`
- Files: `src/commands/reauthor.ts`, `src/program.ts`, `src/core/git.ts`, `test/reauthor.test.ts`
- Docs: ADR-026 (new; supersedes ADR-013's rewriting row in part), ADR-013 status,
  decisions/README index, README command list, HOW-IT-WORKS card 8, FAQ, CONTRIBUTING map,
  CHANGELOG

## Task 6 ⚠ — Setup steps: repoint the sign-in URL, fetch the destination [x]
Writes git config; uses the network.
- Acceptance: `--repoint` / `--fetch`; Recommended fills them when they apply; review shows
  `git config --local <key> <remote>` and `git fetch <remote>` (no URL); a failed fetch warns
  and the destination stays unknown; `--no-input` without the flags does neither; Step by step
  asks both.
- Verify: `node --test test/wizard-setup.test.ts test/wizard-screens.test.ts test/cli.test.ts`
- Files: `src/wizard/setup-flow.ts`, `src/wizard/setup-run.ts`, `src/commands/setup.ts`, tests
- Docs: README (setup flags), CONFIGURATION (scripts and CI), HOW-IT-WORKS card 13, CHANGELOG

## Task 7 ⚠ — Setup's opt-in re-author step [x]
Runs `repown reauthor --yes` from the wizard.
- Acceptance: asked in both modes, default No, only with foreign unpushed commits; `--reauthor`;
  runs after fetch and repoint; field case played end to end: Yes → closing `done` and the push
  passes; No → closing names the refused commits.
- Verify: `node --test test/wizard-screens.test.ts test/wizard-setup.test.ts`
- Files: `src/wizard/setup-flow.ts`, `src/wizard/setup-run.ts`, `src/commands/setup.ts`, tests
- Docs: README (flag), HOW-IT-WORKS card 13, CHANGELOG

## Task 8 — Status shows the blockers [x]
- Acceptance: blockers in ADR-023's first block; `ready:` only without them; a ready clone's
  output unchanged (T1 lock).
- Verify: `node --test test/status.test.ts test/characterization.test.ts`
- Files: `src/commands/status.ts`, `test/status.test.ts`
- Docs: HOW-IT-WORKS status card, ADR-020 and ADR-023 status lines, CHANGELOG

## Checkpoint B (after T5–T8)
- [x] `npm test`, `npm run build` green (809 pass, 1 skipped)
- [x] walk s1–s9 re-run with `scratchpad/walk/harness.ts` (Enter at every question, so re-author No):
  every failure named by setup's closing line (s1–s3 commits by another address, s5 diverged,
  s7 detached, s8 GIT_AUTHOR_EMAIL, s9 destination owner); s4, s6 done and push. Named, not fixed:
  - s5b: a teammate's commit on the remote, never fetched: setup says done, pull/push then fail.
    Offline read can't see it, and a clean clone never fetches (spec); git's own message explains it.
  - s9: setup says the push to octo-org will fail, but it passes: the harness's url.insteadOf rewrites
    the URL to a local path, and the guard reads no owner from a path. Same before this branch
    (setup said done then). For the security review: the guard fails open on an ownerless URL.
- [x] Phase 5 review (code-reviewer, docs drift, security-auditor for ⚠, wizard-auditor). Fixed:
  - WIZ-1 `--fetch` was dropped behind a URL a repoint would fix (flags checked before the repoint
    question): `keptFlags` counts an unasked repoint as Recommended's Yes; the note names `--repoint`.
  - ssh: quiet fetch/ls-remote no longer override `core.sshCommand` / `GIT_SSH` (per-account keys).
  - reauthor: no hook at all (core.hooksPath to a missing dir, reaches the --exec child), no
    autosquash, the commit count checked after, "nothing rewritten" only when the abort worked and
    the branch is back, backup ref never overwritten, printed through printable(); one AMEND and
    one own/other-address rule shared with unpushed.ts.
  - sign-in blocker reads the URL a push uses (pushurl when set), and names `repown setup --repoint`
    where it applies; networkReason masks a URL's credentials to the last @ and its query;
    printable() covers soft hyphen, ALM, word joiners, interlinear marks and tag characters.
  - WIZ-3 six tests now expect `done:` exactly; WIZ-5 plainer repoint/fetch hints.
  - blockers.ts moved to src/core/ (status and setup both read it).
  - docs: status card row, card 8 (undo, own commits after the oldest foreign one rewritten,
    backup never removed, refusals as examples), card 13 and CONFIGURATION (`--reauthor` is the
    confirmation; a refusal ends setup with exit 1), ADR-026 status line and example handle,
    CONTRIBUTING map, README row order and status ending.
  Deferred (named, not fixed):
  - reauthor judges "published" by `--not --remotes`: a narrow fetch refspec, a pushed tag or a
    push to a bare URL can hide what the remote has (the next push is then non-fast-forward).
  - the timeout kills only the direct child (Windows git wrapper); `--end-of-options` on fetch.
  - setup/status predict the owner from the configured URL, not the one insteadOf/pushInsteadOf
    makes (`git remote get-url --push` would match what the hook sees).
  - sparse checkouts are always refused (skip-worktree); advice (date order) and reauthor
    (topo order) may start at different commits with merges or clock skew; remote names with `/`
    or glob characters; status skips the owner blocker when origin's differs from the destination's;
    WIZ-6 the review shows `git fetch origin`, setup runs it with prompts off.
  Asked at GATE 5: guard-off blockers; settled clone and the reauthor offer; `--reauthor` as the yes.
- [ ] Phase 6 close-out
