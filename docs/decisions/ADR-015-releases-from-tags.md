# ADR-015: Releases are tag-driven and published from CI by trusted publishing

**Status:** Accepted

## Context

repown goes to npm as `repown`. Three things had to be decided:

- **How a version gets cut.** Commits here are plain sentences pushed straight to
  `main`, with no pull requests and no Conventional Commits prefixes.
- **Where publishing happens.** Either a maintainer's machine or CI.
- **How the registry trusts it.** The tool reads credential configuration
  ([ADR-010](ADR-010-typescript-on-node.md)), so a long-lived npm token stored somewhere is
  exactly the kind of secret it exists to keep out of the wrong place.

What was checked before deciding, in September 2026:

- **npm trusted publishing** (docs.npmjs.com/trusted-publishers):
  - OIDC from GitHub-hosted runners needs npm ≥ 11.5.1, Node ≥ 22.14 and
    `id-token: write`.
  - npm checks the *calling* workflow's filename, and `repository.url` must match the
    repository.
  - Provenance is attached automatically.
  - A trusted publisher can only be configured for a package that already exists.
- **How other projects do it:** vite (OIDC from CI, no token), np's pre-publish
  checklist, release-please, semantic-release, changesets.

## Decision

- **A version is cut locally with `npm version`**, through `npm run release:<bump>`.
  - npm's `preversion` hook refuses unless:
    - `scripts/release.ts check repo` passes: on `main`, clean tree, level with
      upstream, Unreleased not empty;
    - the tests pass;
    - the build passes;
    - `check package` passes on the tarball.
  - The `version` hook dates CHANGELOG.md's Unreleased section into the version commit.
  - `prepublishOnly` runs `check tag`, not the suite again. The `v<version>` tag on
    HEAD proves `preversion` passed on that commit, and re-running about 300
    git-spawning tests added minutes to every `npm publish`, dry runs included.
  - The tag is annotated, `v<version>`.
- **The changelog is drafted from git history** (`npm run changelog`) and edited by
  hand. The commit style stays as it is.
- **Pushing the tag is the approval.** `.github/workflows/release.yml` then:
  - runs the whole CI workflow;
  - checks that the tag equals `package.json`'s version, and that the tagged commit is
    on `main`;
  - publishes through OIDC. A version containing `-` goes to dist-tag `next`, never
    `latest`.
  - creates the GitHub Release from that version's CHANGELOG section.
- **No npm token exists in CI.** The one exception was the first publish (0.1.0), made
  from a maintainer machine because trust can't be configured before the package
  exists. After it, publishing access is set to "require 2FA and disallow tokens".
- **The release workflow is idempotent.** A version already on the registry is skipped,
  so re-running a failed release only does what's missing.
- **The release tool is a second program on repown's own dispatcher**
  (`src/ui/dispatch.ts`). Its help, usage errors and exit codes behave like repown's.
  It never spawns npm (`npm.cmd` can't run with `shell: false`), so npm's output is piped
  into it instead.

## Alternatives considered

| Option | Why not |
| --- | --- |
| An `NPM_TOKEN` repository secret | A long-lived credential to leak and rotate (granular tokens expire within 90 days). OIDC removes it. |
| release-please | Needs Conventional Commits, and its release PR doesn't run CI under the default token without adding a PAT or a GitHub App. |
| semantic-release | Fully automatic versions from Conventional Commits, and a dependency tree to install. |
| changesets | One changeset file per change, and a dev dependency, for what is a single package. |
| np, or publishing from a laptop | Needs a token or an OTP on the machine, and gives no provenance. |
| Staged publishing (`npm stage publish`, approve with 2FA) | Stronger, but an extra approval per release that a solo maintainer pushing their own tag doesn't need. Worth adopting if more people can push tags. |

## Consequences

- **Renaming `release.yml` breaks publishing** until the trusted publisher on npmjs.com
  is updated.
- **Whoever can push a `v*` tag can publish**, though only a commit already on `main`.
  A tag ruleset on GitHub narrows who that is.
- **The publish job runs no dependency install scripts** (`npm ci --ignore-scripts`, then
  an explicit build) and keeps no git credentials. It's the one job that can mint an
  npm OIDC token.
- **No backports.** Every stable release becomes `latest`, so versions only move
  forward on `main`.
- **A bad release can't be withdrawn by reusing its number.** `npm deprecate` it and
  release a fix ([docs/RELEASING.md](../RELEASING.md)).
- The npm package page lists the npm account and its email as maintainer, which is
  registry metadata, not repository content ([ADR-008](ADR-008-no-identifiers-in-repos.md)
  still holds for the repository).
