# SPEC: deferred Safety items, round 1 (#21, #19, #11)

Scaffolding for this feature only; Phase 6 moves what stays true into ADR-026/028 notes and the
CHANGELOG, then deletes this file. #6 and #9 are the next round.

## Success criteria
1. #21a: the GitHub provider looks a login up only when it matches ^[A-Za-z0-9][A-Za-z0-9_-]*$;
   anything else gets no suggestion and no warning and is recorded as typed. ghProfileArgs also
   URL-encodes. Typed `accounts add ../user` never calls `gh api users/../user`.
2. #21b: setup's and the start screen's login question refuses an all-dot login.
3. #21c: typed `accounts add`'s WARN line escapes the login (printable).
4. #21d: a profile name printable() would change is dropped, never suggested.
5. #19: Record an account checks the registry first; unreadable (or with unreadable entries) =
   the reason on screen, no question, back to the menu.
6. #11: owner = the push URL git uses (`git remote get-url --push`, `ls-remote --get-url` for a
   bare URL target), as the guard sees it; first push URL when several.

## Out of scope
#6, #9; credentials in rewritten URLs; push-destination's raw-URL remote identity; refusing odd
logins in typed `accounts add`.

## Riskiest assumption
get-url --push equals the hook's $2: a guarded push with insteadOf/pushInsteadOf proves it.
