# ADR-029: Read-only commands read git config once per scope

**Status:** Accepted.

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
- **The snapshot answers the four getters from one `git config [--scope] --list -z` per scope
  it is asked about**, read on first use. It builds the exact output git's own `--get`,
  `--get-all` or `--type=bool --get` would print, and `Git` parses it as before. Matching
  git's rules:
  - **Includes:** the same scope flags as the original read, so includes are followed only
    when no scope is given.
  - **Keys:** case-insensitive section and name; a case-sensitive subsection.
  - **Values:** last value wins; a key with no `=` is true.
  - **Booleans:** `true`/`yes`/`on`, `false`/`no`/`off`/empty, an integer with `k`/`m`/`g`;
    anything else fails as git fails.
  - **A failing scope** (`--local` outside a repository) fails every read the same way.
- **Everything else passes through to git:** `--get-urlmatch` (credential helpers),
  `--get-regexp --show-origin`, and every non-config command.
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
- **`--get-urlmatch` and `--show-origin` reads still start a process each.**
