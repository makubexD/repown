# ADR-016: One optional runtime dependency, @clack/prompts, for the setup wizard

**Status:** Accepted. Supersedes, in part, [ADR-010](ADR-010-typescript-on-node.md): its
"zero runtime dependencies" line only. Strip-only TypeScript and Node 20+ stand.

## Context

The setup wizard guides someone new through pinning a clone: choose or record the account,
allow an organisation, turn the guard on, hand the credential helper back. The logic is the
existing commands'; the wizard only asks and then runs them. How it asks is the whole
point of the feature, so the prompts should be as clear as a modern CLI's: arrow-key
selects with a hint per choice, defaults, a spinner while state is read, a review.

ADR-010 kept the runtime tree empty because the tool reads credential configuration, and
every dependency is code that runs with the user's environment. What was checked before
changing that, in September 2026:

- **@clack/prompts 1.8.1** has no back navigation (the wizard's engine provides it), writes
  to any stream it's given, and cancels on Esc and Ctrl-C. Its tree is 6 packages, about
  180 kB, all MIT, none with install scripts: @clack/prompts, @clack/core, sisteransi,
  fast-wrap-ansi, fast-string-width, fast-string-truncated-width.
- **It declares Node >= 20.12**, and colours with `util.styleText`, which ignores
  `NO_COLOR` and `FORCE_COLOR` before Node 20.18 / 22.8 and decides from stdout, not the
  stream it draws on.
- **npm skips an optional dependency whose `engines` don't match**, even with
  `engine-strict`, and the install succeeds (measured with npm 11 and a package declaring
  Node >= 99).

## Decision

- **`@clack/prompts` is an optional dependency, pinned exactly** (`1.8.1`). Where it can't
  install or can't load, the wizard falls back to its own plain prompter (numbered
  choices, words instead of symbols). `engines` stays `>=20`.
- **The whole tree is locked by `npm-shrinkwrap.json`**, which ships in the tarball
  (`files`, and `check package` requires it). It replaces package-lock.json.
- **Only `src/wizard/clack.ts` imports it, and that file is loaded only through a dynamic
  `import()`** once `setup` has decided to prompt. No other command, and above all not
  `guard check`, which the pre-push hook runs ([ADR-003](ADR-003-hook-calls-installed-cli.md)),
  can load it: test/characterization.test.ts finds no import of `@clack` outside that file,
  and runs `guard check`, the help, and the other commands it can run safely under a
  resolver that fails if clack is asked for.
- **The plain prompter is used whenever repown's own colour rule says no colour**
  (`NO_COLOR`, `TERM=dumb`, stderr not a terminal), so clack's own colour decision never
  overrides it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Hand-written arrow-key widgets on node:readline | Zero dependencies, but about 150 lines of raw-mode terminal code to maintain and test on three operating systems, for a worse result. |
| A regular (non-optional) dependency | On Node 20.0–20.11, which `engines: >=20` supports, npm would warn on every install and refuse it under `engine-strict`, for a feature most runs never use. |
| An optional peer dependency | Not installed by default: a newcomer would need a second, manual install to get the experience the wizard is for. |
| Vendoring clack's source | The same code, but outside Dependabot and the lockfile. |

## Consequences

- **`npm install -g repown` now installs 7 packages, not 1.** The six are inert unless
  the setup wizard prompts.
- **The exact tree is guaranteed for npm and npx only.** yarn and pnpm ignore the
  shrinkwrap and resolve clack's own `^` ranges.
- **Exposure is limited, not zero.** During a `setup` run, clack's code runs in the same
  process as the commands it drives, with the user's environment.
- **Dependabot is configured to propose clack updates** as separate pull requests, with
  `versioning-strategy: increase` so the pin stays exact. The transitive packages are
  locked by the shrinkwrap, so they change when clack is updated or a security update
  bumps them.
- **Node 20 is end-of-life** (April 2026). On 20.0–20.11 the dependency is skipped and the
  wizard uses the plain prompter; nothing else changes.

## Amendments

- **2026-09-25, as built.** Two details of the Decision differ in the code:
  - **No spinner.** clack's spinner takes over Ctrl-C and exits 0, where a cancel must
    exit 130, so reading the clone shows one step line instead.
  - **When the plain prompter is used:** `NO_COLOR` or `FORCE_COLOR=0`, always
    `TERM=dumb`, and whenever clack fails to load. Without a terminal, setup never gets
    as far as a prompter: it exits 2, naming the flags to pass.
