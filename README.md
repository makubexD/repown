# repown

[![npm](https://img.shields.io/npm/v/repown.svg)](https://www.npmjs.com/package/repown)
[![CI](https://github.com/makubexD/repown/actions/workflows/ci.yml/badge.svg)](https://github.com/makubexD/repown/actions/workflows/ci.yml)
[![Release](https://github.com/makubexD/repown/actions/workflows/release.yml/badge.svg)](https://github.com/makubexD/repown/actions/workflows/release.yml)
[![Node](https://img.shields.io/node/v/repown.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Stop committing and pushing as the wrong account when one machine has two or more.**
Each repository owns its identity (that's the name: *repo own*), so you move from a work
repo to a personal one to a client one, on any host or sign-in method, with no switch
command. A push carrying the wrong identity is refused before it leaves.

```
repown doctor          # once per machine: is git's credential helper ready?
repown use octocat     # once per clone: this clone is octocat's
repown guard on        # refuse any push that carries another identity
```

> **Status:** pre-1.0: the commands may still change. What changed in each version is in
> [CHANGELOG.md](CHANGELOG.md).

**Contents:** [Problem](#the-problem) · [How it works](#how-repown-solves-it) ·
[Alternatives](#compared-with-the-alternatives) · [Install](#install) ·
[Quickstart](#quickstart) · [Day to day](#day-to-day) · [Commands](#commands) ·
[Configuration](#configuration) · [Uninstall](#uninstall) · [FAQ](#faq) ·
[Contributing](#contributing-and-security)

## The problem

- **Every clone inherits the identity in your global git config.** A commit's author
  address becomes permanent once it's pushed to a public repository.
- **`gh auth switch` changes the account for the whole machine.** While `gh` is git's
  credential helper, every switch breaks the *other* account's repositories. An
  SSO-only account has no password to type at the prompt
  ([ADR-001](docs/decisions/ADR-001-credential-manager-not-gh.md)).

## How repown solves it

- **Pin each clone:** `repown use <account>` writes the commit identity and the push
  account into that clone's own `.git/config`. That's what *pinned* means here: set once,
  never switched.
- **One credential per account:** [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager)
  (GCM), git's *credential helper*, already stores one sign-in per account and picks the
  one each clone names.
  - `repown doctor` checks that GCM is the helper.
  - `repown fix` removes the entries `gh auth setup-git` added, so the helper under
    them (GCM) serves again.
  - `gh` stays your account store for `gh pr create` and `gh api`.

  Credential pinning is GitHub-over-https only today. Commit identity and the guard
  work on every host; on SSH, your key decides which account pushes
  ([ADR-009](docs/decisions/ADR-009-hosts-claim-only-measured.md)).
- **Guard every push:** `repown guard on` installs a git `pre-push` hook, the *guard*.
  It checks the commits being pushed, not just today's config.

**Every scenario, with diagrams: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).**

## Compared with the alternatives

| Approach | Right commit identity | Right push credential | Checked before push | Catch |
| --- | --- | --- | --- | --- |
| `git config user.email` by hand in each repo | yes, if you never forget | no | no | Forgetting once publishes the wrong address permanently |
| `includeIf "gitdir:~/work/"` in global config | yes, by folder | only if you also add the credential key per folder | no | Depends on where a repo happens to be cloned; a clone anywhere else inherits the default |
| SSH host aliases (`git@github-work:...`) | no | yes | no | Every remote URL has to be rewritten, and keys managed per account |
| `gh auth switch` | no | while gh is the helper, only the *active* account | no | Machine-wide: it breaks the other account's repos |
| **repown** | yes, per clone | yes, per clone (GitHub) | yes, once `repown guard on`: every commit the push would publish | `use` and `guard on` once per clone |

repown doesn't replace these tools. It writes plain repo-local git config, uses the
credential manager you already have, and leaves `gh` in charge of the GitHub CLI.

## Install

**You need:**

- **Node 20+** and **git**, on Windows, macOS or Linux. CI runs Node 22 and 24 on Linux
  and Windows, Node 24 on macOS, and installs the package on Node 20 (Linux).
- **Git Credential Manager** for per-account sign-in on GitHub. Git for Windows includes
  it; on macOS and Linux, follow
  [GCM's install guide](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/install.md).
- **gh** is optional: repown reads it when it's there.

**Try it first, without installing.** These only read:

```
npx repown doctor      # what serves credentials on this machine
npx repown             # the state of the clone you're in
npx repown scan ~/code # every clone under a folder
```

**Install before you pin or guard:**

```
npm install -g repown
```

The guard's hook calls the repown that turned it on. Through `npx`, that is a copy in
npm's cache: `guard on` warns about it, and the hook refuses every push once that folder
is deleted ([card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing)).

**Update** with `npm install -g repown@latest`. A guarded clone keeps working, because
its hook calls the installed CLI ([ADR-003](docs/decisions/ADR-003-hook-calls-installed-cli.md)).
The package has no runtime dependencies. From 0.1.1 on, each version is published from CI
with [provenance](https://docs.npmjs.com/generating-provenance-statements): npm shows the
commit and workflow that built it.

## Quickstart

### 1. Check the machine, once

```
$ repown doctor

  helper             manager
  stored accounts    octocat, octo-work
  gh accounts        octocat, octo-work
  gh active          octo-work
  GCM                git-credential-manager

  Credentials come from Git Credential Manager, which stores one per
  account and picks per repository from credential.<url>.username. No
  switching is needed for git, and `gh auth switch` affects the CLI only.

  If a push or fetch still fails right after this, the credential may
  be valid but not yet SSO-authorized for that organisation. Re-authorize it:
  gh auth refresh -h <host>, or via the org's SSO settings.
```

If it says gh is the helper instead, run `repown fix`: it shows what it removes, and the
undo, before changing anything. If `GCM` says `not found`, install it first (above).

### 2. Record your accounts, once

```
$ repown accounts add octocat --name "Octo Cat" --email octocat@users.noreply.github.com
OK    accounts   octocat  Octo Cat <octocat@users.noreply.github.com>

  Use it in any clone:  repown use octocat
```

Repeat for each account (`octo-work` below). Or skip this: on a terminal, the first
`repown use` of an account asks for its name and email, and on GitHub suggests them from
the account's public profile (through gh).

### 3. Pin and guard each clone, once

```
$ cd ~/code/dotfiles           # a personal repository
$ repown use octocat
OK    identity   Octo Cat <octocat@users.noreply.github.com>  push-as:octocat

  No stored credential for "octocat" yet -- the first push signs in
  once, then never again. Verify it afterwards: repown doctor

  Next: repown guard on    (check every push before it leaves)

$ repown guard on
OK    guard      on -- every push is checked before it leaves
  /home/you/code/dotfiles/.git/hooks/pre-push
```

Then the same in a work clone, with `repown use octo-work`. If that repository belongs to
an organisation (`octo-org`), `use` says so and prints the one line that lets the guard
accept it: `git config --local --add repown.allowOwner octo-org`.

**The first push from each account signs in once.** GCM opens a browser: sign in as
*that* clone's account, not whichever you used last.

It writes these repo-local keys and nothing else:

| Key | What it decides |
| --- | --- |
| `user.name`, `user.email` | who **authored** the commit |
| `repown.account` | whose clone this is; the guard checks the destination against it |
| `credential.<host>.username` | which stored credential serves the **push** (GitHub over https only) |
| `user.useConfigOnly` | git refuses to invent an identity from the hostname |

`.git/config` and `.git/hooks` are never pushed. No name or address reaches the
repository, and teammates see nothing.

## Day to day

**Moving between accounts needs no command.** `cd` into any pinned clone, then commit
and push. To see who a clone is, run `repown`:

```
$ repown

  commits as     Octo Cat <octocat@users.noreply.github.com>
  pushes as      octocat
  origin         octocat  (GitHub)
  helper         manager
  gh active      octo-work
  push guard     on

WARN  gh         active as "octo-work", so `gh pr create` here would act as that account.
       fix: gh auth switch -u octocat
OK    identity   this clone is pinned, and its credential mechanism honours it
```

It prints all three things that decide who you are: the commit identity, the push
credential, and gh's active account. The one you can't see is the one that catches
you out. Here git is right, and only `gh` commands would act as another account:
`repown use octocat --gh` also switches gh when you pin.

**Audit every clone you have:** `repown scan ~/code ~/work` lists each clone's owner,
host, identity and guard. It also shows which email domains appear in its history, and
how often. It never changes anything.

**Something went wrong?**

| What happened | Where to look |
| --- | --- |
| A push asked for a password | [card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine), then [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| A push failed after signing in (SSO) | [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| The guard refused a push | [card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| The guard said the push goes to another owner (an organisation) | [card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix): `repown.allowOwner` |
| A teammate doesn't use repown | [card 9](docs/HOW-IT-WORKS.md#9-a-teammate-without-repown) |
| husky or another hook tool | [card 10](docs/HOW-IT-WORKS.md#10-other-hook-tools): have its pre-push hook run `repown guard check` |
| "repown cannot be found" on push | [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing) |

## Commands

| Command | What it does |
| --- | --- |
| `repown status` (or just `repown`) | the state of this repository and this machine |
| `repown use <account> [--gh]` | pin this clone to an account (`--name` and `--email` together skip the registry, and don't record the account) |
| `repown off` | unpin this clone, leaving global config alone |
| `repown doctor` | what serves credentials on this machine, and to whom |
| `repown fix [--dry-run] [--yes]` | undo `gh auth setup-git` so per-clone pins work again |
| `repown guard on \| off \| status` | install, remove or show the pre-push hook |
| `repown accounts list \| add \| remove` | the accounts this machine knows (`add` takes `--name`, `--email`, `--host github\|azdo\|generic`) |
| `repown scan [dir...] [--emails] [--depth <n>] [--format json]` | audit every clone under the given directories (default: the current one) |

- **Help:** `repown --help` lists the commands. `repown help <command>` (or
  `repown <command> --help`) shows a command's options, and `repown help guard on` goes
  one level deeper. Asking for help never changes anything.
- **Every command:** `--cwd <dir>` works on all of them.
- **Version:** `repown --version` (or `-v`).
- **Exit codes:** `0` success, `1` failure or refusal, `2` usage error. `scan` exits `0`
  whatever it finds; read its output, or its JSON, for the problems.

## Configuration

**Environment variables:**

| Variable | Effect |
| --- | --- |
| `REPOWN_CONFIG_DIR` | where the account registry lives |
| `NO_COLOR` | no colour when set to a non-empty value |
| `FORCE_COLOR` | colour even when not a terminal; `0` or `false` turns it off (wins over `NO_COLOR`) |
| `TERM=dumb` | no colour (`FORCE_COLOR` still wins) |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` | not settings: the guard **refuses** a push while any is set, because they override the pinned identity or credential ([card 7](docs/HOW-IT-WORKS.md#7-push-what-the-guard-checks)) |

**The account registry** is one file, `accounts.json`, holding each account's name,
email and host (no credentials). `repown accounts list` prints its path:

| OS | Folder |
| --- | --- |
| Windows | `%APPDATA%\repown` |
| macOS, Linux | `$XDG_CONFIG_HOME/repown`, else `~/.config/repown` |

**Per clone, opt-in:** three repo-local keys widen what the guard accepts. Global config
doesn't count. `repown`, `repown use` and the guard's refusals print the exact
`git config` line where one applies.

| Key | Allows | Card |
| --- | --- | --- |
| `repown.allowOwner` | pushing to an organisation's repositories | [8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| `repown.allowTagger` | pushing another tagger's annotated tags (a fork pushing upstream's tags) | [8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| `repown.mirrorBranch` | a fork's branch that only fast-forwards to upstream: commits already on a remote stop counting there | [8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) |

**Scripts:** `repown scan --format json` and `repown accounts list --format json` print
one JSON document on stdout. Those fields are stable; the text layout isn't
([ADR-014](docs/decisions/ADR-014-json-for-scripts.md)):

```
$ repown accounts list --format json
[
  {
    "account": "octocat",
    "name": "Octo Cat",
    "email": "octocat@users.noreply.github.com",
    "host": "github"
  }
]
```

Without a terminal nothing prompts: record accounts with `repown accounts add --name
--email`, and confirm `repown fix` with `--yes`.

## Uninstall

Turn the guard off **first**: a guard that can't find repown refuses every push.

```
repown scan <dir>        # the "guard" column shows where it's on
repown guard off         # in each of those clones
repown off               # optional: also drop the pinned identity
npm uninstall -g repown
```

Details, and submodules: [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing).

## FAQ

**Does it change anything outside the clone?** Its own account registry, and two things
only on request: `repown fix` removes what `gh auth setup-git` added to git config, after
showing it, and `repown use --gh` switches gh's active account. Everything else is
repo-local.

**Azure DevOps, GitLab, SSH?** Commit identity and the guard work on any host. The
credential pin is measured only for GitHub over https, so elsewhere repown says the
credential isn't pinned rather than guessing
([card 3](docs/HOW-IT-WORKS.md#3-pin-a-clone)).

**My teammates don't use it.** Nothing changes for them: repown writes nothing that gets
committed ([card 9](docs/HOW-IT-WORKS.md#9-a-teammate-without-repown)).

**Can I skip the guard for one push?** `git push --no-verify`. That is also why the guard
is a safety net, not a lock
([SECURITY.md](SECURITY.md#what-repown-protects-and-what-it-doesnt)).

**What does it send over the network?** Nothing of its own, and no telemetry. It runs
`git` and `gh`: gh may contact GitHub when repown asks for its accounts, and the first
`repown use` of an account on a terminal asks gh for the public profile to suggest a
name and noreply address.

## Contributing and security

- **Run it from a clone, or try it on throwaway repositories:**
  [CONTRIBUTING.md](CONTRIBUTING.md).
- **Report a vulnerability privately:** [SECURITY.md](SECURITY.md).
- **Why it works this way:** [docs/decisions/](docs/decisions/README.md), one ADR per
  decision. Releases: [docs/RELEASING.md](docs/RELEASING.md).

## License

[MIT](LICENSE)
