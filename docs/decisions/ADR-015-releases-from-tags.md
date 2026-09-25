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
  - builds, packs and checks the tarball, and extracts that version's CHANGELOG notes,
    in a job that holds no token;
  - publishes the packed `.tgz` through OIDC, in a job whose only permission is
    `id-token: write` and which runs in the GitHub environment `npm`. A version
    containing `-` goes to dist-tag `next`, never `latest`;
  - creates the GitHub Release in a job whose only permission is `contents: write`.
- **The real gate lives in repository settings, not in the workflow.** A tag runs the
  `release.yml` stored at the tagged commit, so any check written there can be removed
  by whoever tags. The `npm` environment only accepts deployments from `v*` tags, a tag
  ruleset protects `v*` tags, and the npm trusted publisher names that environment.
- **No npm token exists in CI.** The one exception was the first publish (0.1.0), made
  from a maintainer machine because trust can't be configured before the package
  exists. The one-time setup then deletes that token and sets publishing access to
  "require 2FA and disallow tokens" ([docs/RELEASING.md](../RELEASING.md#5-one-time-setup)).
  So 0.1.0 has no provenance, and every later version has it.
- **What runs with the OIDC token is pinned.** Actions are pinned to commit SHAs, and npm
  to an exact version. No dependency install scripts run anywhere in the release.
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

- **Renaming `release.yml` or the `npm` environment breaks publishing** until the
  trusted publisher on npmjs.com is updated.
- **A re-run uses the tagged commit's workflow.** Fixing `release.yml` on `main` helps
  the next version, not a failed run of this one.
- **Pinned actions and npm need bumping by hand** (or by Dependabot). The pins are the
  point: nothing new runs with the OIDC token unless a commit says so.
- **No backports.** Every stable release becomes `latest`, so versions only move
  forward on `main`.
- **A bad release can't be withdrawn by reusing its number.** `npm deprecate` it and
  release a fix ([docs/RELEASING.md](../RELEASING.md)).
- The npm package page lists the npm account and its email as maintainer, which is
  registry metadata, not repository content ([ADR-008](ADR-008-no-identifiers-in-repos.md)
  still holds for the repository).
