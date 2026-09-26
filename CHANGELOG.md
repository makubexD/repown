# Changelog

Every release of repown, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change
commands. How a release is cut: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

- New: `repown setup`, a guided setup of the clone you're in. It asks which account owns
  it (recording a new one), whether to switch gh, whether this clone may push to origin's
  owner (an organisation or a collaborator), whether to turn the guard on, and whether to
  stop gh being git's credential helper (machine-wide). It shows each step in plain words
  with its exact command, and changes nothing until you choose Run. A clone that is
  already set up says so and offers Done. In a plain terminal it asks with numbered
  choices.
- `repown setup` exit codes: 0 when done or already set up, 1 when declined or it can't
  start, 2 for flags that don't fit or no terminal without `--no-input`, 130 on Esc or
  Ctrl-C. A failing step
  stops the rest, lists what didn't run, and exits with that command's code.
- Every `repown setup` question is also a flag; add `--no-input` to run it from a script.

- Docs: the README starts with `repown setup` and keeps what a new user needs, with one
  table of commands ordered by when you run them; the configuration (environment
  variables, registry, per-clone keys, scripts and JSON) moved to docs/CONFIGURATION.md,
  and the FAQ and the comparison with other approaches to docs/FAQ.md. SECURITY.md
  explains how to report a vulnerability privately.
- `repown help scan`: `--emails` shows exact addresses instead of domains; the counts
  stay (the help said they went).
- `repown guard on` warns when it runs from npx's cache: the hook would call that
  temporary copy, and once that is deleted it refuses every push unless another repown
  is on PATH. Install globally, then run `repown guard on` again.
- One optional runtime dependency, `@clack/prompts` 1.8.1, for interactive prompts. It's
  pinned exactly, its tree is locked by the `npm-shrinkwrap.json` that now ships in the
  package, and only `repown setup` loads it; the pre-push hook never does. Where it can't
  load, `repown setup` asks with plain numbered prompts.

## [0.1.1] - 2026-09-25

- Fixed: `repown use -` (and `accounts add -`, `accounts remove -`, `scan -`) is a
  usage error again. 0.1.0 read the bare `-` as a name and pinned an account called
  "-".
- Unknown commands and actions now say which `repown help` to run.
- Published from GitHub Actions through npm trusted publishing, with provenance.

## [0.1.0] - 2026-09-25

- First release on npm: `npm install -g repown`.
- `repown use <account>` pins a clone to one account: repo-local `user.name`,
  `user.email`, `repown.account`, `user.useConfigOnly`, and the credential username
  where it was measured (GitHub; not Azure DevOps).
- `repown guard on | off | status` manages a `pre-push` hook that refuses commits
  authored or committed by anyone else, pushes to a foreign destination owner, and
  pushes with identity-overriding environment variables set.
- `repown status`, `repown doctor` and `repown fix` show and repair what serves
  credentials on the machine.
- `repown accounts list | add | remove` keeps the per-machine account registry.
- `repown scan` audits every clone under a directory; `--format json` is a stable
  contract for scripts.
- Runs on Node 20+ on Windows, macOS and Linux, with zero runtime dependencies.

[Unreleased]: https://github.com/makubexD/repown/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/makubexD/repown/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/makubexD/repown/releases/tag/v0.1.0
