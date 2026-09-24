# ADR-010: Strip-only TypeScript on Node, with zero runtime dependencies

**Status:** Accepted

## Context

The predecessor was PowerShell. The case for keeping it: the logic is mostly running
subprocesses and formatting, and the hook needed only `sh` and `pwsh`.

The case that won: an npm package is a much better answer to "available on every
machine, in every project". The extra dependency the hook would have mostly disappears,
because a machine that installed the tool already has Node.

## Decision

- **TypeScript on Node.** The hook runs the Node and CLI paths recorded at install time
  ([ADR-003](ADR-003-hook-calls-installed-cli.md)).
- **Strip-only TypeScript:** no enums, namespaces or parameter properties. Every file
  runs under plain `node` with no build step, and the tests import `src/` directly.
- **Zero runtime dependencies.** The tool reads credential configuration, so the
  smallest possible supply chain is part of its job.
- **Evidence carried over.** Each finding measured in the PowerShell version was proven
  again in TypeScript before that version was deleted:

  | Finding | Proven by |
  | --- | --- |
  | An empty `credential.<url>.helper` resets the list | a test against real git |
  | GCM isn't on `PATH`; it ships inside Git's directory | probed by hand; no test |
  | gh has a third state, "couldn't be queried" | a `Result` that callers can't collapse into "no account" |
  | The hook must be LF-only, because `sh` rejects CRLF | a test, and CI greps the installed hook |
  | `git config --get` exits 1 for "not set" | unit tests on the git wrapper |
  | Guard scenarios A–E | the same matrix, run against real repositories in a sandbox |

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep PowerShell | A shell module is harder to distribute than an npm package. |
| Full TypeScript with a build step for tests | Loses the ability to run tests on `src/` directly. |

## Consequences

**Two Node versions.**
- **Running** needs Node 20, because the package ships compiled JavaScript.
- **Developing** needs 22.18+:
  - the tests need type stripping without a flag, which 22.18 is the first 22.x to ship;
  - `npm test` passes a glob to `node --test`, which Node 20 doesn't expand.

**`engines` stays at `>=20`.** CI's install job proves it:
- it packs the tarball;
- it installs the tarball on Node 20;
- it runs `accounts add`, `use`, `guard on`, a push the guard allows and one it refuses,
  and `off`.

The full test suite runs on Node 22 and 24.
