# Todo: make gid's goal obvious

Status: Phase 4, T2a+T2 done; T3 next.

- [x] Phase 1 intent confirmed (GATE 1)
- [x] Phase 2 spec approved (GATE 2, with docs sync test)
- [x] Phase 3 plan approved (GATE 3)
- [x] T0 Plan commit - Docs: none
- [x] T1 DECISIONS absorbs README-only facts - Docs: docs/DECISIONS.md
- [x] T2a test/docs.test.ts, shown RED on the missing `off` - Docs: none
- [x] T2 README rewrite, T2a GREEN - Docs: README.md
- [ ] T3 CLAUDE.md rewrite, tracked with .claude/rules/code-quality.md - Docs: CLAUDE.md
- [ ] Phase 5 review: code-reviewer + docs-drift, run in parallel
- [ ] Phase 6 close-out: delete SPEC.md and tasks/

## Fact inventory (old claim -> new home)

| # | Claim in old README / CLAUDE.md | New home |
| --- | --- | --- |
| 1 | Pin a clone to one account; refuse foreign pushes | README promise, reworded as the outcome |
| 2 | Every clone inherits global identity; the author address is permanent once public | README "The problem" |
| 3 | `gh auth switch` breaks the other account's repos (the "Invalid username or token" transcript) | DECISIONS §1 (T1 adds the transcript) + README 1 line |
| 4 | gh's helper serves only the active account; with SSO there is no password to type | DECISIONS §1 (T1 adds the SSO line) |
| 5 | GCM: one credential per account, chosen by `credential.<url>.username` | README "How" bullet + DECISIONS §1 (exists) |
| 6 | `gh` stays the account store; `gh pr create` / `gh api` keep working | README 1 line + DECISIONS residual risks (exists) |
| 7 | Install: Node 20+, git, 3 OSes, clone/build/link, unlink, not on npm yet | README Install |
| 8 | `accounts add` output; suggests the noreply address | README Quickstart |
| 9 | `use` output; the four repo-local keys table; `.git/config` untracked; per clone | README Quickstart |
| 10 | `use --gh` | README Commands |
| 11 | `gid` status sample; three things decide who you are | README Day to day |
| 12 | Help levels; exit codes 0/1/2 | README Commands |
| 13 | Guard checks commits, not config (why) | README 1 line + DECISIONS §2 (exists) |
| 14 | Guard refusal sample output | README Guard |
| 15 | Refuses: destination owner (URL, not userinfo), GH_TOKEN, GIT_*_EMAIL, unpinned, unrunnable hook | README Guard list; why -> §2, §3 |
| 16 | `gid.mirrorBranch`, `gid.allowOwner`; no org API call | README keys + DECISIONS §3 (exists) |
| 17 | Guard is wrong for shared repos; server-side ruleset | README 2 lines + DECISIONS §3 (exists) |
| 18 | `scan` sample; domains not addresses; `--emails`; column is a fact not a verdict; can't undo history | README Day to day + DECISIONS §5, §9 (exist) |
| 19 | Hosts table; AzDO URL forms; adding a host = 1 file + 1 line | README table + DECISIONS §6 (exists); adding a host -> CLAUDE.md |
| 20 | Where things live table; GID_CONFIG_DIR; XDG | README |
| 21 | Running needs Node 20, developing needs 22.6+ (why) | DECISIONS §7 (T1 adds it) + README 1 line |
| 22 | Zero deps (why) | README 1 line + DECISIONS §7 (exists) |
| 23 | Strip-only TS (why) | CLAUDE.md + DECISIONS §7 (T1 adds it) |
| 24 | (new) `gid off` unpins a clone | README Commands + Day to day |
| 25 | DECISIONS §9 cites README "Why not just switch accounts" | T1 re-points it to §1 |
