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
npm install -g repown
repown doctor          # once per machine: is Git Credential Manager ready for sign-ins?
cd ~/code/my-repo
repown setup           # once per clone: asks which account owns it, shows each step, runs it
```

> **Status:** pre-1.0: the commands may still change. What changed in each version is in
> [CHANGELOG.md](CHANGELOG.md).

**Contents:** [Why repown](#why-repown) · [Install](#install) ·
[Quick start](#quick-start) · [Day to day](#day-to-day) ·
[Troubleshooting](#troubleshooting) · [Set up by hand](#set-up-by-hand) ·
[Commands](#commands) · [Uninstall](#uninstall) · [More docs](#more-docs)

## Why repown

**The problem:**

- **Every clone inherits the identity in your global git config.** A commit's author
  address becomes permanent once it's pushed to a public repository.
- **`gh auth switch` changes the account for the whole machine.** While `gh` (the GitHub
  CLI) is git's *credential helper* (the program git asks for a password or token), every
  switch breaks the *other* account's repositories. An account that signs in through its
  organisation (SSO) has no password to type at the prompt
  ([ADR-001](docs/decisions/ADR-001-credential-manager-not-gh.md)).

**What repown does:**

- **Pins each clone.** It writes the commit identity and the push account into that
  clone's own `.git/config`. That's what *pinned* means here: set once, never switched.
- **Lets one credential serve each account.** [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager)
  (GCM) already stores one sign-in per account and picks the one each clone names.
  repown checks GCM is in charge, and hands the job back to it if gh took it over. `gh`
  stays your account store for `gh pr create` and `gh api`.
- **Guards every push.** A git `pre-push` hook (a script git runs before every push), the
  *guard*, checks the commits being pushed, not just today's config.

Commit identity and the guard work on every host. The sign-in is pinned on GitHub over
https only; on SSH, your key decides which account pushes
([ADR-009](docs/decisions/ADR-009-hosts-claim-only-measured.md)). Every scenario, with
diagrams: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Install

**You need:**

- **Node 20+** and **git**, on Windows, macOS or Linux.
- **Git Credential Manager** for per-account sign-in on GitHub. Git for Windows includes
  it; on macOS and Linux, follow
  [GCM's install guide](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/install.md).
- **gh** is optional: repown reads it when it's there.

**Install it globally** (the guard needs an installed repown to call):

```
npm install -g repown
```

**Update** with `npm install -g repown@latest`; guarded clones keep working
([ADR-003](docs/decisions/ADR-003-hook-calls-installed-cli.md)).

<details><summary>Try it first without installing, and what gets installed</summary>

These only read:

```
npx repown doctor      # what serves credentials on this machine
npx repown             # the state of the clone you're in
npx repown scan ~/code # every clone under a folder
```

Don't turn the guard on through `npx`: its hook would call a temporary copy
(`guard on` warns; [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing)).

repown has one optional dependency, for interactive prompts, pinned exactly
([ADR-016](docs/decisions/ADR-016-clack-for-the-setup-wizard.md)), and is published from
CI with provenance ([how](SECURITY.md#how-the-package-is-published)).
</details>

## Quick start

1. **Once per machine,** run `repown doctor`. It checks that Git Credential Manager will
   handle sign-ins. If it says otherwise, see [Troubleshooting](#troubleshooting).
2. **Once per clone,** `cd` into it and run `repown setup`.
   - **The first time,** it asks for the account's user name (login), where it's hosted,
     and the name and email for your commits. On GitHub, use your *noreply* address,
     GitHub's private address for commits, shown at github.com/settings/emails.
   - **After that,** it lists the accounts it knows: pick one, or **a new account** for
     one it doesn't know yet.
   - **Then it asks only what applies here:** switching gh too, allowing the repository's
     owner, turning the guard on, taking git's sign-ins back from gh.
3. **Check the review, then choose Run.** It lists each step in plain words with its
   exact command. Nothing changes before you choose Run.
4. **Make your first push** ([below](#the-first-push)).

The review, just before anything changes:

```
◇  Review: nothing has changed yet ───────────────────────────────────────╮
│                                                                         │
│  This clone will commit and push as octocat.                            │
│                                                                         │
│  When you choose Run:                                                   │
│  1. Let this clone push to octo-org's repositories                      │
│       git config --local --add repown.allowOwner octo-org               │
│  2. Pin this clone to octocat: its commit name, email and push sign-in  │
│       repown use octocat                                                │
│  3. Turn on the push guard: each push is checked first                  │
│       repown guard on                                                   │
│                                                                         │
│  These are ordinary commands: run them yourself, or in a script.        │
│  This clone's settings go in its .git/config, which is never pushed.    │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────╯
│
◆  Run these 3 steps?
│  ● Run them
│  ○ Back
│  ○ Change an answer
│  ○ Decline
└
```

**Keys:** ↑/↓ choose, Enter confirms, **← Back** (last in each list) returns to the
previous question, and Esc or Ctrl-C stops with nothing changed. Run it again in a clone
that's already set up and it says so; choose **Done**. Every screen, and what each
answer runs: [card 13](docs/HOW-IT-WORKS.md#13-guided-setup).

### The first push

**The first push from each account signs in once.** GCM opens a browser: sign in as
*that* clone's account, not whichever you used last. After that, pushes from that clone
use it without asking. If a push is refused or asks for a password, see
[Troubleshooting](#troubleshooting).

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
credential, and gh's active account. Here git is right and only `gh` commands would act
as another account; `repown use octocat --gh` also switches gh when you pin.

**Audit every clone you have:** `repown scan ~/code ~/work` lists each clone's owner,
host, identity and guard. It also shows which email domains appear in its history, and
how often. It never changes anything.

## Troubleshooting

| What happened | What to do |
| --- | --- |
| `repown doctor` says gh is the helper | `repown fix`: it shows what it removes, and the undo, before changing anything ([card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine)) |
| `repown doctor` shows `GCM  not found` | install Git Credential Manager ([Install](#install)), then `repown doctor` again |
| `repown doctor` shows `helper  none configured` | `git-credential-manager configure`, then `repown doctor` again |
| A push asked for a password | [card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine), then [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| A push failed after signing in (SSO) | [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| The guard refused a push | most often a commit made before pinning: `git commit --amend --reset-author --no-edit`, then push again ([card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix)) |
| The guard said the push goes to another owner | if you're a member or collaborator there, allow it: `git config --local --add repown.allowOwner <owner>` ([card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix)) |
| A teammate doesn't use repown | nothing to do for them ([card 9](docs/HOW-IT-WORKS.md#9-a-teammate-without-repown)) |
| husky or another tool owns the pre-push hook | have that hook run `repown guard check` ([card 10](docs/HOW-IT-WORKS.md#10-other-hook-tools)) |
| "repown cannot be found" on push | [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing) |

## Set up by hand

The same commands `repown setup` runs, if you'd rather type them:

1. **Check the machine, once:** `repown doctor`
   ([card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine)).
2. **Record each account, once:**
   `repown accounts add octocat --name "Octo Cat" --email octocat@users.noreply.github.com`.
   You can skip this: on a terminal, the first `repown use` of an account asks, and on
   GitHub suggests the name and email from its public profile (through gh)
   ([card 2](docs/HOW-IT-WORKS.md#2-remember-an-account)).
3. **In each clone:** `repown use octocat`, then `repown guard on`
   ([card 3](docs/HOW-IT-WORKS.md#3-pin-a-clone)). If the repository belongs to another
   owner, such as an organisation, `use` prints the one line that lets the guard accept
   it.

```
$ cd ~/code/dotfiles
$ repown use octocat
OK    identity   Octo Cat <octocat@users.noreply.github.com>  push-as:octocat

  No stored credential for "octocat" yet -- the first push signs in
  once, then never again. Verify it afterwards: repown doctor

  Next: repown guard on    (check every push before it leaves)

$ repown guard on
OK    guard      on -- every push is checked before it leaves
  /home/you/code/dotfiles/.git/hooks/pre-push
```

`.git/config` and `.git/hooks` are never pushed, so teammates see nothing of this setup.
Every key repown writes: [docs/CONFIGURATION.md](docs/CONFIGURATION.md#what-repown-writes).

## Commands

| Command | What it does |
| --- | --- |
| `repown setup [<account>] [--guard] [--no-input]` | guided setup of this clone: asks, shows each step, then runs them (every answer has a flag: `--name`, `--email`, `--host`, `--gh`, `--allow-owner <owner>`, `--fix`; scripts: [docs/CONFIGURATION.md](docs/CONFIGURATION.md#scripts-and-ci)) |
| `repown status` (or just `repown`) | the state of this repository and this machine |
| `repown use <account> [--gh]` | pin this clone to an account (`--name` and `--email` together skip the registry, the file where repown remembers accounts, and don't record the account) |
| `repown off` | unpin this clone, leaving global config alone |
| `repown guard on \| off \| status` | install, remove or show the pre-push hook |
| `repown doctor` | what serves credentials on this machine, and to whom |
| `repown fix [--dry-run] [--yes]` | undo `gh auth setup-git` so per-clone pins work again |
| `repown accounts list \| add \| remove` | the accounts this machine knows (`add` takes `--name`, `--email`, `--host github\|azdo\|generic`) |
| `repown scan [dir...] [--emails] [--depth <n>] [--format json]` | audit every clone under the given directories (default: the current one) |

- **Help:** `repown --help` lists the commands. `repown help <command>` (or
  `repown <command> --help`) shows a command's options, and `repown help guard on` goes
  one level deeper. Asking for help never changes anything.
- **Every command:** `--cwd <dir>` works on all of them.
- **Version:** `repown --version` (or `-v`).
- **Exit codes:** `0` success, `1` failure or refusal, `2` usage error.
  - `scan` exits `0` whatever it finds; read its output, or its JSON, for the problems.
  - `setup` exits `0` when you choose Done, `1` when you Decline, `130` when cancelled
    or interrupted, and a failing command's own code if one fails.

## Uninstall

Turn the guard off **first**: a guard that can't find repown refuses every push.

```
repown scan <dir>        # the "guard" column shows where it's on
repown guard off         # in each of those clones
repown off               # optional: also drop the pinned identity
npm uninstall -g repown
```

Left behind, on purpose: the account registry ([where](docs/CONFIGURATION.md#the-account-registry)),
which you can delete, and the sign-ins in your OS credential store. If `repown fix` took
the helper role from gh and you want it back: `gh auth setup-git`. Details, and
submodules: [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing).

## More docs

| I want… | Read |
| --- | --- |
| every scenario, with diagrams | [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) |
| environment variables, where accounts are kept, per-clone keys, scripts and JSON | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| short answers, and how repown compares with `includeIf`, SSH aliases and `gh auth switch` | [docs/FAQ.md](docs/FAQ.md) |
| to contribute, run it from a clone, or try it on throwaway repositories | [CONTRIBUTING.md](CONTRIBUTING.md) |
| to report a vulnerability privately | [SECURITY.md](SECURITY.md) |
| why it works this way, one ADR per decision | [docs/decisions/](docs/decisions/README.md) |
| what changed in each version, and how a release is cut | [CHANGELOG.md](CHANGELOG.md), [docs/RELEASING.md](docs/RELEASING.md) |

## License

[MIT](LICENSE)
