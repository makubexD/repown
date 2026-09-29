# repown

[![npm](https://img.shields.io/npm/v/repown.svg)](https://www.npmjs.com/package/repown)
[![CI](https://github.com/makubexD/repown/actions/workflows/ci.yml/badge.svg)](https://github.com/makubexD/repown/actions/workflows/ci.yml)
[![Release](https://github.com/makubexD/repown/actions/workflows/release.yml/badge.svg)](https://github.com/makubexD/repown/actions/workflows/release.yml)
[![Node](https://img.shields.io/node/v/repown.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Stop committing and pushing as the wrong account when one machine has two or more.**
Each repository owns its identity (that's the name: *repo own*), so you move from a work
repo to a personal one to a client one, on any host or sign-in method, with no switch
command. A push carrying commits under the wrong identity is refused before it leaves.

**Day to day:**

```
~/code/work      $ git push         # 🟢 signs in as octo-work
~/code/personal  $ git push         # 🟢 signs in as octocat, no switch command
~/code/personal  $ git push         # 🔴 refused: a commit authored as octo-work
~/code/client    $ repown status    # 🟡 guard off: pushes are not checked
```

> **Status:** pre-1.0: the commands may still change. What changed in each version is in
> [CHANGELOG.md](CHANGELOG.md).

**Contents:** 🤔 [Why repown](#why-repown) · 📦 [Install](#install) ·
⚡ [Quick start](#quick-start) · ⌨️ [Commands](#commands) ·
🩺 [Troubleshooting](#troubleshooting) · 🛠️ [Set up by hand](#set-up-by-hand) ·
🧹 [Uninstall](#uninstall) · 📚 [More docs](#more-docs)

## Why repown

**The problem:**

- ❌ **Every clone inherits the identity in your global git config.** A commit's author
  address becomes permanent once it's pushed to a public repository.
- ❌ **`gh auth switch` changes the account for the whole machine.** While `gh` (the GitHub
  CLI) is git's *credential helper* (the program git asks for a password or token), every
  switch breaks the *other* account's repositories. And if your organisation signs you in
  through single sign-on (SSO), there's no password you could type at that prompt anyway
  ([ADR-001](docs/decisions/ADR-001-credential-manager-not-gh.md)).

**What repown does:**

- ✅ **Pins each clone.** It writes the commit identity and the push account into that
  clone's own `.git/config`. That's what *pinned* means here: set once, never switched.
- ✅ **Lets one credential serve each account.**
  [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager) (GCM)
  stores one sign-in per account and picks the one each clone names. `repown doctor`
  checks GCM is the helper; if gh has become it (`gh auth login` offers that),
  `repown fix` removes gh's entries after showing them. `gh` stays your account store for
  `gh pr create` and `gh api`.
- ✅ **Guards every push.** A git `pre-push` hook (a script git runs before every push),
  the *guard*, checks the commits being pushed, not just today's config.

**Where it works:**

| | Commit identity | Guard | Push sign-in pinned |
| --- | --- | --- | --- |
| GitHub over https | ✅ | ✅ | ✅ (github.com) |
| GitHub over SSH | ✅ | ✅ | ➖ your key decides which account pushes |
| Azure DevOps and other hosts | ✅ | ✅ | ❌ not pinned ([ADR-009](docs/decisions/ADR-009-hosts-claim-only-measured.md)) |

Every scenario, with diagrams: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Install

**You need:**

- **Node 20+** and **git**, on Windows, macOS or Linux.
- **Git Credential Manager** for per-account sign-in on GitHub. Git for Windows includes
  it; on macOS and Linux, follow
  [GCM's install guide](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/install.md).
- **gh** is optional: repown reads it when it's there.

```
npm install -g repown
```

- **Install it globally:** the guard calls the installed repown. To try it first,
  `npx repown` runs commands that only read (`repown status`, `repown doctor`,
  `repown scan`), but don't turn the guard on through `npx`: its hook would call a
  temporary copy ([card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing)).
- **Update** with `npm install -g repown@latest`; guarded clones keep working
  ([ADR-003](docs/decisions/ADR-003-hook-calls-installed-cli.md)).
- **What gets installed:** one optional dependency, for the arrow-key prompts (without it,
  `repown setup` and the start screen ask with numbered choices), pinned exactly
  ([ADR-016](docs/decisions/ADR-016-clack-for-the-setup-wizard.md)). The package is
  published from CI with provenance ([how](SECURITY.md#how-the-package-is-published)).

## Quick start

```
repown doctor          # once per machine: is Git Credential Manager ready for sign-ins?
cd ~/code/my-repo
repown                 # in a terminal: starts the guided setup of this clone
```

1. **`repown doctor`, once per machine.** It ends with a verdict:
   - 🟢 `ready: each clone signs in as its own account through Git Credential Manager`
   - 🔴 `1 problem: gh answers git's sign-in requests: run repown fix`

   If gh is the helper, or something is missing, see [Troubleshooting](#troubleshooting).
2. **Clone as usual,** then from inside a new clone just type **`repown`.** That starts
   the guided setup. **`repown setup`** still works. (Cloning a private repository signs
   in first: pick the account that owns it.) It asks how setup should work. Recommended is
   the default. Answers it fills in still appear in the review.

   | Question | Recommended | Step by step | Flag |
   | --- | --- | --- | --- |
   | Which account should this clone belong to? | Asked. `repown setup <account>` skips the mode question and uses Recommended, so a recorded account goes straight to the review when nothing else must be asked. A new account also asks where it's hosted, the name and the email. | Asked | `<account>`, `--host`, `--name`, `--email` |
   | Let this clone push to origin's owner? Asked when origin belongs to someone else, like an organisation. | Asked, default Yes. No means the guard refuses pushes there. | Asked, default Yes | `--allow-owner <owner>` |
   | Turn the guard on? | Answers Yes without asking | Asked | `--guard` |
   | Push branches without -u? Only on git 2.37+. It sets `push.autoSetupRemote` in this clone only; the guard still checks that first push. | Answers Yes without asking | Asked, default Yes | `--auto-upstream` |
   | gh. "Switch gh too" makes `gh pr create` match. | Switches without asking when gh already lists the account and the clone is not already pinned to it. A sign-in, which opens a browser, is asked, default No. Skips the question when the clone is already pinned to that account. | Asked | `--gh` |
   | Take git's sign-ins back from gh? Machine-wide. | Asked, default No. Answer Yes if `repown doctor` said gh is the helper, or pushes from your other account's clones fail. | Asked, default No | `--fix` |

   Step by step asks every question: `--step-by-step`.
   `--no-input` asks nothing ([scripts and CI](docs/CONFIGURATION.md#scripts-and-ci)).

   - **In your first clone,** it lists the accounts it can already see on GitHub (origin's
     owner, gh's accounts, Git Credential Manager's) and suggests origin's owner when that
     owner is a user, or asks for the login. On GitHub, use your *noreply* address, shown
     at github.com/settings/emails (like `1234+octocat@users.noreply.github.com`).
   - **In later clones,** it lists the accounts it knows: pick one, or **a new account**.
3. **Check the review, then choose Run them.** Nothing changes before that:

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
   │  4. Push branches without -u: the first push sets the upstream (this    │
   │     clone only)                                                         │
   │       git config --local push.autoSetupRemote true                      │
   │                                                                         │
   │  These are ordinary commands: run them yourself, or in a script.        │
   │  This clone's settings go in its .git/config, which is never pushed.    │
   │                                                                         │
   ├─────────────────────────────────────────────────────────────────────────╯
   │
   ◆  Run these 4 steps?
   │  ● Run them
   │  ○ Back
   │  ○ Change an answer
   │  ○ Decline
   │  ↑/↓ to navigate • Enter: confirm
   └
   ```

4. **Push.** The first push from each account signs in once: GCM opens a browser, and you
   sign in as *that* clone's account, not whichever you used last. After that, pushes from
   that clone use it without asking. When setup set `push.autoSetupRemote`, the first
   `git push` of a branch without an upstream also creates it on origin. When it did not
   (older git, a version repown could not read, or you answered No), use
   `git push -u origin <branch>` once.

**Keys:** ↑/↓ choose, Enter confirms, Esc or Ctrl-C stops with nothing changed. From the
second question on, each list ends with **← Back**; at a typed answer, enter `<`. In a
plain terminal the questions come as numbered choices
([when](docs/CONFIGURATION.md#environment-variables)); there, Ctrl-C stops.

**Running it again.** Run `repown` in a clone that's already set up, or `repown setup`
with no account and no flags, and setup opens on this screen, before any question:

```
◇  This clone is already set up ─────────────────────────────────────╮
│                                                                    │
│  commits as  Octo Cat <octocat@users.noreply.github.com>           │
│  pushes as   octocat                                               │
│  guard       on: every push is checked before it leaves            │
│  upstream    origin/main                                           │
│                                                                    │
│  Nothing needs to change.                                          │
│                                                                    │
│  Checked: the settings git uses here are octocat's, as recorded.   │
│  See it any time: repown status (this clone), repown doctor (this  │
│  machine)                                                          │
│                                                                    │
├────────────────────────────────────────────────────────────────────╯
│
◆  What now?
│  ● Done (change nothing)
│  ○ Use another account
│  ↑/↓ to navigate • Enter: confirm
└
```

**Done** changes nothing. **Use another account** asks which account this clone should
use. When gh acts as someone else, a third option is **Sign in to gh as `<account>`** (or
**Make `<account>` gh's active account** when gh already lists it) and runs
`repown use <account> --gh`. The upstream line shows the tracked branch (for example
`origin/main`) when there is one, otherwise `set on the first push (push.autoSetupRemote)`
when that setting is on, otherwise nothing. It is the same value `repown status` shows,
and `repown status` shows all of this without asking. Every screen:
[card 13](docs/HOW-IT-WORKS.md#13-guided-setup).

## Commands

After setup, **moving between accounts needs no command**: `cd` into any pinned clone,
then commit and push.

| When | Command | What it does |
| --- | --- | --- |
| Once per machine | `repown doctor` | what serves credentials on this machine, and whether each account is signed in to git and gh |
| | `repown fix [--dry-run] [--yes]` | undo `gh auth setup-git`, so each clone's pinned account is used; shows what it removes, and the undo, first |
| Once per clone | `repown setup [<account>]` | guided setup of this clone. Questions, flags and the review: [Quick start](#quick-start). A clone that is already set up opens on that screen |
| | `repown use <account> [--gh]` | what setup runs: pin this clone to an account. `--gh` switches gh's active account, or signs the account in to gh when needed (in a terminal). `--name` with `--email` skips the registry, the file where repown remembers accounts |
| | `repown guard on \| off \| status` | install, remove or show the pre-push hook (bare `repown guard` shows it) |
| Any time | `repown status` | this clone's and this machine's settings, and what to fix. Exits 1 on a problem; warnings alone exit 0 |
| | `repown scan [dir...] [--emails] [--depth <n>] [--format json]` | every clone under the folders (default: this one, 3 levels deep): owner, host, identity, guard, and which email domains its history has. Changes nothing |
| Rarely | `repown accounts list \| add \| remove` | the accounts this machine knows (bare `repown accounts` lists them; `add` takes `--name`, `--email`, `--host github\|azdo\|generic`; `list --format json` for scripts) |
| | `repown off` | unpin this clone, leaving global config alone; warns if the guard is still on |

**Bare `repown`:**

| Where | What it does |
| --- | --- |
| A terminal, inside a clone (pinned or not) | Starts `repown setup`. A line inside that screen says the clone isn't set up yet, or that a pinned clone is being checked ([card 5](docs/HOW-IT-WORKS.md#5-check-where-you-are)) |
| A terminal, outside a clone or in a bare repository | Opens the start screen ([card 14](docs/HOW-IT-WORKS.md#14-outside-a-clone)) |
| stdout redirected (stdin and stderr still terminals) | Status inside a clone. The top help outside a clone, exit 0 |
| No terminal (stdin or stderr is not one) | Status. Exit 1 outside a clone |

The start screen lists the accounts on this machine and the clones it found, then offers
the next command. The summary is in the frame. Picking a command closes the frame with
that command. Nothing changes until you pick one.

**Who is this clone?** `repown status` prints:

```
$ repown status

repown status · current settings of this clone
  ~/code/personal  (branch main)

This clone
  commits as     Octo Cat <octocat@users.noreply.github.com>
  pushes as      octocat
  account        octocat  (recorded)
  origin         octocat  (GitHub)
  upstream       origin/main
  push guard     on

This machine
  default        Octo Work <octo-work@example.invalid>
  helper         manager
  gh active      octo-work

OK    identity   this clone is pinned, and its credential mechanism honours it
NOTE  gh         active as "octo-work", so `gh pr create` here would act as that account. git pushes are unaffected; this only matters if you use gh here.
       fix: gh auth switch -u octocat

ready: commits and pushes use octocat · gh: optional (see the note above)
```

Here git is right, and only `gh` commands would act as another account. That line is a
note, not a warning. Every warning it can print:
[card 5](docs/HOW-IT-WORKS.md#5-check-where-you-are).

- **Help:** `repown --help`, `repown help <command>` (or `repown <command> --help`), and
  `repown help guard on` one level deeper. Help never changes anything.
- **Every command** takes `--cwd <dir>`. **Version:** `repown --version` (or `-v`).

**Exit codes:**

| Command | 0 | 1 | 2 | Other |
| --- | --- | --- | --- | --- |
| In general | Success | Failure or refusal | Usage error | |
| `repown scan` | Whatever it finds (read its output or JSON) | | A missing folder or a bad `--depth` | |
| `repown setup` | Done, or already set up | Decline, or it can't start | Flags that don't fit, or no terminal without `--no-input` | 130 when cancelled or interrupted; a failing step's own code |
| `repown status` | Success. Warnings alone exit 0 | A problem | | |

Every `setup` case: [Scripts and CI](docs/CONFIGURATION.md#scripts-and-ci).

## Troubleshooting

| What happened | What to do |
| --- | --- |
| `repown doctor` says gh is the helper | `repown fix` ([card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine)) |
| `repown doctor` shows `GCM` … `not found` | install Git Credential Manager ([Install](#install)), then `repown doctor` again |
| `repown doctor` shows `helper` … `none configured` | `git credential-manager configure`, then `repown doctor` again |
| A push asked for a password | `repown status` (this clone) or `repown doctor` (this machine): each names the cause (gh as the helper, or no helper) and the fix |
| A push failed right after signing in (SSO) | [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| The guard refused a push | it says which commit and the fix. Most often a commit made before pinning: `git commit --amend --reset-author --no-edit` fixes the last one ([card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) for older ones, and every other refusal) |
| `gh pr create` acts as the wrong account | `gh auth switch -u <account>` when gh lists it, otherwise `repown use <account> --gh` |
| `git push` says the branch has no upstream | `repown setup --auto-upstream`, or once `git push -u origin <branch>` |
| The first push opened a browser | Expected, once per account. Git Credential Manager stores it |
| The guard said the push goes to another owner | if you're a member or collaborator there: `git config --local --add repown.allowOwner <owner>` |
| The guard said `GH_TOKEN` (or `GITHUB_TOKEN`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL`) is set | unset it, then push again: the email variables override the pinned identity, and the token variables make gh serve that token |
| husky or another tool owns the pre-push hook | have that hook run `repown guard check --remote="$1" --url="$2"`, passing its stdin through; if the hook is committed, make it skip teammates without repown ([card 10](docs/HOW-IT-WORKS.md#10-other-hook-tools)) |
| An Azure DevOps push is refused as "wrong owner" | the owner there is the organisation: allow it with `git config --local --add repown.allowOwner <organisation>` |
| "repown cannot be found" on push | [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing) |

A refused push:

```
FAIL  guard      1 commit(s) bound for refs/heads/main were not authored as octocat@users.noreply.github.com, or were committed by someone else.
         6e7b31adb  someone@example.invalid  someone else's commit

       These addresses become permanent once pushed.


Push stopped by the repown identity guard (above).
Override this one push with: git push --no-verify
```

To push once without the check: `git push --no-verify`, only when you mean to publish
those addresses. What the guard can't catch (other git clients, submodule pushes):
[residual risks](docs/decisions/README.md#residual-risks).

## Set up by hand

The same commands `repown setup` runs, if you'd rather type them:

1. **Check the machine, once:** `repown doctor`.
2. **Record each account, once:**
   `repown accounts add octocat --name "Octo Cat" --email octocat@users.noreply.github.com`.
   Optional: on a terminal, the first `repown use` of an unknown account asks. On GitHub
   it suggests the name from the public profile and the noreply email (through gh)
   ([card 2](docs/HOW-IT-WORKS.md#2-remember-an-account)).
3. **In each clone:** `repown use octocat`, then `repown guard on`
   ([card 3](docs/HOW-IT-WORKS.md#3-pin-a-clone)). If the repository belongs to another
   owner, such as an organisation, `use` prints the line that allows it.

```
$ cd ~/code/dotfiles
$ repown use octocat
OK    identity   Octo Cat <octocat@users.noreply.github.com>  push-as:octocat

  No stored credential for "octocat" yet -- the first push signs in
  once, then never again. Verify it afterwards: repown doctor

  Next: repown guard on    (check every push before it leaves)

$ repown guard on
OK    guard      on -- every push is checked before it leaves
  ~/code/dotfiles/.git/hooks/pre-push
```

`.git/config` and `.git/hooks` are never pushed, so teammates see nothing of this setup.
Every key repown writes:
[docs/CONFIGURATION.md](docs/CONFIGURATION.md#what-repown-writes).

## Uninstall

Turn the guard off **first**: a guard that can't find repown refuses every push.

```
repown scan <dir>        # the "guard" column shows where it's on
repown guard off         # in each of those clones
repown off               # optional: also drop the pinned identity
npm uninstall -g repown
```

Left behind, on purpose: the account registry
([where](docs/CONFIGURATION.md#the-account-registry)), which you can delete, and the
sign-ins in your OS credential store. If `repown fix` took the helper role from gh and you
want it back: `gh auth setup-git`. Details, and submodules:
[card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing).

## More docs

| I want… | Read |
| --- | --- |
| every scenario, with diagrams | [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) |
| environment variables, where accounts are kept, per-clone keys, scripts and JSON | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| short answers, and how repown compares with `includeIf`, SSH aliases and `gh auth switch` | [docs/FAQ.md](docs/FAQ.md) |
| to contribute, see where each feature lives in the code, or try it on throwaway repositories | [CONTRIBUTING.md](CONTRIBUTING.md) |
| to report a vulnerability privately | [SECURITY.md](SECURITY.md) |
| why it works this way, one ADR per decision | [docs/decisions/](docs/decisions/README.md) |
| what changed in each version, and how a release is cut | [CHANGELOG.md](CHANGELOG.md), [docs/RELEASING.md](docs/RELEASING.md) |

## License

[MIT](LICENSE)
