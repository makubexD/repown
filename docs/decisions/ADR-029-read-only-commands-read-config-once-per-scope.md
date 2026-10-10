# ADR-029: Read-only commands read git config once per scope

**Status:** Accepted. Amended by its 2026-10-10 note: push-destination reads through a snapshot of its own.

## Context

repown reads git config one key at a time: every `getConfig`, `getBoolConfig`,
`getAllConfig` and `getAllConfigRaw` is its own `git config --get` child process. One
`repown status` in a clone started 68 processes, 37 of them `git config` reads spread across
identity, push-destination, push-state, inspect and status. On Windows a git process costs
about 55 ms idle and several hundred under load. PR #7 deferred "one `git config --list` per
scope" to a decision of its own.

The test suite showed the same cost at scale. After its long files were split (2026-10), it
was bound by process starts: about 22,800 git spawns per run, 13,500 of them `git config`.

## Decision

- **A read-only command takes a `ConfigSnapshot` of its `Git`** (`snapshotOf`,
  `src/core/config-snapshot.ts`):
  - `repown status`, `repown doctor`, `repown scan` and `guard check` (before every push);
  - the start screen's read of each clone;
  - setup's `readContext`, before its questions.
- **The snapshot answers the plain getters (`getConfig`, `getAllConfig`, `getAllConfigRaw`)
  from one `git config [--scope] --list -z` per scope it is asked about**, read on first use.
  It builds the output git's own `--get` or `--get-all` prints for that key, and `Git` parses
  it as before. Matching git's rules:
  - **Includes:** the same scope flags as the original read, so includes are followed only
    when no scope is given.
  - **Keys:** case-insensitive section and name; a case-sensitive subsection.
  - **Values:** last value wins; a key with no `=` is true.
  - **A failing scope** (`--local` outside a repository, a broken file) fails every read of
    that snapshot, as each `--get` would; one failed list is shared, timeouts included.
  - **A scope with no file at all** reads as unset: `--list` fails there ("unable to read
    config file") where `--get` says "not set", so the snapshot answers "not set".
- **Everything else passes through to git:** `--type=bool` reads (git's integer forms, hex and
  range check included, are not re-implemented), `--get-urlmatch` (credential helpers),
  `--show-origin --get-regexp`, and every non-config command. Only the query position is
  looked at, so a value that reads like a flag is still a write.
- **`snapshotOf` takes a plain `Git` only:** a snapshot keeps just the cwd, so a subclass's
  overrides would be dropped; it refuses one instead.
- **A snapshot refuses config writes.** Code that writes keeps the plain `Git`. `use`, setup's
  run, `fix`, `reauthor` and `accounts` are unchanged, so no cached value can outlive a write.
- `test/config-snapshot.test.ts` reads every key, in every scope, both ways and compares.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A cache inside every `Git`, cleared on write | Other writers can't clear it: another `Git` instance on the same repository (setup runs `use`, `guard on`, `fix` through their own), gh's `auth setup-git`, a hook. Setup compares config before and after each step, and a stale read would misreport what changed. |
| One effective `--list --show-origin --show-scope`, filtered by scope | A scoped `--get` doesn't follow includes, while the effective list tags included entries with the including file's scope. Telling them apart means re-deriving git's file list per scope. One list per scope is git's own answer. |
| Parse the config files directly | Re-implements includes, `includeIf`, environment overrides (`GIT_CONFIG_*`, `-c`) and quoting. |
| Leave it | Every status, doctor and push pays for 30+ processes it doesn't need. |

## Consequences

- **`repown status`** in a clone: 68 processes became 38, `git config` reads 37 became 7, and
  wall time went from 4.2 s to 2.7 s on the measuring machine (Windows, idle).
- **`guard check`**, which runs on every push, starts fewer processes in the same way.
- **New config reads** in these paths cost nothing extra. A new read-only command should take
  a snapshot; code that may write must not be handed one (it throws, so a test will say so).
- **`--type=bool`, `--get-urlmatch` and `--show-origin` reads still start a process each.**
- **A snapshot is never stored** past the read it serves (the start screen re-reads each round,
  ADR-028), so a cached list can't outlive a write.

## Notes

- **2026-10-10, push-destination reads through a snapshot of its own.** `use` and `reauthor`
  write config, so they hold a plain `Git`, and working out where a plain push goes read about
  eight keys there, one `git config` each. `unknownDestination`, `pushTarget` and
  `hasTrackingRefs` now take a snapshot (`readerOf`) for their own reads: one list per call.
  A `Git` subclass (a test's failing rebase) is used as it is, since a snapshot keeps only the
  cwd. For: the same answers from one process instead of eight. Against: a snapshot made
  inside each call, so a caller reading the destination twice lists config twice; never one
  kept across a write.
- **2026-10-10, not changed: writers still write one key per `git config` call.** `use` and
  setup's run set each key in its own process, and URL-match and origin reads still ask git
  per key: git has no multi-key config write, and those reads follow rules a snapshot does not
  copy.
