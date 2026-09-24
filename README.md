# repown

[![CI](https://github.com/makubexD/repown/actions/workflows/ci.yml/badge.svg)](https://github.com/makubexD/repown/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange.svg)

**Use several git accounts on one machine, and move between their repositories
with no switch command.** Each repo owns its identity (that's the name: *repo
own*), so you can go from a work repo to a personal one to a client one, on
different hosts or sign-in methods, and every commit and push goes out as the
right account. A push carrying the wrong identity is refused before it leaves.

```
repown doctor          # once per machine: is git's credential helper ready?
repown use octocat     # once per clone: this clone is octocat's
repown guard on        # refuse any push that carries another identity
```

> **Status:** pre-1.0. The commands may still change, and it isn't on npm yet.

## The problem

- **Every clone inherits the identity in your global git config.** A commit's author
  address becomes permanent once it's pushed to a public repository.
- **`gh auth switch` changes the account for the whole machine.** While `gh` is git's
  credential helper, every switch breaks the *other* account's repositories. An
  SSO-only account has no password to type at the prompt
  ([ADR-001](docs/decisions/ADR-001-credential-manager-not-gh.md)).

## How repown solves it

- **Pin each clone:** `repown use <account>` writes the commit identity and the push
  account into that clone's `.git/config`. It is set once and never switched.
- **One credential per account:** Git Credential Manager already stores one
  credential per account and picks it per clone.
  - `repown doctor` checks that it is the helper.
  - `repown fix` hands the host back to it if `gh auth setup-git` took over.
  - `gh` stays your account store for `gh pr create` and `gh api`.

  Credential pinning is GitHub-over-https only today. Commit identity and the guard
  work on every host ([ADR-009](docs/decisions/ADR-009-hosts-claim-only-measured.md)).
- **Guard every push:** `repown guard on` installs a `pre-push` hook that checks the
  commits themselves, not just today's config.

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

Needs Node 20+ and git, on Windows, macOS or Linux. It is not on npm yet, so
install it from the repository:

```
git clone https://github.com/makubexD/repown.git
cd repown && npm install && npm run build && npm link
```

`npm link` puts `repown` on your PATH. To uninstall, run `repown guard off` in each
guarded clone **first**: a guard that can't find repown refuses every push
([the steps](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing)).

## Quickstart

**Once per machine:** `repown doctor`, then `repown fix` only if doctor says so. `fix`
shows what it removes, and the undo, before changing anything.

**Once per clone:**

```
$ repown use octocat
OK    identity   Octo Cat <octocat@users.noreply.github.com>  push-as:octocat

  No stored credential for "octocat" yet -- the first push signs in
  once, then never again. Verify it afterwards: repown doctor

  Next: repown guard on    (check every push before it leaves)

$ repown guard on
OK    guard      on -- every push is checked before it leaves
  /path/to/clone/.git/hooks/pre-push
```

The first time, `repown use` asks for the account's commit name and email and records
them for every other clone. Without a terminal it can't ask, so record the account
first: `repown accounts add octocat --name "Octo Cat" --email octocat@users.noreply.github.com`.

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
you out.

**Audit every clone you have:** `repown scan ~/code ~/work` lists each clone's owner,
host, identity and guard. It also shows which email domains appear in its history, and
how often. It never changes anything.

**Something went wrong?**

| What happened | Where to look |
| --- | --- |
| A push asked for a password | [card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine), then [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| A push failed after signing in (SSO) | [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| The guard refused a push | [card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| A teammate doesn't use repown | [card 9](docs/HOW-IT-WORKS.md#9-a-teammate-without-repown) |
| husky or another hook tool | [card 10](docs/HOW-IT-WORKS.md#10-other-hook-tools) |

## Commands

| Command | What it does |
| --- | --- |
| `repown status` (or just `repown`) | the state of this repository and this machine |
| `repown use <account> [--gh]` | pin this clone to an account (`--name` and `--email` together skip the registry) |
| `repown off` | unpin this clone, leaving global config alone |
| `repown doctor` | what serves credentials on this machine, and to whom |
| `repown fix [--dry-run] [--yes]` | undo `gh auth setup-git` so per-clone pins work again |
| `repown guard on \| off \| status` | install, remove or show the pre-push hook |
| `repown accounts list \| add \| rm` | the accounts this machine knows (`add` takes `--name`, `--email`, `--host github\|azdo\|generic`) |
| `repown scan [dir...] [--emails] [--depth <n>]` | audit every clone under the given directories (default: the current one) |

- **Help:** `repown --help` lists the commands. `repown help <command>` (or
  `repown <command> --help`) shows a command's options, and `repown help guard on` goes
  one level deeper. Asking for help never changes anything.
- **Every command:** `--cwd <dir>` works on all of them.
- **Version:** `repown --version`.
- **Exit codes:** `0` success, `1` failure or refusal, `2` usage error.

## Development

```
npm install
npm test          # node's own test runner, no framework
npm run build     # tsc, also the typecheck
```

- **Node:** developing needs Node 22.18+, though running needs only 20
  ([ADR-010](docs/decisions/ADR-010-typescript-on-node.md)).
- **Dependencies:** zero at runtime, by choice.
- **Demo:** `demo/demo.tape` is a [VHS](https://github.com/charmbracelet/vhs) script
  using placeholder identities. No GIF is committed yet.
- **Further reading:**
  - [CLAUDE.md](CLAUDE.md) has the contributor rules.
  - [docs/decisions/](docs/decisions/README.md) explains every non-obvious choice.

## License

[MIT](LICENSE)
