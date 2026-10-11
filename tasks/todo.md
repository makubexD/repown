# Push-URL gaps

Status: Phase 5 done; next Phase 6 close-out (GATE 6).

- [x] 1. Plan: SPEC.md and this file. Docs: none.
- [x] 2. ⚠ A sign-in carried by a rewritten push URL is a blocker (item 3)
  - Accept: a `url.<https://<token>@host/>.pushInsteadOf` (and `.insteadOf`) rule on origin
    makes status/setup report the sign-in blocker naming the rule's key; a bare username
    (GCM's advice) still doesn't. Judged on `remote get-url --push --all`; the rule is never
    named (its key holds the token).
  - Where: `signinOf`/`carriesSecret` in `src/core/push-state.ts`, over `remoteUrls(remote, true)`.
  - Docs: ADR-026 note, CHANGELOG (no user doc lists sign-in sources).
- [x] 3. ⚠ Several push URLs that don't share one owner are a blocker (item 1, narrowed)
  - Accept: origin with pushurls owned by octocat and octo-org, or octocat and a local path:
    setup and status show one line naming each URL's owner and host, never a URL; one push
    URL, or several with one readable owner, print exactly as before; a failed read is a
    failure, not a pass; JSON unchanged.
  - Where: a new fact in `src/core/push-state.ts`, a new blocker in `src/core/blockers.ts`.
  - Docs: ADR-026 note, HOW-IT-WORKS status card (push row), CHANGELOG.
- [x] 4. ⚠ Measure git's pushInsteadOf on a bare-URL push (item 2, spike): done by the doubt
  pass 2026-10-10; git's rules can't be reproduced offline, so task 5 says "can't tell".
- [x] 5. ⚠ A bare-URL push that git may rewrite says repown can't tell where it lands (item 2)
  - Accept: branch.main.pushRemote set to a URL; a pushInsteadOf value that prefixes it (or
    an empty one), or a `remote."<URL>".pushurl`/`url`, gives one non-blocking line naming the
    key (never the URL) and no owner blocker; a rule that doesn't prefix it changes nothing;
    a failed config read says "can't tell" too.
  - Where: a reader beside `rewrittenUrl` in `src/core/git.ts`, `src/core/push-state.ts`, `src/core/blockers.ts`.
  - Docs: ADR-026 note (measured, for/against), CLAUDE.md (`rewrittenUrl` line), HOW-IT-WORKS status card, CHANGELOG.
- [ ] 6. Close-out: move facts from SPEC.md, delete SPEC.md and tasks/, memory.
