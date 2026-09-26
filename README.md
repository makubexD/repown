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

Or by hand, instead of `setup`: `repown use <account>` and `repown guard on` in each clone.

> **Status:** pre-1.0: the commands may still change. What changed in each version is in
> [CHANGELOG.md](CHANGELOG.md).

**Contents:** [Problem](#the-problem) · [How it works](#how-repown-solves-it) ·
[Install](#install) · [Quickstart](#quickstart) · [Day to day](#day-to-day) ·
[Commands](#commands) · [Uninstall](#uninstall) · [More docs](#more-docs) ·
[Configuration](docs/CONFIGURATION.md) · [FAQ](docs/FAQ.md)

## The problem

- **Every clone inherits the identity in your global git config.** A commit's author
  address becomes permanent once it's pushed to a public repository.
- **`gh auth switch` changes the account for the whole machine.** While `gh` (the GitHub
  CLI) is git's *credential helper* (the program git asks for a password or token), every
  switch breaks the *other* account's repositories. An account that signs in through its
  organisation (SSO) has no password to type at the prompt
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
- **Guard every push:** `repown guard on` installs a git `pre-push` hook (a script git runs
  before every push), the *guard*.
  It checks the commits being pushed, not just today's config.

**Every scenario, with diagrams: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).** How it compares
with `includeIf`, SSH aliases and `gh auth switch`: [docs/FAQ.md](docs/FAQ.md#compared-with-the-alternatives).

## Install

**You need:**

- **Node 20+** and **git**, on Windows, macOS or Linux.
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

The guard's hook calls the repown that turned it on, and through `npx` that is a
temporary copy (`guard on` warns; [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing)).

**Update** with `npm install -g repown@latest`. A guarded clone keeps working, because
its hook calls the installed CLI ([ADR-003](docs/decisions/ADR-003-hook-calls-installed-cli.md)).
One optional dependency, for interactive prompts, pinned exactly
([ADR-016](docs/decisions/ADR-016-clack-for-the-setup-wizard.md)), and published from CI
with provenance ([how](SECURITY.md#how-the-package-is-published)).

## Quickstart

### A. Guided

**Once per machine,** run `repown doctor`: it checks that Git Credential Manager will
handle sign-ins ([what to do if it says otherwise](#1-check-the-machine-once)).

**Once per clone,** run `repown setup` in it. The first time, it asks for the account's
login, where it's hosted, and the name and email for your commits (on GitHub, use your
*noreply* address: GitHub's private address for commits, under Settings → Emails). After
that it lists the accounts it knows; in a clone of your other account, pick **a new
account**. Then it asks only what applies here: switching gh too, allowing an
organisation, turning the guard on, handing git's sign-ins back from gh. It shows each
step in plain words with its exact command, and runs them only when you choose Run.
Nothing changes before that ([card 13](docs/HOW-IT-WORKS.md#13-guided-setup)). Then
make [your first push](#the-first-push).

<details><summary>What it looks like</summary>

```
┌  repown setup
│
◇  Reading this clone and this machine
│
●  not pinned by repown yet
│
◇  Which account should this clone belong to?
│  its commits carry that account's name and email; on GitHub, its
│  pushes sign in as it
│  octocat
│
◇  This repository belongs to "octo-org". Allow pushes to it?
│  for an organisation you're in: without it the guard refuses these
│  pushes; stored in this clone only
│  Yes
│
●  only your email address is in this repository's commits
│
◇  Turn on the push guard?
│  before each push it checks every commit is yours and goes to the
│  right owner; undo: repown guard off
│  Yes
│
◇  Review: nothing has changed yet ─────────────────────────────────────╮
│                                                                       │
│  This clone will commit and push as octocat.                          │
│                                                                       │
│  When you choose Run:                                                 │
│  1. Let this clone push to octo-org's repositories                    │
│       git config --local --add repown.allowOwner octo-org             │
│  2. Pin this clone to octocat: name, email and push account           │
│       repown use octocat                                              │
│  3. Turn on the push guard: each push is checked first                │
│       repown guard on                                                 │
│                                                                       │
│  These are ordinary commands: run them yourself, or in a script.      │
│  This clone's settings go in its .git/config, which is never pushed.  │
│                                                                       │
├───────────────────────────────────────────────────────────────────────╯
│
◆  Run these 3 steps?
│  ● Run them
│  ○ Back
│  ○ Change an answer
│  ○ Decline
└
```

Arrow keys choose, Enter confirms, Esc or Ctrl-C cancels (exit 130). Once there is a
question to go back to, each list has a **← Back** (at a text question, type `<`). The
review has **Back** and **Change an answer**, and Enter takes **Run them**, or
**Decline** when a step changes the whole machine (`fix`). With `NO_COLOR` or
`FORCE_COLOR=0`, and always with `TERM=dumb`, the same questions come as numbered
choices.

When you choose Run, each step prints what it is, then the command and its own output
(`use` may print its own "Next: repown guard on"; if you chose the guard, the next step
turns it on):

```
└  Running the commands
       step 1 of 3: Let this clone push to octo-org's repositories
       > git config --local --add repown.allowOwner octo-org
OK    origin     pushes to octo-org allowed in this clone
       ...
       step 3 of 3: Turn on the push guard: each push is checked first
       > repown guard on
OK    guard      on -- every push is checked before it leaves
  /home/you/code/project/.git/hooks/pre-push
       done: this clone is set up for octocat
       check it any time: repown (this clone), repown doctor (this machine)
```

Run it again in a clone that needs nothing, and it says so instead (this screen has no
Back):

```
◇  This clone is already set up ───────────────────────────────────────╮
│                                                                      │
│  commits as  Octo Cat <octocat@users.noreply.github.com>             │
│  pushes as   octocat                                                 │
│  guard       on: every push is checked before it leaves              │
│                                                                      │
│  Nothing needs to change.                                            │
│                                                                      │
│  Checked: the settings git uses here are octocat's, as recorded.     │
│  See it any time: repown (this clone), repown doctor (this machine)  │
│                                                                      │
├──────────────────────────────────────────────────────────────────────╯
│
◆  What now?
│  ● Done (change nothing)
│  ○ Apply the same settings again
│  ○ Change an answer
└
```

</details>

### B. By hand

The same commands `repown setup` runs, one at a time.

#### 1. Check the machine, once

```
$ repown doctor

  helper             manager
  stored accounts    none stored yet
  gh accounts        octocat, octo-work
  gh active          octo-work
  GCM                git-credential-manager

  Credentials come from Git Credential Manager, which stores one per
  account and picks per repository from credential.<url>.username. No
  switching is needed for git, and `gh auth switch` affects the CLI only.

WARN  store      no accounts stored yet -- the first push will sign in once.

  If a push or fetch still fails right after this, the credential may
  be valid but not yet SSO-authorized for that organisation. Re-authorize it:
  gh auth refresh -h <host>, or via the org's SSO settings.
```

- **gh is the helper:** run `repown fix`. It shows what it removes, and the undo, before
  changing anything.
- **`GCM` says `not found`:** install it (above).
- **`helper` says `none configured`:** run `git-credential-manager configure`, then
  `repown doctor` again.

#### 2. Record your accounts, once

```
$ repown accounts add octocat --name "Octo Cat" --email octocat@users.noreply.github.com
OK    accounts   octocat  Octo Cat <octocat@users.noreply.github.com>

  Use it in any clone:  repown use octocat
```

Repeat for each account (`octo-work` below). Or skip this: on a terminal, the first
`repown use` of an account asks for its name and email. Without `--name` and `--email`,
both `use` and `accounts add` suggest them on GitHub from the account's public profile
(through gh).

#### 3. Pin and guard each clone, once

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
accept it: `git config --local --add repown.allowOwner octo-org`. Until then the guard
refuses pushes there.

`repown use` writes these repo-local keys and nothing else:

| Key | What it decides |
| --- | --- |
| `user.name`, `user.email` | who **authored** the commit |
| `repown.account` | whose clone this is; the guard checks the destination against it |
| `credential.<host>.username` | which stored credential serves the **push** (GitHub over https only) |
| `user.useConfigOnly` | git refuses to invent an identity from the hostname |

`.git/config` and `.git/hooks` are never pushed: teammates see nothing of this setup.
Your commits carry the name and email, as they always did.

### The first push

**The first push from each account signs in once.** GCM opens a browser: sign in as
*that* clone's account, not whichever you used last. After that, pushes from that clone
use it without asking. If a push is refused or asks for a password, see the table in
[Day to day](#day-to-day).

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

**Something went wrong?**

| What happened | Where to look |
| --- | --- |
| A push asked for a password | [card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine), then [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| A push failed after signing in (SSO) | [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| The guard refused a push | most often a commit made before pinning: `git commit --amend --reset-author --no-edit`, then push again; [card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| The guard said the push goes to another owner (an organisation) | [card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix): `repown.allowOwner` |
| A teammate doesn't use repown | [card 9](docs/HOW-IT-WORKS.md#9-a-teammate-without-repown) |
| husky or another hook tool | [card 10](docs/HOW-IT-WORKS.md#10-other-hook-tools): have its pre-push hook run `repown guard check` |
| "repown cannot be found" on push | [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing) |

## Commands

| Command | What it does |
| --- | --- |
| `repown status` (or just `repown`) | the state of this repository and this machine |
| `repown use <account> [--gh]` | pin this clone to an account (`--name` and `--email` together skip the registry, the file where repown remembers accounts, and don't record the account) |
| `repown off` | unpin this clone, leaving global config alone |
| `repown doctor` | what serves credentials on this machine, and to whom |
| `repown fix [--dry-run] [--yes]` | undo `gh auth setup-git` so per-clone pins work again |
| `repown guard on \| off \| status` | install, remove or show the pre-push hook |
| `repown accounts list \| add \| remove` | the accounts this machine knows (`add` takes `--name`, `--email`, `--host github\|azdo\|generic`) |
| `repown scan [dir...] [--emails] [--depth <n>] [--format json]` | audit every clone under the given directories (default: the current one) |
| `repown setup [<account>] [--guard] [--no-input]` | guided setup of this clone: asks, shows each step, then runs them (every answer has a flag: `--name`, `--email`, `--host`, `--gh`, `--allow-owner <owner>`, `--fix`; scripts: [docs/CONFIGURATION.md](docs/CONFIGURATION.md#scripts-and-ci)) |

- **Help:** `repown --help` lists the commands. `repown help <command>` (or
  `repown <command> --help`) shows a command's options, and `repown help guard on` goes
  one level deeper. Asking for help never changes anything.
- **Every command:** `--cwd <dir>` works on all of them.
- **Version:** `repown --version` (or `-v`).
- **Exit codes:** `0` success, `1` failure or refusal, `2` usage error. `scan` exits `0`
  whatever it finds; read its output, or its JSON, for the problems. `setup` exits `0` too
  when the clone is already set up and you choose Done, `1` when you Decline, `130` when
  cancelled or interrupted, and when one of its commands fails, that command's own code.

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
the helper role from gh and you want it back: `gh auth setup-git`.

Details, and submodules: [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing).

## More docs

| I want… | Read |
| --- | --- |
| every scenario, with diagrams | [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) |
| environment variables, where accounts are kept, per-clone keys, scripts and JSON | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| short answers, and how repown compares with other approaches | [docs/FAQ.md](docs/FAQ.md) |
| to run it from a clone, or try it on throwaway repositories | [CONTRIBUTING.md](CONTRIBUTING.md) |
| to report a vulnerability privately | [SECURITY.md](SECURITY.md) |
| why it works this way, one ADR per decision | [docs/decisions/](docs/decisions/README.md) |
| what changed in each version, and how a release is cut | [CHANGELOG.md](CHANGELOG.md), [docs/RELEASING.md](docs/RELEASING.md) |

## License

[MIT](LICENSE)
