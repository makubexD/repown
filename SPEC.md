# Spec: push-URL gaps

## Objective
`repown status`, setup and `use` describe a push the way git will make it. Three gaps
remain where they describe less than the guard (or git) will act on. Close them without
changing what the guard refuses (ADR-011): only what is reported changes.

## Items
1. **Several push URLs.** Git runs the pre-push hook once per push URL, so a push can land
   on one URL and be refused on another, and the tracking ref then moves as if all landed.
   repown's reports read only the first URL's owner.
   Done (narrowed 2026-10-10 after the doubt pass; full multi-owner reporting rejected as
   too wide): when origin pushes to more than one URL and they don't all share one readable
   owner, setup and status show one blocker naming each URL's owner and host (never the URL),
   saying the guard checks each and a push can half-land, and to keep one push URL. The
   first-owner logic, allow flows and JSON stay as they are.
2. **pushInsteadOf on a bare-URL push.** `bareTargetUrl` uses `rewrittenUrl`
   (`ls-remote --get-url`), which applies only `insteadOf`. Git, for a push, applies the
   longest matching `url.<base>.pushInsteadOf` first and `insteadOf` only when none matches.
   Done: a push straight to a URL is resolved as git would for a push; measured against
   real git on the three platforms in a test, and recorded with for/against in an ADR note.
3. **A sign-in added by a rewrite.** `signinOf` (`push-state.ts:85`) checks the configured
   `pushurl`/`url` for a token. A `pushInsteadOf`/`insteadOf` rule that rewrites to
   `https://<token>@host/` signs the push in unseen.
   Done: every URL git pushes origin (or the bare target) with, after rewriting, is checked
   by `carriesSecret`; the blocker names the config key that holds the rule.

## Out of scope
- Any change to `guard check` (it already sees each URL).
- Online checks (ADR-004: no network in the push path; setup stays offline, ADR-026).

## Success criteria
- A test per item that fails on main and passes after; full suite + build green.
- HOW-IT-WORKS status/setup cards, CHANGELOG, and an ADR note per behaviour change.

## Riskiest assumption
Item 2: that repown can reproduce git's pushInsteadOf matching offline exactly (longest
prefix, push rules shadow fetch rules). Measured before it's relied on; if git's rules
can't be matched, the bare-URL destination becomes "unknown" (conditional advice) instead.

## Decided
- Item 1: one line naming every push URL's owner and host (2026-10-10), as its own blocker.
