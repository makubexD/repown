# Spec: gid — git identity pinning CLI

Status: formalizes the existing, already-implemented tool as the authoritative
reference. This is not a rewrite or a new project — it documents current
behavior as the contract future changes must honour, and records open
questions for the gaps raised while writing it.

## Objective

**What it is.** A zero-dependency Node CLI that pins one git clone to one
account — repo-local `user.name`, `user.email`, `credential.<host>.username`,
`user.useConfigOnly` — and installs a `pre-push` hook that refuses commits
authored by any other identity.

**Who it's for.** A single engineer who works multiple accounts (e.g. a work
GitHub org and a personal account) from one machine, and needs each clone to
authenticate and author commits as the right one, every time, without a
per-push ritual.

**The problem this exists to solve — stated as the incident that motivates
it:**

> `gh auth switch -u personal` moves the GitHub CLI's *active* account,
> machine-wide. A work repo's clone has no idea that happened — its
> `credential.<host>.username` is (or should be) already pinned. But if `gh`
> is still the git credential helper (via `gh auth setup-git`), the next push
> in the work repo asks `gh` for a credential; `gh` looks it up by host, finds
> only the now-active personal account, and returns nothing for the work one.
> Git falls back to prompting for a username/password — and for a work
> account gated behind SSO, **there is no password to enter.** The failure
> looks like a broken credential when the actual cause is that `gh`, not git,
> owns the decision of which account authenticates.

`gid`'s answer is architectural, not a wrapper around `gh auth switch`: hand
credential resolution back to the OS credential manager (Git Credential
Manager), keyed per account per host, selected **per repository** via
`credential.<url>.username`. Once a clone is pinned, switching `gh`'s active
account (for `gh pr create`, `gh api`, etc.) can never break that clone's push
or pull — there is nothing left for the switch to affect. `gh` stays the
account store and the PR/API tool; it is deliberately removed from the git
authentication path (`gid fix`), and `gid doctor` / `gid` (status) report
whether that separation currently holds.

**Success looks like:** an engineer can run `gh auth switch` freely for CLI
work, and no previously-pinned clone's push/pull authentication is ever
affected by it — including accounts with no traditional password (SSO/PAT
only).

## Tech Stack

- **Language:** strip-only TypeScript on Node (no enums, namespaces, parameter
  properties, or anything needing emitted code) — every file in `src/` runs
  under bare `node`, no build step needed to run from source.
- **Runtime:** Node 20+ to run the published package; Node 22.6+ to develop
  (type stripping + `node --test` glob expansion).
- **Dependencies:** zero runtime dependencies, by design — the tool reads
  credential configuration, so its supply chain stays as small as possible.
  `typescript` and `@types/node` are the only `devDependencies`.
- **External tools relied on, not bundled:** `git` (required), `gh` (detected,
  optional — used as the account store and queried for its own state, never
  assumed installed), OS credential manager / Git Credential Manager
  (detected, not installed by `gid`).

## Commands

```
npm install
npm test                             # node --test "test/*.test.ts" (no framework)
node --test test/guard.test.ts       # a single test file
node --test --test-name-pattern="<regex>" test/guard.test.ts   # a single test
npm run build                        # tsc -> dist/; this is also the typecheck
node src/cli.ts <args>               # run from source, no build needed
```

CLI surface (`gid <command> [action] [options]`, `gid --help` / `gid <command>
--help` for details):

| Command | Purpose |
| --- | --- |
| `gid` (no args) | Status: identity, push credential, origin/host, guard state, `gh` active account — the "clear picture of current setup" view |
| `gid use <account> [--gh]` | Pin the current clone to a registered account; `--gh` also switches `gh`'s active account |
| `gid off` | Unpin the current clone's identity |
| `gid accounts add\|list\|remove` | Per-machine account registry (name + email) |
| `gid guard on\|off` | Install/remove the pre-push authorship guard |
| `gid doctor` | Diagnose what actually serves git credentials here (`gh` vs GCM vs other), and whether it agrees with the pin |
| `gid fix` | Reversibly undo `gh auth setup-git`'s changes to the global credential helper |
| `gid scan <dirs...>` | Audit multiple repos on disk for pinned/unpinned identity and guard state |

Every command exits `0` on success, `1` on failure/refusal, `2` on a usage
error.

## Project Structure

```
src/cli.ts              Dispatch only — resolves command/action, --help interception, COMMANDS map
src/ui/args.ts           Argument parser (parseArgs, flagString/flagBool, OptionSpec/Spec)
src/ui/command.ts        Command / CommandGroup shapes every src/commands/*.ts exports as default
src/ui/help.ts           Renders help from the same declarations the parser enforces
src/ui/suggest.ts        Edit-distance "did you mean" for mistyped command/action/option
src/ui/format.ts         All user-facing output; colour decided per stream (NO_COLOR/FORCE_COLOR)
src/ui/prompt.ts         Interactive prompts (stderr)
src/commands/*.ts        One file per top-level command (status, use, off, doctor, fix, guard, accounts, scan)
src/core/exec.ts         The only place subprocesses are spawned (never writes to console; non-zero exit resolves, never rejects)
src/core/result.ts       Result<T, E> for recoverable "answers, not exceptions" (ok/err/or)
src/core/git.ts          Git wrapper around a working directory
src/core/identity.ts     Repo-local identity read/write
src/core/inspect.ts      Status/doctor data gathering
src/core/registry.ts     Per-machine accounts.json (name/email per account)
src/core/url.ts          Remote URL parsing (owner, host, both Azure DevOps URL forms)
src/core/hosts/          Strategy pattern: HostProvider per host (github.ts, azdo.ts, generic.ts, index.ts resolves in order, generic always last)
src/core/credential/     gh.ts (gh auth status, self-only) and gcm.ts (Git Credential Manager detection); repair.ts backs `gid fix`
src/core/guard/          hook.ts (writes the LF-only pre-push hook), check.ts (authorship check the hook calls)
test/                    node --test; helpers.ts sandbox() isolates GIT_CONFIG_GLOBAL/SYSTEM
docs/DECISIONS.md        Why each non-obvious choice was made — read before changing behaviour
```

Adding a host is one file implementing `HostProvider` plus one line in
`src/core/hosts/index.ts`. An empty `credentialKeys()` means "this host can't
pin credentials" and must never guess.

## Code Style

Representative of the codebase's own conventions:

```ts
// src/core/result.ts — Result<T,E>, never a collapsed null/empty for a real failure
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

- **Strip-only TypeScript.** No enums, namespaces, parameter properties, or
  anything that needs emitted code beyond type removal. Relative imports use
  explicit `.ts` extensions.
- **`Result<T, E>` for recoverable failures** ("gh could not be queried", "no
  provider") — never collapsed into `null`/`undefined`/empty, because *"a
  skipped check must never look like a passed one."*
- **No names or email addresses in the repository.** Tests and examples use
  `octocat`, `*.example.invalid`. Personal data lives only in `.git/config` or
  the per-machine registry.
- **Strategy pattern for host providers**, not conditionals branching on host
  name — each `HostProvider` owns owner-parsing, credential keys, and stored
  accounts for one host.
- **`src/core/exec.ts` is the only subprocess boundary.** It never writes to
  the console (credential output can carry live secrets on stdout) and always
  runs with `shell: false`.
- Comments explain *why*, not *what* — see the header comments in
  `src/core/credential/gh.ts` for the standard.

## Testing Strategy

- **Framework:** none — `node --test`, Node's built-in runner.
- **Location:** `test/*.test.ts`, mirroring `src/` by concern (e.g.
  `test/guard.test.ts`, `test/args.test.ts`, `test/cli.test.ts`).
- **Isolation:** `test/helpers.ts` `sandbox()` creates a temp repo and points
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at empty files — the machine's real
  git config must never leak into a test result. Anything touching git uses
  it.
- **Levels:**
  - *Unit* — the argument parser (`test/args.test.ts`), the git wrapper,
    credential/host modules against `Result` shapes.
  - *Integration* — guard scenarios built with `git commit-tree` (doesn't move
    HEAD) plus real `git push` against a local remote.
  - *End-to-end* — `test/cli.test.ts` spawns the real entry point
    (`spawnSync(process.execPath, [CLI, ...args])`) to cover dispatch, help,
    exit codes, and the stdout/stderr split — including
    `guard check --remote --url`, the exact syntax an installed hook calls.
- **CI matrix:** Linux, Windows, macOS; Node 22 and 24 for development, plus a
  dedicated install job that packs the package, installs it globally on Node
  20, and runs a real clone end to end (proving the `engines: >=20` claim
  rather than assuming it).
- **Empirical-evidence rule (carried from `docs/DECISIONS.md` §7):** a claim
  about external tool behavior (`gh`, GCM, a host's credential model) must be
  backed by a test against the real tool/config shape, not inferred. A host
  provider must only claim what was actually measured.
- **New test required whenever:** a host provider is added or changed, a
  guard refusal condition changes, or a claim is made about what `gh`/GCM/git
  does in a given state.

## Boundaries

**Always do:**
- Run `npm test` and `npm run build` (the typecheck) before considering a
  change done.
- Keep `src/core/exec.ts` as the only subprocess spawn point; route new
  subprocess calls through it.
- Use `sandbox()` for any test touching git config.
- Keep credential-pinning claims host-by-host and only for what's been
  measured — an unverified provider must return "can't pin" (empty
  `credentialKeys()`), not a guess.
- Read the relevant `docs/DECISIONS.md` section before changing behavior it
  covers; update that section (or add a new one) when a decision changes.
- Route all user-facing output through `src/ui/format.ts` so stdout/stderr and
  colour-per-stream rules stay intact.

**Ask first:**
- Adding a runtime dependency (the zero-dependency constraint is deliberate,
  per §7 — reads credential config, smallest supply chain on purpose).
- Reopening a documented decision in `docs/DECISIONS.md` (e.g. §4's rejection
  of a switchable per-clone profile store) — these were reverted once already
  for reasons recorded there.
- Any change to what the pre-push guard *refuses* vs *warns* about — this
  distinction (§8: refuse only what's irreversible) is load-bearing.
- Publishing the package to npm (currently deliberately unpublished until the
  command surface settles).

**Never do:**
- Write names, email addresses, or other personal identifiers into anything
  tracked by the repository (tests/examples use `octocat`,
  `*.example.invalid`).
- Have `src/core/exec.ts` (or anything else) write credential output to the
  console — `git credential fill` can return live passwords on stdout.
- Add a host provider that guesses at credential keys instead of returning
  "can't pin" — per §6, "a provider that guesses is worse than none."
- Make the guard's commit-authorship check depend on a network call — it must
  stay usable offline, in the pre-push path.
- Silently collapse a "couldn't check" result into "check passed" anywhere in
  status/doctor/guard output.
- Have `gid` itself drive a device-code or browser OAuth login flow. Confirmed
  as a non-goal by the `sso-credential-visibility` analysis below: `gid` reads
  credential configuration (§1) and stays a *detector*; initiating a login
  belongs to `gh`/GCM, not to this tool.

## Success Criteria

1. **The motivating incident cannot recur** on a pinned clone: after `gid use
   <account>` + `gid fix` (removing `gh` as the git credential helper),
   running `gh auth switch -u <other-account>` and then `git push`/`git pull`
   in that clone authenticates as `<account>` unaffected — including when
   `<account>` has no traditional password (SSO/PAT-only).
2. `gid` (status, no args) and `gid doctor` each show, without any network
   call failing silently into a false pass: who commits author as, who pushes
   as, `gh`'s active account, and whether the current credential helper
   agrees with the pin.
3. `gid scan <dirs>` finds every git repo under the given paths and reports,
   per repo: owner, host, pinned/inherited identity, guard on/off — domains
   and counts only by default, addresses only with `--emails`.
4. Adding a new host requires exactly one new file (`HostProvider`) and one
   line in `src/core/hosts/index.ts`; no existing host's behavior changes.
5. `npm test` passes on Linux, Windows, and macOS in CI, and the install job
   proves a global install on Node 20 completes a real clone end to end.
6. Every documented guard refusal (foreign commit author, wrong destination
   owner, no pinned identity, `GH_TOKEN`/`GIT_*_EMAIL` overrides, unrunnable
   hook) has a test that exercises it through a real `git push`.

## Open Questions

These surfaced directly from the incident that motivates this spec, and are
**not yet answered by measurement** — per the project's own rule (§6), `gid`
must not claim detection it hasn't verified. Each needs empirical
verification against a real SSO-enforced org before any code changes:

1. **Can an SSO-authorization-required state be distinguished from a plain
   missing/expired credential?** `gh auth status --json hosts` (the only call
   `src/core/credential/gh.ts` makes) needs to be checked against a real
   SSO-enforced org to see whether that JSON — or GCM's own state — exposes
   "token valid but not yet SSO-authorized for this org" as a distinct
   condition `gid doctor` could report, versus indistinguishable from "no
   credential."
2. **Should `gid doctor`/`gid use` explicitly document the first-push flow
   for an SSO-only account?** Today's guidance ("the first push signs in
   once, then never again") assumes GCM's own browser/device flow handles it;
   worth confirming that's actually what happens for an SSO-enforced org
   before stating it as fact in `gid use`'s own output.
3. **Device-code / browser OAuth as an onboarding path** — whether `gid`
   should ever drive a login flow itself, or stay strictly a *detector* of
   credential state and leave login to `gh`/GCM. Leaning toward the latter
   (consistent with §1's decision that `gid` reads credential configuration
   rather than manages authentication), but not yet decided.
4. Whether resolving these should land as new `gid doctor` output only, or
   also change `gid use`'s guidance text — deferred until (1) and (2) are
   answered empirically.

No code changes are proposed until these are resolved — this section exists
so the incident that prompted this spec isn't lost before it's investigated.

**Update:** a deep verification pass against this spec (see `CAPABILITY-MAP.md`)
confirmed items 1 and 2 above as a real, independent gap, tracked as module
`sso-credential-visibility` (`SPEC-sso-credential-visibility.md`). That
module's research phase has since concluded: **no proactive SSO-authorization
signal exists** in `gh auth status --json hosts` or GCM, verified against
real output and `cli/cli` source — see `docs/DECISIONS.md` §9. No code was
implemented; the incident is now a documented, deliberate residual risk
rather than an open question. Item 3 (device-code/browser OAuth) was resolved
as a **non-goal** — see Boundaries above. A second candidate the same pass
initially flagged (a fresh, unpinned clone not being "proactively" surfaced)
did not survive closer inspection: `src/commands/status.ts` already reports
it at fail severity with exit code 1. See `CAPABILITY-MAP.md`'s "Withdrawn"
note. All three original open questions are now closed.
