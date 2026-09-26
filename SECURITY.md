# Security

## Reporting a vulnerability

Please report it privately through GitHub:
[Report a vulnerability](https://github.com/makubexD/repown/security/advisories/new).
Don't open a public issue. Include the repown version (`repown --version`), your OS, and
the steps to reproduce. Replace real names, email addresses and tokens with placeholders.

Fixes go into the latest release only; there are no backports
([ADR-015](docs/decisions/ADR-015-releases-from-tags.md)).

## What repown protects, and what it doesn't

repown stops a push that would publish the wrong identity. What it refuses and what it
only reports follows one rule: refuse what can't be undone once pushed, report the rest
([ADR-011](docs/decisions/ADR-011-refuse-vs-warn.md)). Each check, in order:
[card 7](docs/HOW-IT-WORKS.md#7-push-what-the-guard-checks).

| The `pre-push` guard refuses | `repown` and `repown doctor` report |
| --- | --- |
| a commit authored or committed by another address, or a tag by another tagger | the credential helper (gh as the helper is a failure), and which account it would use |
| a push to an owner that isn't the pinned account or a `repown.allowOwner`, when the URL names an owner and the clone records an account | gh's active account, when it differs or can't be queried |
| a clone with no commit email of its own, or commits or tags it can't read | a guard that is off, or a hook another tool owns |
| `GH_TOKEN`, `GITHUB_TOKEN` or `GIT_*_EMAIL` set in the environment | submodules, which need their own pin and guard; an origin whose owner this clone doesn't push to |

**Known limits.** A hook is advisory: `git push --no-verify` skips it, and so does any
tool that pushes through libgit2 instead of the `git` binary. The full list, with the
reason for each, is under
[Residual risks](docs/decisions/README.md#residual-risks).

## How the package is published

Every version from 0.1.1 on is built and published by GitHub Actions through npm trusted
publishing: no npm token exists in CI, and npm shows the commit and workflow that built
each version (provenance). Its one runtime dependency, `@clack/prompts`, is optional,
pinned exactly with its whole tree locked by `npm-shrinkwrap.json`, and loaded only by the
interactive wizard, never by the hook
([ADR-016](docs/decisions/ADR-016-clack-for-the-setup-wizard.md)). Details:
[docs/RELEASING.md](docs/RELEASING.md) and
[ADR-015](docs/decisions/ADR-015-releases-from-tags.md).
