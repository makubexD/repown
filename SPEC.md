# SPEC: deferred sweep (rounds A-E)

Working spec for branch `deferred-sweep`. Deleted at close-out; what stays true moves to the
ADRs, the CHANGELOG and the docs.

## Objective
Close the deferred list: #6, #8, #9, #10, #12, #15, #17, #18, #20, #23, #24, #25, WIZ-10, and the
five leftovers from the wrong-advice round. Record every item not fixed as a dated won't-fix note
in its ADR.

## Intent
- repown never offers or performs a rewrite of commits a remote may already have (A).
- It never claims a credential pin it did not set, and pins the URL git actually pushes to (B).
- Less redundant work (C); a timed-out child cannot outlive repown (D); terminal and wizard
  edges fixed or tested (E).

## Approach
Ask git rather than re-implement its rules: `<branch>@{push}` for where a push lands, `ls-remote`
for what a remote holds. One shared `pinsCredential(repo)`. Every fix is a tested behaviour
change; every refactor keeps output byte-identical.

## Out of scope (recorded as won't-fix)
- #14, #16: need a patch to clack (ADR-027).
- #7 leftovers: nushell's `\` escapes in double quotes, Git Bash collapsing `\\` (ADR-025/026 note).
- #13: setup stays offline by design (ADR-026).
- #26 rest: git has no multi-key config write (ADR-029).
- The guard checking a username in a `pushInsteadOf` URL, or naming each of several push URLs'
  owners: the guard ignores credentials and already checks each URL (ADR-011).

## Success criteria
1. **#6** The unpushed advice treats a destination as known only when `<branch>@{push}` names a
   tracking ref; otherwise a new `untracked` kind makes the rebase conditional. The advice lists
   commits in `--topo-order` (#12b). `hasTrackingRefs('a')` ignores remote `a/b`'s refs (#12c).
2. **#9** reauthor, after its fetch, excludes every SHA `ls-remote --heads --tags` lists; a listed
   SHA not present locally is a refusal naming the narrow refspec. `untracked` is accepted.
3. **#12a** reauthor allows skip-worktree bits sparse-checkout set, if a test shows the rebase is
   safe there; a hand-set skip-worktree bit still refuses.
4. **B1** `credentialKeys` follow origin's push URL; `off` still removes keys made from the fetch URL.
5. **B2** `use` prints `push-as:` only where a credential is pinned; one `pinsCredential(repo)`
   serves status, use, off, doctor and setup; the host warning reads correctly; README's use
   sample says GitHub over HTTPS.
6. **#8** push-destination reads config through one snapshot. **#17** one `gh api` call per
   profile. **#18** the start screen reads global identity only for Record an account.
   `shellWord`/`copyableCommand` live in `src/core/shell.ts`. Output unchanged.
7. **#10** a timeout kills the whole process tree (spawned only from exec.ts); a remote name
   starting with `-` is refused before fetch/ls-remote.
8. **#12d** status reports the owner blocker when origin's owner differs from the destination's;
   **#12e** the review's fetch line says prompts are off.
9. **#23 / WIZ-10** typed `accounts add` says "signed in as A, not X", and warns (still records)
   for a login setup refuses or one already recorded.
10. **#24** `wrap()` measures display width. **#25** in mintty without a TTY, bare repown notes
    `winpty repown` on stderr.
11. **#15 / #20** tests: unicodeTerminal vs clack parity; menu after fix's confirm; plain prompter
    after suspend; typed WARN end to end.

## Riskiest assumptions (measured first, in RED)
- `@{push}` fails exactly when no tracking ref covers the push destination, and still resolves
  for a branch never pushed.
- git asks the credential helper for the push URL (a logging fake helper shows it).

## Quality bar
CLAUDE.md hard rules, `.claude/rules/code-quality.md`, TDD with RED shown, `npm run build`, the
plain suite per task, all three runs (plain, forced colour, NO_COLOR) at close-out. Every output
change in the CHANGELOG. Every ⚠ task gets a doubt pass and its own "go".
