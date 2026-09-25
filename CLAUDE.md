# CLAUDE.md

`repown` lets one machine use several git accounts without switching: each clone is pinned
to its own account (repo-local `user.name`, `user.email`, `repown.account`,
`credential.<host>.username` where measured, `user.useConfigOnly`), and a `pre-push` hook
refuses commits authored or committed by anyone else.
Docs, one purpose each:
- README.md: the user view (what, why, install, commands). test/docs.test.ts checks the
  commands, options, links and ADR citations in every doc, but not sample output or
  behaviour claims: check those against the code yourself.
- docs/HOW-IT-WORKS.md: every scenario with diagrams; update its card when behaviour or
  output changes.
- **docs/decisions/: one ADR per decision, many measured empirically. Read the relevant
  ADR before changing behaviour.** Cite them as `ADR-0NN`. A new decision is a new ADR;
  a reversed one is superseded, never deleted or rewritten.

## Commands

    npm test                             # node --test "test/*.test.ts" (no framework)
    node --test test/guard.test.ts       # one file
    node --test --test-name-pattern="<regex>" test/guard.test.ts   # one test
    npm run build                        # tsc -> dist/, then type-checks test/ too; the only static check (no lint)
    node src/cli.ts <args>               # run from source, no build needed

Releasing: [docs/RELEASING.md](docs/RELEASING.md). Bump versions only through `npm run release:*`,
never by editing package.json: the hooks date CHANGELOG.md and the tag must match (ADR-015).

Developing needs Node 22.18+; the package targets Node 20+ (ADR-010). CI runs Linux,
Windows and macOS, so watch path separators, `.exe`, `process.platform` and line endings.

## Hard rules

- **Strip-only TypeScript:** no enums, namespaces or parameter properties. Relative imports
  end in `.ts`.
- **Zero runtime dependencies.**
- **No names or email addresses in the repo.** Use `octocat`, `octo-org`, `octo-work` and `*.example.invalid`. The
  one exception is the owner's GitHub handle, which a public repo's URL, package.json
  and LICENSE can't avoid.
- **`src/core/exec.ts` is the only place that spawns processes.** It never writes to the
  console (credential helpers print live passwords), and a non-zero exit resolves rather
  than rejects (`git config --get` exits 1 for "not set"). Always `shell: false`.
- **Every `git log` passes `--no-show-signature`.** `scan` runs it in repositories
  it merely found, and their config can set `gpg.program`.
- **A skipped check must never look like a passed one.** Failures that are answers
  ("gh could not be queried") are a `Result` (`src/core/result.ts`), never null or empty.
- **Severity (ADR-011):** the guard refuses only what's irreversible (a foreign author,
  committer or tagger, a wrong destination owner, no pinned identity, commits it can't
  read, `GH_TOKEN`/`GITHUB_TOKEN`/`GIT_*_EMAIL` set). It ignores credential and gh problems; `repown` and
  `repown doctor` report those.
- **Credential pinning is claimed only where it was measured.** An empty `credentialKeys()`
  means "can't pin", never a guess. Azure DevOps is deliberately unpinned (ADR-009).
- `.claude/rules/code-quality.md` applies: functions ≤20 lines, ≤4 params, no
  commented-out code.

## Non-obvious structure

- `src/cli.ts` only declares the program; `src/ui/dispatch.ts` dispatches it, and the release
  tool (`scripts/release.ts`) reuses it. `--help` is intercepted before a command's `run()`, so help
  never has side effects. A command declares its options in `src/commands/<name>.ts`, and
  `src/ui/help.ts` renders help from that same declaration, so help can't drift from the
  parser.
- Adding a host: one provider file in `src/core/hosts/` plus one line in `providers()`
  (index.ts). `generic` stays last.
- The hook (`src/core/guard/hook.ts`) is LF-only. It calls the installed CLI's absolute path,
  falls back to PATH, and refuses if neither runs. Its location is where git runs hooks
  (`rev-parse --git-path hooks`, which honours `core.hooksPath`), never a hardcoded `.git/hooks`.
  Don't add `--path-format`: git before 2.31 echoes it back and exits 0.
- `check.ts` inspects the author and committer of every commit in the pushed range read from
  stdin (excluding what the remote already has), and every tagger, not the current config.
- `src/ui/format.ts`: payload (`pass`/`line`/`field`) goes to stdout; `warn`/`fail`/`detail`
  and prompts go to stderr. Colour is decided per stream.
- `--format json` (`scan`, `accounts list`) is a stable contract for scripts; the text
  layout isn't. Renaming a JSON field is breaking (ADR-014).

## Tests

- Anything touching git uses `sandbox()` from `test/helpers.ts`. It isolates
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` and clears `GIT_DIR`, `GIT_*_EMAIL`, `GH_TOKEN`
  and friends, so neither the machine's config nor the shell running `npm test` leaks in.
- Guard tests build foreign-authored commits with `git commit-tree`, which doesn't move HEAD.
- `test/cli.test.ts` spawns the real entry point. Keep `guard check --remote "$1" --url "$2"`
  (hooks already on disk) and `--remote="$1" --url="$2"` (new hooks) working.
- `test/docs.test.ts` checks the README against `repown --help` and `repown help <group>`.
  It fails when a command or user-facing action is missing from README.md (as
  `repown <group> <action>` or in a `repown <group> a \| b` list), or when the README shows
  one help doesn't advertise, hidden aliases like `guard enable` included, or passes an
  `--option` that command's help doesn't declare. An action whose help summary says
  "not for direct use" (`guard check`) is exempt. The same command/action/option check
  runs on every other doc, and every relative link and `#anchor` in README.md, CLAUDE.md
  and docs/ must resolve. It also fails on any section-sign or `DECISIONS` file citation
  left in docs, src/ or test/.
