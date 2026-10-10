# Push-URL gaps

Status: Phase 4, task 2 done; next task 3 doubt pass.

- [x] 1. Plan: SPEC.md and this file. Docs: none.
- [x] 2. ⚠ A sign-in carried by a rewritten push URL is a blocker (item 3)
  - Accept: a `url.<https://<token>@host/>.pushInsteadOf` (and `.insteadOf`) rule on origin
    makes status/setup report the sign-in blocker naming the rule's key; a bare username
    (GCM's advice) still doesn't. Judged on `remote get-url --push --all`; the rule is never
    named (its key holds the token).
  - Where: `signinOf`/`carriesSecret` in `src/core/push-state.ts`, over `remoteUrls(remote, true)`.
  - Docs: ADR-026 note, CHANGELOG (no user doc lists sign-in sources).
- [ ] 3. ⚠ Every push URL's owner is named (item 1)
  - Accept: origin with two pushurls owned by octocat and octo-org: status and setup's review
    show one line naming both, the foreign one marked, and it is a blocker as the first URL's
    foreign owner is today; one push URL prints exactly as before; JSON unchanged.
  - Where: `pushSide` in `src/core/inspect.ts`, the destination in `src/core/push-state.ts`.
  - Docs: ADR-004 note, CLAUDE.md (owner line says "the first"), HOW-IT-WORKS status card, CHANGELOG.
- [ ] 4. ⚠ Measure git's pushInsteadOf on a bare-URL push (item 2, spike)
  - Accept: a test pins, against real git, what `git push <url>` sends to with pushInsteadOf
    and insteadOf rules (longest prefix; push rule shadows fetch rule; no rule), read from the
    URL the pre-push hook receives. If git's rules can't be matched offline, task 5 makes the
    destination unknown instead.
  - Docs: none (test only; findings go into task 5's ADR note).
- [ ] 5. ⚠ A bare-URL push resolves pushInsteadOf as git does (item 2)
  - Accept: task 4's cases give status/setup the same owner the hook sees; `rewrittenUrl`
    callers unchanged elsewhere.
    The sign-in check runs on the resolved URL too (moved here from task 2 by its doubt pass).
  - Where: `bareTargetUrl` in `src/core/push-state.ts`, a new reader beside `rewrittenUrl` in `src/core/git.ts`.
  - Docs: ADR-026 note (for/against, measured), CLAUDE.md (`rewrittenUrl` line), HOW-IT-WORKS, CHANGELOG.
- [ ] 6. Close-out: move facts from SPEC.md, delete SPEC.md and tasks/, memory.
