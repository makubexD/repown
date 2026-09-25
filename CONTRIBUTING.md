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
holds, and refuses every push if it moves. In your real repositories, turn the guard on
with an installed repown.

## Making a change

- **Read the ADR** for the behaviour you're changing first. A new decision is a new ADR; a
  reversed one is superseded, never rewritten.
- **Tests first.** Anything that touches git uses `sandbox()` from
  [test/helpers.ts](test/helpers.ts), which isolates git config and clears the variables
  that would leak your identity into a test. `node --test test/guard.test.ts` runs one
  file; `node --test --test-name-pattern="<regex>" test/guard.test.ts` one test.
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

  `test/docs.test.ts` fails when a doc shows a command or option that help doesn't have.
- **Commits** are one plain sentence saying what changes and why, like the existing
  history; no prefixes.

## Pull requests and issues

Open an issue first for anything larger than a fix, so the approach can be agreed before
the work. The issue forms ask for `repown --version`, your OS and the output of `repown`
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
