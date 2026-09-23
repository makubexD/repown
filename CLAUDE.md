# CLAUDE.md

`gid` lets one machine use several git accounts without switching: each clone is pinned
to its own account (repo-local `user.name`, `user.email`, `credential.<host>.username`,
`user.useConfigOnly`), and a `pre-push` hook refuses commits authored or committed by
anyone else.
README.md is the user view. **docs/DECISIONS.md holds the reasons, many of them measured
empirically; read the relevant section before changing behaviour.**

## Commands

    npm test                             # node --test "test/*.test.ts" (no framework)
    node --test test/guard.test.ts       # one file
    node --test --test-name-pattern="<regex>" test/guard.test.ts   # one test
    npm run build                        # tsc -> dist/; also the only static check (no lint)
    node src/cli.ts <args>               # run from source, no build needed

Developing needs Node 22.6+; the package targets Node 20+ (DECISIONS §7). CI runs Linux,
Windows and macOS, so watch path separators, `.exe`, `process.platform` and line endings.

## Hard rules

- **Strip-only TypeScript:** no enums, namespaces or parameter properties. Relative imports
  end in `.ts`.
- **Zero runtime dependencies.**
- **No names or email addresses in the repo.** Use `octocat` and `*.example.invalid`.
- **`src/core/exec.ts` is the only place that spawns processes.** It never writes to the
  console (`git credential fill` prints live passwords), and a non-zero exit resolves rather
  than rejects (`git config --get` exits 1 for "not set"). Always `shell: false`.
- **A skipped check must never look like a passed one.** Failures that are answers
  ("gh could not be queried") are a `Result` (`src/core/result.ts`), never null or empty.
- **Severity (DECISIONS §8):** the guard refuses only what's irreversible (a foreign author,
  a wrong destination owner, no pinned identity, `GH_TOKEN`/`GIT_*_EMAIL` set). It ignores
  credential and gh problems; `gid` and `gid doctor` report those.
- **Credential pinning is claimed only where it was measured.** An empty `credentialKeys()`
  means "can't pin", never a guess. Azure DevOps is deliberately unpinned (DECISIONS §6).
- `.claude/rules/code-quality.md` applies: functions ≤20 lines, ≤4 params, no
  commented-out code.

## Non-obvious structure

- `src/cli.ts` only dispatches. `--help` is intercepted before a command's `run()`, so help
  never has side effects. A command declares its options in `src/commands/<name>.ts`, and
  `src/ui/help.ts` renders help from that same declaration, so help can't drift from the
  parser.
- Adding a host: one provider file in `src/core/hosts/` plus one line in `providers()`
  (index.ts). `generic` stays last.
- The hook (`src/core/guard/hook.ts`) is LF-only. It calls the installed CLI's absolute path,
  falls back to PATH, and refuses if neither runs. `check.ts` inspects the author and
  committer of every commit in the pushed range read from stdin (excluding what the remote
  already has), not the current config.
- `src/ui/format.ts`: payload (`pass`/`line`/`field`) goes to stdout; `warn`/`fail`/`detail`
  and prompts go to stderr. Colour is decided per stream.

## Tests

- Anything touching git uses `sandbox()` from `test/helpers.ts`. It isolates
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, so the machine's own config can't leak in.
- Guard tests build foreign-authored commits with `git commit-tree`, which doesn't move HEAD.
- `test/cli.test.ts` spawns the real entry point. Keep `guard check --remote --url` working,
  because every installed hook calls exactly that.
- `test/docs.test.ts` checks the README against `gid --help`. Adding or renaming a command
  means updating README.md, or this test fails.
