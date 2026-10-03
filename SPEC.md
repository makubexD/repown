# SPEC: a faster test suite, every test kept

Scaffolding for this feature only; Phase 6 moves what stays true into CONTRIBUTING (and an
ADR if step 2 needs one), then deletes this file.

## Objective
`npm test` wall time well under half of 888s (measured 2026-10-02, 890 tests, 7 files at once
on 8 cores), with the same 890 tests and nothing they prove lost.

## Success criteria
1. Step 1 (split long files along their top-level suites): no file over ~150s of test time,
   the sorted test-path list (TAP, without file names) identical to the baseline, test
   bodies byte-identical, helpers moved unchanged. Target wall time <= 550s.
2. Step 2 (cheaper tests): spawns per file measured and reported at a mini-gate; each
   optimisation kept only if a full run is faster and the path list unchanged. Target for
   both steps <= 400s.

## Out of scope
Concurrency inside a file (sandbox() changes process.env); deleting, merging or skipping
tests; what test/cli.test.ts proves about the real entry point; CI's shard layout.

## Riskiest assumption
The split alone reaches ~550s: per-file times were measured under 7-way contention.
