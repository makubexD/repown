# Contributing to repown

Thanks for helping. This page covers running repown from a clone, trying it without
touching your real accounts, and getting a change merged. The rules behind the code are
in [CLAUDE.md](CLAUDE.md) (written for coding agents, and just as true for people) and the
reasons in [docs/decisions/](docs/decisions/README.md).

## What you need

- **Node 22.18+** to develop. It runs the TypeScript sources directly; the published
  package needs only Node 20 ([ADR-010](docs/decisions/ADR-010-typescript-on-node.md)).
- **git 2.32+**: the tests isolate git with `GIT_CONFIG_GLOBAL`.
- **bash** for the sandbox below (Git Bash on Windows).

```
git clone https://github.com/makubexD/repown.git
cd repown
npm install        # also builds dist/ (the prepare script)
npm test
```

## Three ways to run your working copy

| How | Command | When |
| --- | --- | --- |
| From source, no build | `node src/cli.ts <args>` | everyday development |
| As `repown` on PATH | `npm link`, then `npm run watch` in another terminal | trying it the way users do; `npm link` runs `dist/`, so it needs the watch (or `npm run build`) after each edit |
| Exactly what npm ships | `npm pack`, then `npm install -g ./repown-<version>.tgz` | checking the package itself |

Undo `npm link` with `npm unlink -g repown`.

## Try it without touching your real accounts

`use`, `accounts add`, `fix` and `guard on` change real git config and the account
registry. To try them safely, source [demo/setup.sh](demo/setup.sh) in a **new** bash
(on Windows, open Git Bash: from PowerShell, `bash` may start WSL instead):

```
bash                      # a throwaway shell: setup.sh changes HOME, PATH and the prompt
source demo/setup.sh      # run from the repository root
repown                    # a shell function running node src/cli.ts from this clone
repown use octocat
repown guard on
git commit -qm first --allow-empty && git push -u origin main    # passes
git -c user.email=someone@example.invalid commit -qm other --allow-empty
git push                  # refused: that commit carries another identity
exit                      # back to your own shell and config
```

Skip the first `bash` and `exit` closes the window instead; nothing is lost, since the
sandbox's settings only ever lived in that shell.

Each push also warns `destination not checked`: the origin is a local path, so there is
no owner to compare.

To try the guided setup there, run `repown setup` in the sandbox's clone. The sandbox's
`PATH` has no gh, so the gh questions don't appear; `NO_COLOR=1 repown setup` (with `FORCE_COLOR` unset) shows the
plain, numbered prompter instead of the arrow-key one.

What it sets up, under `/tmp/repown-demo` (`C:\repown-demo` in Git Bash), deleted and
rebuilt on every run:

- its own `HOME`, an empty global git config, no system config (`GIT_CONFIG_NOSYSTEM`);
- its own account registry (`REPOWN_CONFIG_DIR`), with `octocat` already added;
- a clone whose "GitHub" origin is a local bare repository, so a push goes nowhere real;
- a `PATH` without gh (node and git, plus Git Bash's own `/usr/bin` on Windows), so no gh
  login is reachable.

Placeholders only (octocat, `*.example.invalid`): never put a real name or address in an
example, a test or a commit to this repository.

**A hook remembers where repown ran from.** `repown guard on` writes the absolute path of
the running CLI into the hook
([ADR-003](docs/decisions/ADR-003-hook-calls-installed-cli.md)). Run from a clone, that is
your working copy's `src/cli.ts`: the guarded repository then runs whatever that checkout
holds, and if it moves, falls back to a `repown` on PATH or refuses. In your real repositories, turn the guard on
with an installed repown.

## Making a change

- **Read the ADR** for the behaviour you're changing first. A new decision is a new ADR; a
  reversed one is superseded, never rewritten.
- **Tests first.** Anything that touches git uses `sandbox()` from
  [test/helpers.ts](test/helpers.ts), which isolates git config and clears the variables
  that would leak your identity into a test. `sandbox()` and `plainTerminal()` also clear
  `NO_COLOR`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `COLORTERM` and `TERM`.
  `plainTerminal()` is what a file uses when it does not call `sandbox()`. A test that
  wants colour sets it explicitly. `node --test test/guard.test.ts` runs one file;
  `node --test --test-name-pattern="<regex>" test/guard.test.ts` one test;
  `node --test --test-shard=1/3 "test/*.test.ts"` one shard. CI runs the Windows suite
  as three of those.
- **Fake executables.** `gh.exe` and `git-credential-manager.exe` are compiled once per
  test process and then reused ([test/fake-exe.ts](test/fake-exe.ts)).
- **Changing what `repown setup` shows?** [test/wizard-screens.test.ts](test/wizard-screens.test.ts)
  plays it as a newcomer would, pressing arrows, Enter, typed text and Esc on the real
  screens (`play()` in [test/setup-fixtures.ts](test/setup-fixtures.ts)), in one scenario
  per situation. Add one for a new situation.
- **Before you push:** `npm test` and `npm run build` (the build is also the type check;
  there is no linter). CI repeats both on Linux, Windows and macOS, so watch path
  separators and line endings.
- **The hard rules** are in [CLAUDE.md](CLAUDE.md#hard-rules): strip-only TypeScript,
  one optional runtime dependency that only the wizard loads (ADR-016), one place that
  spawns processes, and no names or email addresses in the repository.
- **Docs change with the behaviour**, in the same commit:
  - README for what users see;
  - the matching [HOW-IT-WORKS](docs/HOW-IT-WORKS.md) card when output changes;
  - `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md), written for users.

  `test/docs.test.ts` fails when a doc shows a command or option that help doesn't have;
  when an option help declares is in no doc; when an environment
  variable help lists is missing from docs/CONFIGURATION.md; when a command is missing from
  the map below or a path in it doesn't exist; and when a relative link or `#anchor`
  doesn't resolve.
- **Commits** are one plain sentence saying what changes and why, like the existing
  history; no prefixes.

## Where each feature lives

Every command, where its code is, and where it's explained. A command declares its options
and help text in its own file under `src/commands/`, so help can't drift from the parser.

| Command | Code | Explained in |
| --- | --- | --- |
| `repown status` (bare `repown` when stdin or stderr is not a terminal, and inside a clone when stdout is redirected) | `src/commands/status.ts`, `src/commands/start.ts`, `src/ui/dispatch.ts`, `src/core/inspect.ts`, `src/core/push-state.ts`, `src/core/blockers.ts` | [card 5](docs/HOW-IT-WORKS.md#5-check-where-you-are) |
| Start screen (bare `repown` in a terminal, outside a clone or in a bare repository) | `src/commands/start.ts`, `src/wizard/home-context.ts`, `src/wizard/home-flow.ts`, `src/wizard/home-text.ts`, `src/wizard/home-run.ts`, `src/wizard/clack.ts` (its frame and accents), `src/program.ts` | [card 14](docs/HOW-IT-WORKS.md#14-outside-a-clone) |
| `repown doctor` | `src/commands/doctor.ts`, `src/core/inspect.ts`, `src/core/credential/gcm.ts`, `src/core/credential/gh.ts` | [card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine) |
| `repown fix` | `src/commands/fix.ts`, `src/core/credential/repair.ts` | [card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine) |
| `repown reauthor` | `src/commands/reauthor.ts`, `src/core/reauthor.ts`, `src/core/push-destination.ts` | [card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| `repown accounts list`, `repown accounts add`, `repown accounts remove` | `src/commands/accounts.ts`, `src/core/registry.ts` | [card 2](docs/HOW-IT-WORKS.md#2-remember-an-account), [the registry](docs/CONFIGURATION.md#the-account-registry) |
| `repown use` | `src/commands/use.ts`, `src/core/identity.ts`, `src/core/registry.ts`, `src/core/credential/gh.ts`, `src/core/unpushed.ts`, `src/core/push-destination.ts` | [card 3](docs/HOW-IT-WORKS.md#3-pin-a-clone), [per-clone keys](docs/CONFIGURATION.md#per-clone-keys) |
| `repown off` | `src/commands/off.ts`, `src/core/identity.ts` | [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing) |
| `repown guard on`, `repown guard off`, `repown guard status` | `src/commands/guard.ts`, `src/core/guard/hook.ts` | [card 7](docs/HOW-IT-WORKS.md#7-push-what-the-guard-checks), [card 10](docs/HOW-IT-WORKS.md#10-other-hook-tools) |
| `repown guard check` (the hook calls it) | `src/commands/guard.ts`, `src/core/guard/check.ts` | [card 7](docs/HOW-IT-WORKS.md#7-push-what-the-guard-checks), [card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| `repown scan` | `src/commands/scan.ts`, `src/core/inspect.ts`, `src/core/git.ts` | [card 11](docs/HOW-IT-WORKS.md#11-audit-re-point-move-machines), [JSON](docs/CONFIGURATION.md#scripts-and-ci) |
| `repown setup` | `src/commands/setup.ts`, `src/core/push-state.ts`, `src/core/blockers.ts`, `src/wizard/setup-run.ts`, `src/wizard/setup-context.ts`, `src/wizard/setup-flow.ts`, `src/wizard/setup-changes.ts`, `src/wizard/engine.ts`, `src/wizard/review-text.ts`, `src/wizard/clack.ts`, `src/wizard/plain.ts`, `src/core/unpushed.ts`, `src/core/push-destination.ts` | [card 13](docs/HOW-IT-WORKS.md#13-guided-setup), [scripts and CI](docs/CONFIGURATION.md#scripts-and-ci) |

Shared by all of them:
- **Parsing, help and dispatch:** `src/program.ts` (the command table; `src/cli.ts` imports it and starts the program), `src/ui/dispatch.ts`, `src/ui/command.ts`
  (how a command declares its options), `src/ui/args.ts`, `src/ui/help.ts`,
  `src/ui/suggest.ts` (did-you-mean).
- **Output, colour and prompts:** `src/ui/format.ts`, `src/ui/prompt.ts`.
- **Reading a clone and the machine:** `src/core/inspect.ts`, `src/core/git.ts` (every git
  call), `src/core/version.ts` (whether git or gh is new enough), `src/core/url.ts` (remote URLs and owners), `src/core/result.ts` (answers that can fail).
- **Hosts** (what each one can pin): `src/core/hosts/`. Adding one is one file there plus
  one line in `providers()` (`src/core/hosts/index.ts`), with `generic` last, plus its
  label and hint in setup's `HOSTS` (`src/wizard/setup-flow.ts`).
- **The one place that runs processes:** `src/core/exec.ts`.
- **The release tool:** `scripts/release.ts` ([RELEASING](docs/RELEASING.md)).

## Pull requests and issues

Open an issue first for anything larger than a fix, so the approach can be agreed before
the work. The issue forms ask for `repown --version`, your OS and the output of `repown status`
and `repown doctor`, with placeholders for names and addresses. Pull requests run CI on
all three operating systems, and the template's checklist is the list above. Dependabot
proposes updates to the pinned actions and the npm dependencies weekly; they go through CI
and review like any other pull request.

Found a security problem? Don't open an issue: see [SECURITY.md](SECURITY.md).

## Releasing

Maintainers only: [docs/RELEASING.md](docs/RELEASING.md).

## The demo

`vhs demo/demo.tape` records the sandbox above with [VHS](https://github.com/charmbracelet/vhs).
No GIF is committed yet: VHS hasn't rendered on the machines tried so far.
