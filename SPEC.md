# Spec: test speed, and two push-URL leftovers

## Objective
Cut the local suite's wall time a lot without weakening any test, and close two leftovers
from PR #15's review.

Baseline (2026-10-10, this Windows machine, `npm test`, four full runs): 798–847 s, median
~809 s. Cumulative test time ~5,400 s; 57 suites over 10 s hold 97% of it. One git spawn
costs ~200–300 ms here, a node child ~500 ms (CI Linux runs the whole suite in ~2 min).

## Test speed: what changes
Done (tasks 2-4): `sandbox()` copies a per-process template, `pinGithub` writes its config at
once, read-only suites build once. Full suite after them: 799-805 s, so no visible gain.

Measured after task 4 (every spawn in one full run, attributed by test file and caller):
21,960 spawns. **10% are test setup; 37% are repown called in-process, 53% repown run as
the CLI.** Spawns are throughput-bound here (git peaks near 40/s on an idle machine), so wall
time follows the spawn count, not any one file. Test-fixture work (old tasks 5-6) can win a
few percent at most: dropped.

Within one command repown reads the same facts again (one run each, pinned clone):
`repown status` 23 spawns, 20 distinct; `repown use` 38, 34 distinct; `repown setup ... --no-input`
148, only 51 distinct (`rev-parse --git-path hooks` and `--git-common-dir` 9 times each,
`remote` 7, `gh --version`, `gh auth status`, `git-credential-manager --version` 3 each).

11. **A spawn budget, measured.** A test runs `status`, `use` and non-interactive `setup` in a
    pinned clone and counts git/gh/GCM spawns per command against a budget: it fails today
    and guards against regressions after.
12. **A clone's layout is read once per run.** `--git-dir`, `--git-common-dir`, `--show-toplevel`,
    `--git-path hooks` and `--is-bare-repository` don't change during a run: repown writes no
    `core.*` key and never moves a repository. Remembered per directory for the process, so
    setup's commands (each building its own `Git`) share them. The start screen's re-read
    after an action (ADR-028) reads them again.
13. **Tool probes once per run.** `gh --version` and `git-credential-manager --version` don't
    change while repown runs; remembered per PATH. `gh auth status` is NOT remembered: setup's
    `gh` login changes it.
14. **Exact repeats inside one read.** Where one report asks git the same question twice
    (status's `credential.helper` URL match, setup's per-step re-reads of facts no step
    changes), read once and pass the answer down. Facts a step can change (config,
    commits, refs, hooks) are always read again after it.

Every item: output byte-identical (existing tests unchanged), the spawn budget lowered to
what was reached, and the full suite timed.

## Push-URL leftovers
7. **A later push URL with no readable owner is said.** `laterUrlsOf` drops it today; the
   `pushurls` line (or a non-blocking note of its own when nothing is refused) says
   `N more push URL(s) whose owner repown can't read`, never the URL.
8. **One push-URL read.** `remoteSignin`, `laterUrlsOf` and `destinationOf` each run
   `git remote get-url --push`; read the list once in `readPushFacts` and pass it down.

## Out of scope
- Concurrency inside a file: `sandbox()` changes `process.env` for the process.
- `--test-concurrency` changes and CI sharding.
- Any change to what repown prints or decides; items 12-14 change only how often it asks.
- Merging per-scope `config --list` reads into one `--show-scope` read (git 2.26; ADR-029's
  snapshot is compared against git and would need its own measurement).

## Success criteria
- No assertion removed or loosened; each test still gets its own fresh directory; full
  suite green after every task; CI green on Linux, Windows, macOS.
- Wall time measured after each task, same machine; target: spawns per `setup` run down by a
  third and the suite under 650 s (≥ 20% cut). The 500 s target assumed test setup was the cost.
- ADR-029 note with the before/after numbers and the spawn split; CLAUDE.md for the layout and
  probe memo; CHANGELOG for items 7-8 and a "faster on Windows" line for 12-14.

## Riskiest assumption
That a remembered layout fact can't go stale within one process: no repown command changes
it, and tests that rebuild a repository at the same path in one process (none known) would
read the old answer. Checked by grepping for repository rebuilds in tests and by the
start screen's ADR-028 re-read, which must forget. (The copied-repository assumption held:
task 2 green on Windows.)

## Decided
- Item 7 wording and whether it blocks: non-blocking, like the guard's own "not checked" note.
