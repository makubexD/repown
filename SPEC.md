# Spec: colour-safe tests and faster Windows CI

## Objective
The test suite stays green whatever colour variables the shell exports, and the
Windows CI wall-clock comes down, with every test still running.

Measured on the current suite. The Windows Test step takes 8-11 min, against
about 1.5 min on ubuntu (runs 36727911874, 36724527206, 36722873986). One
`repown status` spawns about 60 processes. The fake `gh.exe` and
`git-credential-manager.exe` are compiled with `csc` about 30 times per run.
During the 0.4.0 release, Grok's shell had `FORCE_COLOR=1` and
`CLICOLOR_FORCE=1`, and that broke test/reauthor.test.ts.

The cut is the test job and the fixtures:
- Shard the Windows test job into 3. Linux and macOS stay one job each, so
  every test still runs on every OS and Node pair. release.yml reuses ci.yml,
  so a release gets the same cut.
- Compile each fake `gh.exe` and `git-credential-manager.exe` once per test
  process, and cache the path.
- `sandbox()` writes the `[user]` section into `.git/config` from the
  filesystem, in place of the two `git config` spawns in `initRepo`
  (`test/helpers.ts`).
- On the Windows job only, point `TEMP` and `TMP` at `RUNNER_TEMP` and exclude
  that directory from Defender. Keep the tweak only when a run with it is
  faster than a run without it.

## Boundaries
- Always: TDD, one commit per task, and that commit ticks its line in
  tasks/todo.md. Task 1 is red first: the suite fails with `FORCE_COLOR=1`
  and `CLICOLOR_FORCE=1` before the clear exists. Every test still runs.
  Linux and macOS stay unsharded. `src/` behaviour stays as it is.
- Ask first: any change under `src/`.
- Never: delete or skip a test; shard Linux or macOS; reduce repown's own git
  spawns (Open questions: a later spec and an ADR); push; names or emails in
  the repo.

## Commands
    npm test · npm run build
    FORCE_COLOR=1 CLICOLOR_FORCE=1 npm test
    node --test --test-shard=1/3 "test/*.test.ts"   # one Windows shard, locally

## Success criteria
- The test count across the Windows shards equals the unsharded count (820/821).
  No test is deleted or skipped.
- The slowest Windows job is at most about 5 min wall-clock, against 9-11 today.
- `FORCE_COLOR=1 CLICOLOR_FORCE=1 npm test` passes locally and in CI.
- `npm run build` is clean.

## Scenarios: colour in the shell, and the Windows Test step
| # | Situation | What the user sees today | Planned change |
|---|---|---|---|
| S1 | Forced colour env (`FORCE_COLOR=1`, `CLICOLOR_FORCE=1`) | `npm test` fails. The 0.4.0 release preflight broke in test/reauthor.test.ts. `sandbox()` clears no colour variables. Six files delete `FORCE_COLOR`, `NO_COLOR` and `TERM` by hand (cli, status, doctor, characterization, release-tool, wizard-setup), and none of them clears `CLICOLOR_FORCE` | `sandbox()` clears `NO_COLOR`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `COLORTERM` and `TERM` for the life of the sandbox and restores them on dispose, via a `TERMINAL` list beside `LEAKY` in test/helpers.ts. `plainTerminal()` replaces those six deletions and runs at file scope, before `sandbox()` saves the environment. The ubuntu Node 24 row sets both variables to `1`, so a leak fails CI. A test that wants colour sets it explicitly, as format.test.ts already does |
| S2 | Colour variables unset | The suite passes | It still passes. Clearing a variable that is already unset changes nothing, and dispose puts back whatever the caller had. The other CI rows leave the variables unset |
| S3 | Windows CI, one Test step | 8-11 min (runs 36727911874, 36724527206, 36722873986). `node --test` runs about 3 files at once on the 4-vCPU runner | windows-latest, Node 22 and 24, shards 1-3: `node --test --test-shard=${{ matrix.shard }}/3 "test/*.test.ts"`. The shard counts sum to the unsharded count. Files are independent: no fixed ports or paths, no chdir, every path from mkdtemp. The job name may include the shard; main has no required status checks and only a tag ruleset. `TEMP` and `TMP` point at `RUNNER_TEMP`, and that path is excluded from Defender; the tweak stays only if one run with it is faster than one without |
| S4 | Linux and macOS CI | ubuntu's Test step is about 1.5 min; macOS is one Node 24 job. Both run `npm test`, unsharded | They stay unsharded, on `npm test`. Every test still runs on every OS and Node pair. The ubuntu Node 24 row is the only one that forces colour (S1) |
| S5 | Cached fake gh | `csc` compiles the fakes about 30 times a run. Call sites: `fakeGhEnv` in status.test.ts, `installFakes` in doctor.test.ts (`gh.exe` and `git-credential-manager.exe`), `compileFakeGh` in cli.test.ts | Each fake is compiled once per test process. The path is cached in a module-level variable, and later tests in that process reuse the binary |

## Open questions
Reducing repown's own git spawns (one `git config --list` per scope, cached per
command) is out of this spec. It would speed the tool up for users as well as
CI, and it changes core reads, so it waits for its own spec and an ADR.
