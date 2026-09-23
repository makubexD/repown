# Spec: sso-credential-visibility

Module of `CAPABILITY-MAP.md`. Parent spec: `SPEC.md`.

## Resolution: signal not found — no implementation

The research phase below was run against the actually-installed `gh v2.89.0`
on this machine (`gh auth status --json hosts`, real output captured) and
cross-checked against `cli/cli`'s `pkg/cmd/auth/status/status.go` source on
`trunk`. Conclusion: **no proactive SSO-authorization-state signal exists to
surface.** `state` in the real JSON output is one of exactly `success` /
`timeout` / `error`, and `error` is set only when a general, non-org-scoped
identity call fails — never from an org-scoped SSO check. SAML/SSO
enforcement is checked per-organisation, on resource access, so nothing short
of a request against that specific org can observe it in advance — the same
rate-limit/auth dependency `docs/DECISIONS.md` §3 already rejected in this
kind of path. GCM's `diagnose` subcommand produces free-form logs for a
human, not a parseable field.

Recorded as a new row in `docs/DECISIONS.md` §9 "Deliberately not done" and a
new "Residual risks" bullet, in the same style as the Azure DevOps
credential-pinning entry. **No detection code was implemented** — the
Interface section below is retained as the historical research record (what
shape was considered and rejected), not as a plan to implement.

**Follow-up added:** since the failure can't be detected, `gid doctor`'s
healthy path (`diagnoseHealthy` in `src/commands/doctor.ts`) now prints a
short, unconditional troubleshooting note pointing at `gh auth refresh -h
<host>` / org SSO settings, so the fix is visible before it's needed rather
than only discoverable by hitting the failure. This is guidance text, not a
detected condition — it does not contradict the "signal not found" finding
above, and it's identical for every user regardless of whether SSO applies to
them.

## Objective

Answer, empirically, whether `gh` or Git Credential Manager expose enough
information to distinguish three states for a given account's credential —

1. **no credential** (already detected today),
2. **credential present, valid, and usable** (already detected today), and
3. **credential present but not yet SSO-authorized for this org** — the state
   directly behind the incident that motivates `SPEC.md`: a work account with
   no traditional password, prompted for one anyway because the thing that
   actually failed was an SSO gate, not a missing token —

and, **only if state 3 is genuinely observable**, surface it in `gid doctor`
and `gid` (status) as a distinct, correctly-labelled condition rather than
silently folding it into "no credential."

This module has two possible honest outcomes, and both are success:

- **Signal found** → implement detection and reporting (this document's
  Interface and Testing sections apply).
- **Signal not found** → do not implement anything that guesses. Add a new
  entry to `docs/DECISIONS.md` "Deliberately not done," matching the pattern
  already used for Azure DevOps credential pinning (§6): recognised as a real
  gap, left alone because guessing is worse than nothing, and the specific
  thing that was probed is recorded so the next person doesn't re-probe it
  blind.

Per the project's own rule (`docs/DECISIONS.md` §6): *"a provider that
guesses is worse than none: it writes config that looks like configuration
while selecting nothing."* This module must not produce a `gid doctor` line
that looks authoritative but is actually a guess.

## Research phase (must run before any code change)

Against a real SSO-enforced GitHub organisation (and, if reachable, an
Azure DevOps org with conditional access / SSO), read-only:

```
gh auth status --json hosts          # exact schema for an account whose PAT
                                      # is valid but not SSO-authorized
gh auth status                       # human-readable output for the same —
                                      # gh's text UI is known to print an SSO
                                      # hint; confirm whether --json carries
                                      # the equivalent field or only the text
                                      # form does
git ls-remote <sso-gated-org-repo>   # observe git's own error text/exit code
                                      # when a valid-but-unauthorized PAT
                                      # is used as the credential
```

Record, for each: the exact field(s) present or absent, and whether the
signal is host-specific (GitHub only vs. also inferable for Azure DevOps).
No global config or account state may be written during this phase — probing
is entirely read-only, consistent with how the initial gap-analysis pass was
run.

## Interface (NOT implemented — retained as the rejected design)

The research phase (above) concluded no signal exists, so nothing below was
built. Kept so a future attempt doesn't re-propose the same shape without
first checking why it was rejected.

Extend, don't replace — `GhAccount` today is `{ login, active }`, read by
`src/commands/doctor.ts` and `status.ts` through `src/core/inspect.ts`.
Existing call sites must keep compiling and behaving identically without
modification.

```ts
// src/core/credential/gh.ts — additive; no existing field changes shape
export type SsoState =
  | { readonly kind: 'not-applicable' }        // no SSO gate observed for this account/host
  | { readonly kind: 'authorized' }             // confirmed authorized
  | { readonly kind: 'pending'; readonly org: string }  // valid credential, SSO authorization missing
  | { readonly kind: 'unknown'; readonly reason: string }; // signal expected but not confirmable here

export interface GhAccount {
  readonly login: string;
  readonly active: boolean;
  readonly sso?: SsoState;   // absent = "not measured for this call", never "not-applicable"
}
```

Design rules this follows:

- **Discriminated union, not a boolean or nullable string** — `kind` is
  exhaustively switchable, so `doctor.ts` cannot accidentally treat `pending`
  as falsy the way an `ssoOk: boolean | null` would invite.
- **Additive field (`sso?`)** — every existing consumer of `GhAccount`
  compiles unchanged. Only code that explicitly reads `.sso` takes on the new
  case.
- **`unknown` carries a reason, and is never dropped.** If `gh`/GCM claims to
  support the check but this call couldn't confirm it, that's reported, not
  silently treated as `not-applicable`. This is the direct application of the
  project's "unknown must never look like passed" rule to this specific
  field.
- **The field is `undefined` (omitted), not `unknown`, when this module isn't
  implemented at all** — an unimplemented feature and a checked-but-uncertain
  result are different facts, and `doctor.ts` must not have to guess which
  one it's looking at.

Rendering rule for `doctor.ts`/`status.ts` (consistent with existing
pass/warn/fail semantics in `docs/DECISIONS.md` §8 — nothing here is
irreversible, so nothing in this module ever *refuses*, only *warns*, matching
how a `gh`-as-helper problem is already handled):

| `SsoState.kind` | Output |
| --- | --- |
| `not-applicable` | nothing printed (the common case; no noise) |
| `authorized` | nothing printed, or folds into the existing "OK identity" line |
| `pending` | **WARN** — names the org, and the fix (re-authorize, e.g. `gh auth refresh`) |
| `unknown` | **WARN** — states plainly that SSO state could not be determined, same tier as today's "gh could not be queried" |
| *(field absent)* | no change from current output |

## Project Structure

Only these files are expected to change, and only if the research phase
confirms a signal exists:

```
src/core/credential/gh.ts     Add SsoState, extend GhAccount, parse the confirmed field
src/core/credential/gcm.ts    Only if GCM (not gh) turns out to carry the signal
src/core/inspect.ts           Thread the new optional field through to doctor/status data
src/commands/doctor.ts        Render the WARN cases per the table above
src/commands/status.ts        Same, for the default `gid` view
test/                         New test(s) — see Testing Strategy
docs/DECISIONS.md             Either a new subsection under an existing host
                               decision, or a new "Deliberately not done" row
                               if the research phase finds no signal
```

## Code Style

Follows the parent project's existing conventions (`CLAUDE.md`,
`.claude/rules/code-quality.md`) with nothing module-specific beyond what's
in the Interface section above: strip-only TypeScript, `Result<T,E>` for
recoverable failures, ≤20-line function bodies, ≤4 parameters, no guessed
output presented as fact.

## Testing Strategy

- If a signal is confirmed: a unit test on the JSON-parsing path in
  `gh.ts` covering all four `SsoState` kinds, built the same way existing
  `gh.ts` tests are (fixture JSON shaped like the real, recorded output —
  not a guess at the shape), plus a `doctor.ts`/`status.ts` output test
  asserting the `pending`/`unknown` cases render as **WARN**, never silently.
- If no signal is confirmed: no new detection code, so no new detection
  test — instead, the `docs/DECISIONS.md` addition itself is the deliverable,
  and existing tests must keep passing unchanged (proving this module made no
  behavioral change).
- Either outcome: this module must not reduce coverage or weaken any existing
  assertion in `test/*.test.ts`.

## Boundaries

- **Always do:** treat the research phase's findings as fact, not the
  speculative interface above — if the real JSON/output shape differs from
  what's sketched here, the spec's interface section is wrong and must be
  corrected before implementation, not worked around.
- **Ask first:** whether an Azure DevOps equivalent is worth the same probing
  effort, given `azdo.ts` already documents that AzDO's credential model is
  murkier than GitHub's (DECISIONS.md §6) — this module defaults to
  GitHub-only unless asked to extend.
- **Never do:** report `pending` or `authorized` without having actually
  observed the corresponding signal in this session's research; never
  present `unknown` as `not-applicable` or vice versa.

## Success Criteria

1. ✅ The research phase's findings are recorded (in this file and
   `docs/DECISIONS.md`) before any implementation code is written.
2. N/A — not implemented; no signal to report.
3. ✅ `docs/DECISIONS.md` gained an entry explaining exactly what was probed
   and why nothing was built, in the same style as the existing Azure DevOps
   entry.
4. ✅ Trivially true — no `GhAccount` consumer was touched.

## Open Questions — resolved

- ~~Whether GCM (rather than `gh`) is actually the better place to look for
  this signal~~ — checked both. GCM's `diagnose` subcommand (`git
  credential-manager diagnose --help`, confirmed against the installed
  v2.7.3) only writes free-form log files for a human to read; it exposes no
  structured, parseable state `gid` could consume either. Neither layer
  carries this signal.

No open questions remain for this module.
