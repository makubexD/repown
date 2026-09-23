# Capability Map: gid credential-visibility gaps

Source: a deep verification pass (read `docs/DECISIONS.md`, `SPEC.md`, and all
of `src/core/hosts/`, `src/core/credential/`, `src/commands/`,
`src/core/identity.ts`, `src/core/inspect.ts`, `test/*.test.ts`) run against
`SPEC.md`'s Success Criteria and Open Questions. Most of the original request
— multi-host extensibility, Azure DevOps handling, the fresh-clone identity
window as a documented residual risk — was found **already covered**; see
`SPEC.md`'s Open Questions "Update" note for the full verdict table. This map
covers only what came out as genuine, independently-buildable gaps.

| Module id | Responsibility | Status |
|---|---|---|
| `sso-credential-visibility` | Determine, empirically, what `gh`/GCM actually expose about SSO-authorization state, and — only if a real signal exists — surface it in `gid doctor`/`gid` (status) as a third state, never collapsed into "no credential" or "credential fine" | **Resolved, no code.** Researched against real `gh v2.89.0` output and `cli/cli` source: no such signal exists in `gh` or GCM. Recorded as a new "Deliberately not done" entry in `docs/DECISIONS.md` §9. See `SPEC-sso-credential-visibility.md`. |

**Dependency direction:** the one module depended only on existing,
already-shipped core (`credential/gh.ts`, `credential/gcm.ts`) — no cycles.

**Build order:** n/a — single module, now closed.

**Map status: no open modules remain.** Everything the original request
raised has been either confirmed already covered by existing code, resolved
as a documented non-goal, or researched and recorded as a deliberate
limitation with its reasoning. There is no further planned work from this
initiative unless new gaps surface.

**Withdrawn from this map after closer inspection:** `fresh-clone-warning`.
The initial verification pass read this as a gap, but a direct read of
`src/commands/status.ts:collectProblems()` shows an unpinned clone is already
reported at **fail** severity (exit code 1, with the exact fix), not merely
noted — there is no reporting gap. The only real remaining piece is
discoverability *before* the user thinks to run `gid` at all, right after
cloning — and `docs/DECISIONS.md` §9 already deliberately rejected both
standard fixes for that class of problem (`includeIf "gitdir:"` in global
config, a `pre-commit` hook), for reasons that apply here unchanged: new
global-config writes, or a hook with only partial coverage, for a window the
post-push guard already catches the consequences of. Building a module to
solve an already-declined problem would be padding, not a capability. If this
is still wanted, it's a one-line README nudge ("run `gid` right after
cloning"), not a spec.

**Explicitly excluded as a module** (resolved as a non-goal, not deferred
work): `gid` driving a device-code or browser OAuth login flow itself. See
`SPEC.md` Boundaries — this would cross the tool's own "reads credential
config, does not manage authentication" line (DECISIONS.md §1).

Each module's own spec is at `SPEC-<module-id>.md`, alongside this map.
