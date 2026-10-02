# CLAUDE.md

`repown` lets one machine use several git accounts without switching: each clone is pinned
to its own account (repo-local `user.name`, `user.email`, `repown.account`,
`credential.<host>.username` where measured, `user.useConfigOnly`), and a `pre-push` hook
refuses commits authored or committed by anyone else.
Docs, one purpose each:
- README.md: the user view (what, why, install, commands). test/docs.test.ts checks the
  commands, options and links in every doc but CHANGELOG, and the citation form (ADR-0NN), but
  not sample output or behaviour claims: check those against the code yourself.
- docs/HOW-IT-WORKS.md: every scenario with diagrams; update its card when behaviour or
  output changes.
- docs/CONFIGURATION.md: environment variables, the registry, per-clone keys, scripts and
  JSON. docs/FAQ.md: short answers and the comparison with other approaches. The README
  keeps only what a new user needs and links to these.
- CONTRIBUTING.md: the human contributor guide (running from a clone, the demo sandbox).
  SECURITY.md: reporting, and what the guard refuses vs reports.
- docs/RELEASING.md: how a version reaches npm. CHANGELOG.md: what changed, for users.
- **docs/decisions/: one ADR per decision, many measured empirically. Read the relevant
  ADR before changing behaviour.** Cite them as `ADR-0NN`. A new decision is a new ADR;
  a reversed one is superseded, never deleted or rewritten.

## Commands

    npm test                             # node --test "test/*.test.ts" (no framework)
    node --test test/guard.test.ts       # one file
    node --test --test-name-pattern="<regex>" test/guard.test.ts   # one test
    npm run build                        # tsc -> dist/, then type-checks test/ and scripts/ too; the only static check (no lint)
    node src/cli.ts <args>               # run from source, no build needed

Releasing: [docs/RELEASING.md](docs/RELEASING.md). Bump versions only through `npm run release:*`,
never by editing package.json: the hooks date CHANGELOG.md and the tag must match (ADR-015).

Developing needs Node 22.18+; the package targets Node 20+ (ADR-010). CI runs Linux,
Windows and macOS, so watch path separators, `.exe`, `process.platform` and line endings.

## Hard rules

- **Strip-only TypeScript:** no enums, namespaces or parameter properties. Relative imports
  end in `.ts`.
- **One runtime dependency, optional:** `@clack/prompts`, imported only by `src/wizard/clack.ts`,
  which `repown setup` and the start screen load through `choosePrompter`, by a dynamic
  `import()` (ADR-016). Nothing else may import the package; `guard check` never does. Add no other. The lockfile is `npm-shrinkwrap.json`,
  and it ships.
- **No names or email addresses in the repo.** Use `octocat`, `octo-org`, `octo-work` and `*.example.invalid`. The
  one exception is the owner's GitHub handle, which a public repo's URL, package.json
  and LICENSE can't avoid.
- **`src/core/exec.ts` is the only place that spawns processes.** It never writes to the
  console, and a non-zero exit resolves rather than rejects (`git config --get` exits 1
  for "not set"). Always `shell: false`. `run` returns the child's output and never shows
  it (credential helpers print live passwords). `inherit` hands the terminal to the child
  (`stdio: 'inherit'`) and is used only for `gh auth login`, only in a terminal: repown
  never sees what the child prints, so no credential passes through repown. A spawn error
  such as ENOENT resolves as not installed, for both.
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

- `src/program.ts` holds the command table. `src/cli.ts` imports it and starts the program;
  importing `cli.ts` runs repown, so the start screen's Show help loads that same table from
  `program.ts`. `src/ui/dispatch.ts` dispatches it, and the release tool (`scripts/release.ts`)
  reuses it. `chooseDefault` may return a command name, `'help'`, or a runner
  (`() => Promise<number>`), and dispatch uses that exit code. With no arguments,
  `src/commands/start.ts` returns a runner for setup (it passes the lead to `runSetup`
  through `SetupDeps.lead`), a runner for the start screen (`src/wizard/home-run.ts`),
  status, or the top help. Any argument skips that. `--help` is intercepted before a
  command's `run()`, so help never has side effects. A command declares its options in
  `src/commands/<name>.ts`, and `src/ui/help.ts` renders help from that same declaration, so
  help can't drift from the parser.
- Adding a host: one provider file in `src/core/hosts/` plus one line in `providers()`
  (index.ts), `generic` last, plus its label and hint in `HOSTS` (`src/wizard/setup-flow.ts`).
- The hook (`src/core/guard/hook.ts`) is LF-only. It calls the installed CLI's absolute path,
  falls back to PATH, and refuses if neither runs. Its location is where git runs hooks
  (`rev-parse --git-path hooks`, which honours `core.hooksPath`), never a hardcoded `.git/hooks`.
  Don't add `--path-format`: git before 2.31 echoes it back and exits 0.
- `check.ts` inspects the author and committer of every commit in the pushed range read from
  stdin (excluding what the remote already has), and every tagger, not the current config.
- `unpushed.ts` counts against remote-tracking refs, so its rebase advice depends on
  `push-destination.ts`: a push destination no tracking ref reaches is unknown, and the
  rebase is then conditional. `FETCH_HEAD` is no proof of a fetch; a failed one writes it (ADR-025).
- `src/ui/format.ts`: payload (`pass`/`line`/`field`) goes to stdout; `warn`/`fail`/`detail`
  and prompts go to stderr. `noted` is optional advice on stderr, in the same columns as
  `warn`, dim when that stream has colour. `displayPath` shows Windows separators on Windows
  and leaves any other path unchanged; status uses it for the clone path and doctor for the
  Git Credential Manager path. Colour is decided per stream. Decoration (`marked` for ✔/▲,
  `accent` for cyan) returns the text unchanged where that stream has no colour: never add a
  mark to plain output by hand (ADR-027). `unicodeTerminal` copies clack's
  `isUnicodeSupported`; re-check it when clack is upgraded.
- `--format json` (`scan`, `accounts list`) is a stable contract for scripts; the text
  layout isn't. Renaming a JSON field is breaking (ADR-014).
- `src/wizard/` is `repown setup`: `engine.ts` owns Back, the review loop, the opening
  review (a settled clone's first screen, before any question) and resume (Use another
  account, or the gh option, continues from there), and draws nothing. Its `Prompter.show`
  draws lines of information inside the frame (clack: a log line in the gutter; plain:
  indented two spaces). `setup-flow.ts` is pure and turns answers into existing commands'
  argv; `setup-context.ts` reads the clone once, read-only; `setup-run.ts` runs each
  command's own `run()`, never a copy; `review-text.ts` holds the words both prompters
  (`plain.ts`, `clack.ts`) share, and wraps them to the window (within the widths clack
  wraps at itself). The start screen is the same folder: `home-context.ts` reads
  (read-only), `home-flow.ts` is pure, `home-text.ts` holds the words, and `home-run.ts`
  draws through the Prompter (`show`, `choose`) and runs each action's own `run()`.
  Record an account asks setup's own new-account steps (`loginStep`, `profileSteps` in
  `setup-flow.ts`) through the engine's `runFlow`, then runs `accounts add` with every
  answer as a flag; never a second copy of those questions.

## Tests

- Anything touching git uses `sandbox()` from `test/helpers.ts`. It isolates
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, the registry (`REPOWN_CONFIG_DIR`) and gh's accounts (`GH_CONFIG_DIR`), and clears `GIT_DIR`, `GIT_*_EMAIL`, `GH_TOKEN`
  and friends, so neither the machine's config nor the shell running `npm test` leaks in.
  It also clears `NO_COLOR`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `COLORTERM` and `TERM`.
- `plainTerminal()` clears those same six in a file that does not use `sandbox()`.
  A test that wants colour sets it explicitly.
- `test/fake-exe.ts` compiles the fake `gh.exe` and `git-credential-manager.exe` once
  per process and reuses that build.
- Guard tests build foreign-authored commits with `git commit-tree`, which doesn't move HEAD.
- `test/wizard-screens.test.ts` plays `repown setup`'s real screens with key presses
  (`play()` in `test/setup-fixtures.ts`), including the opening review and resume from it,
  the start screen (the summary in the frame, the hand-over line, Show help, Back from
  the login question) and the setup lead inside the frame (F5, F6, F8). Add a scenario
  when a screen changes.
- `test/home.test.ts` covers the start screen's read, summary lines, menu, and discovery
  (a refused `.git` at any depth, a bare repository that is not walked).
- `test/format.test.ts` checks `displayPath` and which streams are coloured. `noted` is
  what prints the gh NOTE on `repown status`.
- `test/cli.test.ts` spawns the real entry point. Keep `guard check --remote "$1" --url "$2"`
  (hooks already on disk) and `--remote="$1" --url="$2"` (new hooks) working.
- `test/docs.test.ts` checks the README against `repown --help` and `repown help <group>`.
  It fails when a command or user-facing action is missing from README.md (as
  `repown <group> <action>` or in a `repown <group> a \| b` list), or when the README shows
  one help doesn't advertise, hidden aliases like `guard enable` included, or passes an
  `--option` that command's help doesn't declare. An action whose help summary says
  "not for direct use" (`guard check`) is exempt. The same command/action/option check
  runs on every other doc, and every relative link and `#anchor` in README.md, CLAUDE.md,
  CONTRIBUTING.md, SECURITY.md and docs/ must resolve. It also fails on any section-sign or `DECISIONS` file citation
  left in docs, src/ or test/.
- Traceability, in the same file: every option help declares must appear in some doc, every
  variable in help's Environment block in docs/CONFIGURATION.md, and every command/action
  in CONTRIBUTING.md's "Where each feature lives" map, whose `src/` paths must exist.
