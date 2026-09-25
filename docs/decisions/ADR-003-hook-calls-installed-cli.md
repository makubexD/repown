# ADR-003: The hook calls the installed CLI, and refuses when it cannot

**Status:** Accepted

## Context

The checker can't live in the working tree. A tool folder that exists on only one branch
leaves every other branch unguarded. An earlier design avoided that by copying the
checker's modules into `.git/` at install time. That added two failure states:
- **stale:** a copy is missing, so the check can't load;
- **drifted:** the copies are older than the tool they came from.

In that design, a hook whose check couldn't load exited 0, which let five of six branches
push unguarded.

## Decision

- The hook runs the installed CLI. The Node executable and the CLI's absolute path are
  written into the hook at install time.
- If that fails, it looks for `repown` on the `PATH`. It trusts that program only if
  `repown --version` names repown, because a program that merely shares the name and
  exits 0 would pass every push unchecked.
- If neither runs, the hook **refuses** the push. A hook that can't run its check isn't
  a check.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Copy the checker into `.git/` | The stale and drifted states above. |
| Exit 0 when the CLI is missing | The failure that let five of six branches push unguarded. |

## Consequences

- There is only ever one implementation, and it's always current.
- Changing the `PATH` or reinstalling somewhere else can't quietly disable the guard.
- Removing repown before running `repown guard off` leaves hooks that refuse every push.
  The refusal prints three ways out: reinstall and run `repown guard on`, delete the
  hook, or use `git push --no-verify` once.

## Amendments

- **2026-09-25, npx.** `npx repown guard on` without a global install records a copy in
  npm's `_npx` cache as the entry point. Nothing keeps that folder: once it is deleted,
  and with no `repown` on the `PATH`, the hook refuses every push. `guard on` still
  installs the hook (refusing would protect nothing, [ADR-011](ADR-011-refuse-vs-warn.md)),
  and warns with the fix: install globally, then run `repown guard on` again. Only npm's
  layout was measured, so pnpm, yarn and bun runners aren't recognised.
  The check runs only at `guard on`: `repown` and `repown doctor` don't read the entry a
  hook already records, so a hook installed through npx before this warning existed
  still reports as `on` until a push is refused.
