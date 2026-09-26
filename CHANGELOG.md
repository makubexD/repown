# Changelog

Every release of repown, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change
commands. How a release is cut: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

- New: `repown setup`, a guided setup of the clone you're in. It asks which account owns it
  (recording a new one), whether to switch gh, allow an organisation, turn the guard on and
  stop gh being the credential helper; shows each step in plain words with its exact
  command; and runs them only when you choose Run. A clone that is already set up says so
  and offers Done (exit 0, nothing written). Every answer is also a flag, and `--no-input`
  runs it from a script.
  The other commands' output is unchanged (tests lock `fix --dry-run`, `use`'s hints and
  the help's exit codes).

- Docs: the README starts with `repown setup` and keeps what a new user needs; the
  configuration (environment variables, registry, per-clone keys, scripts and JSON) moved
  to docs/CONFIGURATION.md, and the FAQ and the comparison with other approaches to
  docs/FAQ.md.
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
