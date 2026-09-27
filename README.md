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

> **Status:** pre-1.0: the commands may still change. What changed in each version is in
> [CHANGELOG.md](CHANGELOG.md).

**Contents:** [Why repown](#why-repown) · [Install](#install) · [Quick start](#quick-start) ·
[Commands](#commands) · [Troubleshooting](#troubleshooting) · [Set up by hand](#set-up-by-hand) ·
[Uninstall](#uninstall) · [More docs](#more-docs)

## Why repown

**The problem:**

- **Every clone inherits the identity in your global git config.** A commit's author
  address becomes permanent once it's pushed to a public repository.
- **`gh auth switch` changes the account for the whole machine.** While `gh` (the GitHub
  CLI) is git's *credential helper* (the program git asks for a password or token), every
  switch breaks the *other* account's repositories. And if your organisation signs you in
  through single sign-on (SSO), there's no password you could type at that prompt anyway
  ([ADR-001](docs/decisions/ADR-001-credential-manager-not-gh.md)).

**What repown does:**

- **Pins each clone.** It writes the commit identity and the push account into that
  clone's own `.git/config`. That's what *pinned* means here: set once, never switched.
- **Lets one credential serve each account.** [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager)
  (GCM) stores one sign-in per account and picks the one each clone names. `repown doctor`
  checks GCM is the helper; if gh has become it (`gh auth login` offers that), `repown fix`
  removes gh's entries after showing them. `gh` stays your account store for
  `gh pr create` and `gh api`.
- **Guards every push.** A git `pre-push` hook (a script git runs before every push), the
  *guard*, checks the commits being pushed, not just today's config.

Commit identity and the guard work on every host. The sign-in is pinned on GitHub (github.com)
over https only; on SSH, your key decides which account pushes
([ADR-009](docs/decisions/ADR-009-hosts-claim-only-measured.md)). Every scenario, with
diagrams: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

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
  `npx repown` runs any command that only reads (`repown`, `repown doctor`, `repown scan`),
  but don't turn the guard on through `npx`: its hook would call a temporary copy
  ([card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing)).
- **Update** with `npm install -g repown@latest`; guarded clones keep working
  ([ADR-003](docs/decisions/ADR-003-hook-calls-installed-cli.md)).
- **What gets installed:** one optional dependency, for the arrow-key prompts (without it,
  `setup` asks with numbered choices), pinned exactly ([ADR-016](docs/decisions/ADR-016-clack-for-the-setup-wizard.md)). The package is
  published from CI with provenance ([how](SECURITY.md#how-the-package-is-published)).

## Quick start

```
repown doctor          # once per machine: is Git Credential Manager ready for sign-ins?
cd ~/code/my-repo
repown                 # a new clone: just typing this starts the guided setup
```

1. **`repown doctor`, once per machine.** No `FAIL` line means it's ready. If gh is the
   helper, or something is missing, see [Troubleshooting](#troubleshooting).
2. **Clone as usual,** then from inside a new clone just type **`repown`.** That starts the
   guided setup. **`repown setup`** still works. (Cloning a private repository signs in
   first: pick the account that owns it.)
   - **In your first clone,** it lists the accounts it can already see on GitHub
     (origin's owner, gh's accounts, Git Credential Manager's) and suggests origin's
     owner when that owner is a user, or asks for the login. Then it asks where the
     account is hosted and the name and email for your commits; on GitHub, use your
     *noreply* address, shown at github.com/settings/emails (like
     `1234+octocat@users.noreply.github.com`).
   - **In later clones,** it lists the accounts it knows: pick one, or **a new account**.
   - **Then it asks only what applies here:**
     - *switch gh too:* make the account gh's active one, so `gh pr create` matches;
     - *allow the repository's owner:* for an organisation's repository (answer No and the
       guard refuses pushes there);
     - *turn the guard on;*
     - *take git's sign-ins back from gh:* answer Yes if `repown doctor` said gh is the
       helper, or pushes from your other account's clones fail.
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

4. **Push.** The first push from each account signs in once: GCM opens a browser, and
   you sign in as *that* clone's account, not whichever you used last. After that, pushes
   from that clone use it without asking.

**Keys:** ↑/↓ choose, Enter confirms, Esc or Ctrl-C stops with nothing changed. From the
second question on, each list ends with **← Back**; at a typed answer, enter `<`. In a
plain terminal the questions come as numbered choices ([when](docs/CONFIGURATION.md#environment-variables));
there, Ctrl-C stops. Run `repown` again in a clone that's already set up and it shows
that clone's status. `repown setup` there says the clone is already set up and offers
**Done**. Every screen: [card 13](docs/HOW-IT-WORKS.md#13-guided-setup).

## Commands

After setup, **moving between accounts needs no command**: `cd` into any pinned clone,
then commit and push.

| When | Command | What it does |
| --- | --- | --- |
| Once per machine | `repown doctor` | what serves credentials on this machine, and to whom |
| | `repown fix [--dry-run] [--yes]` | undo `gh auth setup-git`, so each clone's pinned account is used; shows what it removes, and the undo, first |
| Once per clone | `repown setup [<account>]` | guided: asks, shows each step and its command, then runs them. Every answer has a flag (`--name`, `--email`, `--host`, `--gh`, `--allow-owner <owner>`, `--guard`, `--fix`); `--no-input` asks nothing ([scripts and CI](docs/CONFIGURATION.md#scripts-and-ci)) |
| | `repown use <account> [--gh]` | what setup runs: pin this clone to an account; `--gh` also switches gh's active account. `--name` with `--email` skips the registry, the file where repown remembers accounts |
| | `repown guard on \| off \| status` | install, remove or show the pre-push hook (bare `repown guard` shows it) |
| Any time | `repown` (or `repown status`) | this clone's and this machine's settings, and what to fix; exits 1 on a problem (warnings alone exit 0). In a terminal, bare `repown` starts `repown setup` in a clone that isn't set up, shows status in one that is, and shows the help outside a clone (exit 0). Without a terminal, or with its output redirected, it is always status (exit 1 outside a clone) |
| | `repown scan [dir...] [--emails] [--depth <n>] [--format json]` | every clone under the folders (default: this one, 3 levels deep): owner, host, identity, guard, and which email domains its history has. Changes nothing |
| Rarely | `repown accounts list \| add \| remove` | the accounts this machine knows (bare `repown accounts` lists them; `add` takes `--name`, `--email`, `--host github\|azdo\|generic`; `list --format json` for scripts) |
| | `repown off` | unpin this clone, leaving global config alone; warns if the guard is still on |

**Who is this clone?** Once the clone is set up, `repown` prints:

```
$ repown

repown status · current settings of this clone
  ~/code/personal  (branch main)

This clone
  commits as     Octo Cat <octocat@users.noreply.github.com>
  pushes as      octocat
  account        octocat  (recorded)
  origin         octocat  (GitHub)
  push guard     on

This machine
  default        Octo Work <octo-work@example.invalid>
  helper         manager
  gh active      octo-work

WARN  gh         active as "octo-work", so `gh pr create` here would act as that account.
       fix: gh auth switch -u octocat
OK    identity   this clone is pinned, and its credential mechanism honours it

1 warning
```

Here git is right, and only `gh` commands would act as another account. Every warning it
can print: [card 5](docs/HOW-IT-WORKS.md#5-check-where-you-are).

- **Help:** `repown --help`, `repown help <command>` (or `repown <command> --help`), and
  `repown help guard on` one level deeper. Help never changes anything.
- **Every command** takes `--cwd <dir>`. **Version:** `repown --version` (or `-v`).
- **Exit codes:** `0` success, `1` failure or refusal, `2` usage error.
  - `scan` exits `0` whatever it finds (read its output or JSON), `2` for a missing folder
    or a bad `--depth`.
  - `setup` exits `0` when done (or Done); `1` when you Decline or it can't start;
    `130` when cancelled or interrupted; `2` for flags that don't fit, or without a
    terminal unless `--no-input` is given; and a failing step's own code. Every case:
    [Scripts and CI](docs/CONFIGURATION.md#scripts-and-ci).

## Troubleshooting

| What happened | What to do |
| --- | --- |
| `repown doctor` says gh is the helper | `repown fix` ([card 1](docs/HOW-IT-WORKS.md#1-set-up-the-machine)) |
| `repown doctor` shows `GCM` … `not found` | install Git Credential Manager ([Install](#install)), then `repown doctor` again |
| `repown doctor` shows `helper` … `none configured` | `git credential-manager configure`, then `repown doctor` again |
| A push asked for a password | run `repown`: it names the cause (gh as the helper, or no helper) and the fix |
| A push failed right after signing in (SSO) | [card 6](docs/HOW-IT-WORKS.md#6-commit-and-first-push) |
| The guard refused a push | it says which commit and the fix. Most often a commit made before pinning: `git commit --amend --reset-author --no-edit` fixes the last one ([card 8](docs/HOW-IT-WORKS.md#8-push-refused-and-the-fix) for older ones, and every other refusal) |
| The guard said the push goes to another owner | if you're a member or collaborator there: `git config --local --add repown.allowOwner <owner>` |
| The guard said `GH_TOKEN` (or `GITHUB_TOKEN`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL`) is set | unset it, then push again: the email variables override the pinned identity, and the token variables make gh serve that token |
| husky or another tool owns the pre-push hook | have that hook run `repown guard check --remote="$1" --url="$2"`, passing its stdin through; if the hook is committed, make it skip teammates without repown ([card 10](docs/HOW-IT-WORKS.md#10-other-hook-tools)) |
| An Azure DevOps push is refused as "wrong owner" | the owner there is the organisation: allow it with `git config --local --add repown.allowOwner <organisation>` |
| "repown cannot be found" on push | [card 12](docs/HOW-IT-WORKS.md#12-uninstall-or-repown-missing) |

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
  /home/you/code/dotfiles/.git/hooks/pre-push
```

`.git/config` and `.git/hooks` are never pushed, so teammates see nothing of this setup.
Every key repown writes: [docs/CONFIGURATION.md](docs/CONFIGURATION.md#what-repown-writes).

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
| to contribute, see where each feature lives in the code, or try it on throwaway repositories | [CONTRIBUTING.md](CONTRIBUTING.md) |
| to report a vulnerability privately | [SECURITY.md](SECURITY.md) |
| why it works this way, one ADR per decision | [docs/decisions/](docs/decisions/README.md) |
| what changed in each version, and how a release is cut | [CHANGELOG.md](CHANGELOG.md), [docs/RELEASING.md](docs/RELEASING.md) |

## License

[MIT](LICENSE)
