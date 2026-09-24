# Plan: publish repown to npm, with a release tool that makes each version one command

## Context
The GitHub repository `makubexD/repown` is public. Separately, `package.json` contains
the npm flag `"private": true`. That flag has nothing to do with GitHub visibility: it
tells npm to refuse `npm publish`, so the package can't reach the registry until it's
removed. The version is 0.1.0, and the README says "it isn't on npm yet". The goal:
- publish it as npm account `makudev1719`;
- make every later release a short, checked routine: draft the changelog, bump, tag,
  push, and CI publishes.

Checked so far:
- The name `repown` is free (`npm view` returns 404).
- The token authenticates as `makudev1719`.
- `makubexD/repown` is public, so provenance works.
- `dist/cli.js` keeps its shebang.
- CI already packs the tarball and installs it on Node 20.
- Commits are plain sentences pushed straight to `main` (87 so far, no PRs).

Decisions you made:
- **0.1.0** first.
- **Trusted publishing (OIDC)** after a one-time token bootstrap.
- **`npm version`**, with a **CHANGELOG drafted from git log**; the commit style stays as
  it is.
- **Pushing the tag is the approval.**
- **I run the first publish, after a gate.**

Your standing directions for this work:
- any new command-line surface follows the **cli skill** (grammar and contract);
- README, badges and docs are updated **in the same commit** as the behaviour they
  describe.

### What other projects do, and what we take from them
- **npm docs** ([trusted publishers](https://docs.npmjs.com/trusted-publishers),
  [`npm trust`](https://docs.npmjs.com/cli/v12/commands/npm-trust)):
  - OIDC needs npm ≥ 11.5.1 and Node ≥ 22.14 in the job, plus `id-token: write`.
  - `repository.url` must match the repo, and the workflow filename must match
    exactly.
  - With `workflow_call`, npm checks the *calling* workflow, so publish stays in
    `release.yml`.
  - Provenance is added automatically.
  - Trust can only be set once the package exists. `npm trust github` (npm ≥ 11.15,
    2FA) sets it from the CLI.
- **np:** its pre-publish checklist becomes our `check` command:
  - release branch, clean tree, not behind upstream;
  - tests pass, `engines` respected;
  - a prerelease never goes to `latest`;
  - no unexpected files in the tarball.
- **vite:**
  - publishes from CI through OIDC with no token (`npm i -g npm@^11.5.x`);
  - `--prerelease` GitHub Releases for versions that contain `-`;
  - a small in-repo TS release script instead of a framework.
- **release-please / semantic-release / changesets:** not used. They need Conventional
  Commits, a PR flow or a dependency, and release-please's PR won't run CI without a PAT.
  We keep the part that matters: an auto-drafted changelog.

## Accounts: what each one does, and what else is needed
Two accounts, kept separate on purpose. Nothing below links them, except the
`repository` URL that package.json already has.

| | GitHub `makubexD` | npm `makudev1719` |
|---|---|---|
| Owns | the repo, the commits, the tags, the Actions runs | the `repown` package |
| Used by | you, to push commits and `v*` tags | the token (0.1.0 only), then CI through OIDC |
| Linked by | the trusted-publisher rule on npm: *repo `makubexD/repown` + workflow `release.yml` may publish `repown`*. It's tied to the repo and workflow, not to either account's login or email. | |

**Is the token enough?** For the first publish, yes, with one condition. If the account
requires 2FA for publishing and the token wasn't created with "bypass 2FA", npm answers
`EOTP`, and I'd stop and ask you for a one-time code.

**What's needed from GitHub?** No token, PAT or secret.
- `release.yml` declares its own permissions: `id-token: write` for OIDC and
  `contents: write` so the built-in `GITHUB_TOKEN` can create the GitHub Release.
- Actions is already on, since CI runs.
- The only GitHub action on your side is `git push --follow-tags` as `makubexD`.

**Later, for `npm trust`:**
- npm requires 2FA to be on for `makudev1719`. If it's off, turn it on first, or set the
  trusted publisher on the npmjs.com package settings page instead.
- That step replaces the token for good, and then the token gets deleted.

**What becomes public:**
- The npm registry lists each maintainer's name *and email* in the package metadata, so
  `npm view repown maintainers` shows the `makudev1719` address. That's standard npm
  behaviour, and a reason your separate npm email is a good idea.
- Provenance shows the repo, the workflow and the commit, not any email.
- The repo itself never gains an email: no `author` email in package.json, commits keep
  the noreply address, per ADR-008 and CLAUDE.md.

## The release tool: `scripts/release.ts` (dev only, never shipped)
It's designed by the cli skill (grammar and contract) as a small noun-verb language.
- **Declarations:** it reuses repown's own `Command`/`CommandGroup` (`src/ui/command.ts`),
  parser (`src/ui/args.ts`) and help renderer (`src/ui/help.ts`). Help is generated from
  the same declarations, so it can't drift.
- **Refactor:** if `help.ts` hardcodes the program name `repown`, it gains a program-name
  parameter. That's a pure refactor; the existing help tests prove nothing changed.

```
node scripts/release.ts changelog draft [--dry-run]    fill "## [Unreleased]" from `git log <last tag>..HEAD`
                                                        subjects (skips "Plan:" and version commits, and lines
                                                        already there); --dry-run prints the result on stdout
node scripts/release.ts changelog release <version>     Unreleased -> "## [x.y.z] - YYYY-MM-DD" + compare link;
                                                        error (exit 1) if Unreleased is empty
node scripts/release.ts changelog notes <version>       print that version's section on stdout (pipes into
                                                        `gh release create --notes-file -`)
node scripts/release.ts check                           np-style preflight: ✓/✗/skipped per check on stderr
node scripts/release.ts package check [-]               read `npm pack --dry-run --json` from stdin; fail on
                                                        missing dist/cli.js|README|LICENSE or any .map/src/test/scripts
```

Contract:
- stdout carries only the payload (drafts, notes); ✓/✗ and errors go to stderr as
  `error: …`.
- Exit codes: `0` ok, `1` failed check or refusal, `2` usage error.
- `--help` at every level, with no side effects. Unknown options are refused.
- A skipped check (for example, no upstream) never shows as passed; it's a `Result`.
- It spawns only through `run()` in `src/core/exec.ts`, with `shell: false`, and every
  `git log` passes `--no-show-signature`.
- It never spawns npm (`npm.cmd` can't run with `shell: false`). npm's output is piped
  in instead.

**npm scripts** are what you actually type:

| Script | Runs |
|---|---|
| `npm run changelog` | `release.ts changelog draft` |
| `npm run release:check` | `release.ts check` |
| `npm run pack:check` | `npm pack --dry-run --json \| node scripts/release.ts package check -` |
| `npm run release:patch` \| `:minor` \| `:major` \| `:beta` | `npm version <bump>` (`:beta` = `prerelease --preid=beta`) |
| `preversion` (automatic) | `release:check`, then `npm test`, `npm run build`, `pack:check` |
| `version` (automatic) | `release.ts changelog release $npm_package_version`, then `git add CHANGELOG.md` |
| `postversion` (automatic) | prints `next: git push --follow-tags` on stderr |
| `prepublishOnly` (automatic) | `npm test` |

## The release routine (end state)
```
npm run changelog          -> trim the draft in CHANGELOG.md
npm run release:minor      -> checks, tests, build, pack check, CHANGELOG dated, commit "x.y.z", tag vx.y.z (local)
git push --follow-tags     -> you; this publishes
  release.yml (v* tags): uses ci.yml (full matrix + Node 20 install) -> publish job:
    tag == package.json version · skip if already on npm (safe re-runs)
    npm i -g npm@^11.5.1 · npm ci · npm publish [--tag next when the version has "-"]  (OIDC + provenance)
    node scripts/release.ts changelog notes X | gh release create vX --notes-file - [--prerelease]
```
Rollback: `npm deprecate repown@x.y.z "<why>"`, then release a fix. Never unpublish.

## README and badges
- **Badges, after publish:**
  - npm version: `shields.io/npm/v/repown`, linking to npmjs.com/package/repown;
  - Release workflow status, next to the CI badge;
  - node: the static `node >=20` becomes `shields.io/npm/node/v/repown`, read from
    `engines`, so it can't drift;
  - license: MIT stays;
  - the static "pre-1.0" status badge is dropped, because the version badge (0.x) says it.
- **Text:**
  - Status line: "pre-1.0: the commands may still change."
  - **Install:** `npm install -g repown` (and `npx repown doctor` to try it). The
    from-source steps move to Development.
  - Development gains the release routine in three lines and links to
    `docs/RELEASING.md` and `CHANGELOG.md`.
  - Uninstall: check `docs/HOW-IT-WORKS.md:439`.
- The npm-dependent badges and install text land with the publish task, because docs
  describe what's true now.

## Tasks (TDD: each test is shown failing first. One commit each, with its docs)
1. **Tool skeleton + `changelog` group.**
   - `scripts/release.ts` and the `help.ts` program-name parameter, if needed.
   - Seed `CHANGELOG.md` (Keep a Changelog; Unreleased summarises 0.1.0).
   - `tsconfig.test.json` adds `scripts/**/*.ts`.
   - Tests: `test/release-tool.test.ts` covers the pure functions, draft against
     `sandbox()` repos, stdout/stderr/exit-code contract, and `--help`.
   - Docs: CHANGELOG.
2. **`check` and `package check`.**
   - Tests: sandbox repos for a dirty tree, the wrong branch, behind upstream, and no
     upstream (skipped, not passed); pack JSON fixtures with good and bad file lists.
   - Docs: none yet (task 4 documents the routine).
3. **`package.json`.**
   - Remove the npm flag `"private": true`, which is what blocks `npm publish` (the GitHub
     repo is already public), and add `publishConfig.access: public`.
   - Add the npm scripts above; keep `prepare`.
   - Test: the real `npm pack --dry-run --json` passes `package check`.
   - Verify on a throwaway branch: `npm run release:beta` yields the right commit, tag and
     CHANGELOG. Then reset it.
   - Docs: README Development, the local part of the routine.
4. ⚠ **CI + `release.yml` + docs.**
   - `ci.yml`: add `workflow_call`, and use `pack:check` in place of its inline grep.
   - `release.yml`: `contents: write, id-token: write` on the publish job only, and no
     secrets.
   - Docs:
     - **ADR-015** "Releases: tag-driven, published from CI by trusted publishing"
       (alternatives: token secret, release-please, semantic-release, changesets, np)
       and its ADR index row;
     - `docs/RELEASING.md`: the routine, prereleases/`next`, rollback, one-time setup,
       the tool's command reference;
     - one CLAUDE.md line: "Releasing: docs/RELEASING.md; bump versions only through
       `npm run release:*`, never by editing package.json".
5. ⚠ **First publish of 0.1.0 (irreversible).**
   - `release:check` + `pack:check`, then `npm publish --dry-run` shows you the file list
     and size. **Gate: I wait for your explicit go.**
   - Then `npm publish` with a throwaway `.npmrc` in the scratchpad through
     `NPM_CONFIG_USERCONFIG`. The token is never written into the repo.
   - If npm asks for an OTP (EOTP), I stop and ask you.
   - Verify:
     - `npm view repown`;
     - a registry install into a temp prefix, then `repown --version` and `--help`;
     - the README renders on npmjs.com, with working links and badges.
   - Commit the 0.1.0 CHANGELOG heading, the README badges and the Install text, then tag
     `v0.1.0`. When you push it, release.yml sees 0.1.0 is already on npm, skips the
     publish and creates the GitHub Release.
6. **One-time account setup, run by you** (it needs 2FA; the commands are in
   RELEASING.md):
   - `! npx npm@latest trust github repown --repo makubexD/repown --file release.yml --allow-publish`;
   - npm package Settings → Publishing access → "Require 2FA and disallow tokens";
   - delete the dev token;
   - optional: a GitHub tag ruleset so only you create `v*` tags.

Then Phase 5 runs parallel review:
- the code reviewer;
- a docs-drift check;
- a security audit, because of the ⚠ tasks;
- a `cli-auditor` pass on `scripts/release.ts`, as the cli skill's build step asks.

Phase 6 closes out: SPEC and tasks/ are deleted once their facts have homes. I'll also
save your standing directions (cli skill for any CLI surface, docs and badges updated with
each change, research best practices before planning) to memory.

On approval (this counts as GATES 1–3), I write `SPEC-npm-publish.md` and `tasks/todo.md`
and commit them as "Plan: npm publishing". Phase 4 runs in auto mode.

## Files
- **New:**
  - `scripts/release.ts`
  - `CHANGELOG.md`
  - `.github/workflows/release.yml`
  - `docs/RELEASING.md`
  - `docs/decisions/ADR-015-*.md`
  - `test/release-tool.test.ts` (plus pack fixtures if needed)
- **Edited:**
  - `package.json`, `tsconfig.test.json`
  - `.github/workflows/ci.yml`
  - `README.md`, `docs/decisions/README.md`, `CLAUDE.md`
  - maybe `src/ui/help.ts`
- **Reused:**
  - `run`/`lines`/`output` from `src/core/exec.ts`;
  - `Result` from `src/core/result.ts`;
  - `src/ui/{command,args,help,format}.ts`;
  - `sandbox()` from `test/helpers.ts`;
  - `version()` in `src/cli.ts`, which already follows package.json.

## Rules kept
- No runtime or dev dependencies are added.
- Strip-only TS, functions of 20 lines or fewer, at most 4 params.
- Only `exec.ts` spawns.
- No email address or token anywhere in the repo.
- I never push.

## Risks
- The account may demand an OTP despite the token. If so, I stop and ask.
- Node 24's bundled npm may be older than 11.5.1, so the job upgrades npm.
- `help.ts` may be more repown-specific than it looks. If reusing it needs more than a
  program-name parameter, I stop and ask before diverging.

## Verification
- `npm test` and `npm run build` are green, and each new test was shown failing first.
- `node scripts/release.ts --help` and each group's help render.
- The throwaway-branch `release:beta` run proves the hooks end to end.
- `pack:check` passes on the real tarball.
- After publishing: `npm view repown version` is `0.1.0`, a global registry install prints
  `repown 0.1.0`, and the badges resolve.
- After you push the tag, Release is green (publish skipped) and the GitHub Release has
  the CHANGELOG notes.
- After trust is configured, the next bump publishes from CI with provenance.
