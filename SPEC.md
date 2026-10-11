# Spec: test speed, and two push-URL leftovers

## Objective
Cut the local suite's wall time a lot without weakening any test, and close two leftovers
from PR #15's review.

Baseline (2026-10-10, this Windows machine, `npm test`, four full runs): 798–847 s, median
~809 s. Cumulative test time ~5,400 s; 57 suites over 10 s hold 97% of it. One git spawn
costs ~200–300 ms here, a node child ~500 ms (CI Linux runs the whole suite in ~2 min).

## Test speed: what changes
1. **A template repository.** `sandbox()` (`test/helpers.ts`) runs `git init` per test. Build
   one initialised repository per process and copy it (`fs.cpSync`) into each new sandbox.
2. **Fixture config written to the file.** Helpers that run one `git config` per key
   (`pinGithub` in `test/status-helpers.ts`, similar ones) append the same lines to
   `.git/config` in one write, as `sandbox()` already does for `[user]`.
3. **Read-only suites build once.** `config-snapshot`'s describe (`before()` instead of
   `beforeEach`); guard check's `commitAs` caches `HEAD^{tree}`/`HEAD`.
4. **Built fixtures copied per test.** `publishedThenLocal` (use.test.ts), reauthor's `field()`
   (shared across its split files through `test/reauthor-helpers.ts`), setup-closing's `clean()`,
   push-state's first commit: build once per file, `cpSync` per test, rewrite absolute
   paths (`remote.origin.url`) after the copy.
5. **Parallel reads inside one test.** config-snapshot's ~320 sequential reads use `Promise.all`.
6. **In-process where a CLI spawn only builds a fixture.** `use`/`guard on|off` calls that set
   up wizard-setup-terminal and setup-context fixtures call the command's own `run()`.
   Tests whose subject is the real entry point (`test/cli*.test.ts`, colour/TERM spawns,
   no-terminal behaviour) keep spawning.

## Push-URL leftovers
7. **A later push URL with no readable owner is said.** `laterUrlsOf` drops it today; the
   `pushurls` line (or a non-blocking note of its own when nothing is refused) says
   `N more push URL(s) whose owner repown can't read`, never the URL.
8. **One push-URL read.** `remoteSignin`, `laterUrlsOf` and `destinationOf` each run
   `git remote get-url --push`; read the list once in `readPushFacts` and pass it down.

## Out of scope
- Concurrency inside a file: `sandbox()` changes `process.env` for the process.
- `--test-concurrency` changes and CI sharding.
- Any product behaviour change beyond items 7–8.

## Success criteria
- No assertion removed or loosened; each test still gets its own fresh directory; full
  suite green after every task; CI green on Linux, Windows, macOS.
- Wall time measured after each task, same machine; target under 500 s (≥ 40% cut).
- ADR-029 note with the before/after numbers; CLAUDE.md Tests section updated for the
  template and copy helpers; CHANGELOG entry for items 7–8 only.

## Riskiest assumption
That a copied repository behaves exactly like a freshly built one on Windows: absolute paths
inside `.git/config` and remotes, file locks on a just-written directory, and the index's
stat data (a copied index can make git re-hash or see files as modified). Measured on the
first copy task before it spreads.

## Decided
- Item 7 wording and whether it blocks: non-blocking, like the guard's own "not checked" note.
