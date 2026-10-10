# Spec: push-URL gaps

## Objective
`repown status`, setup and `use` describe a push the way git will make it. Three gaps
remain where they describe less than the guard (or git) will act on. Close them without
changing what the guard refuses (ADR-011): only what is reported changes.

## Items
1. **Every push URL's owner.** `inspectRepo`'s `pushSide` (`src/core/inspect.ts:111`) and
   push-state's destination (`src/core/push-state.ts:113`, `remotePushUrl`) take the first
   URL. Git runs the pre-push hook once per push URL, so the guard checks each. With two
   `pushurl`s owned by different accounts, status/setup name only the first and miss a
   refusal the second push will meet.
   Done: status and setup name every distinct owner among origin's push URLs (from
   `remoteUrls(remote, true)`); a foreign owner on any one is the same blocker it is today
   on the first. JSON fields unchanged (ADR-014); text only.
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
- Item 1: when push URLs disagree, setup's review and status show one line naming every
  owner, foreign ones marked (2026-10-10).
