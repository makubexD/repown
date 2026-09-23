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

- Every clone inherits the identity in your global git config, and a commit's
  author address is permanent once pushed to a public repository.
- `gh auth switch` changes the account machine-wide. While `gh` is git's
  credential helper, every switch breaks the *other* account's repositories, and
  an SSO-only account has no password to type at the prompt.
  ([DECISIONS §1](docs/DECISIONS.md#1-git-credentials-come-from-the-credential-manager-gh-is-for-the-cli))

## How repown solves it

- **Pin each clone:** `repown use <account>` writes the commit identity and the push
  account into that clone's `.git/config`. It is set once and never switched.
- **One credential per account:** Git Credential Manager already stores one
  credential per account and picks it per clone. `repown doctor` checks that it is the
  helper, and `repown fix` hands the host back to it if `gh auth setup-git` took over.
  `gh` stays your account store for `gh pr create` and `gh api`.
- **Guard every push:** `repown guard on` installs a `pre-push` hook that checks the
  commits themselves, not just today's config.

## Compared with the alternatives

| Approach | Right commit identity | Right push credential | Checked before push | Catch |
| --- | --- | --- | --- | --- |
| `git config user.email` by hand in each repo | yes, if you never forget | no | no | Forgetting once publishes the wrong address permanently |
| `includeIf "gitdir:~/work/"` in global config | yes, by folder | only if you also add the credential key per folder | no | Depends on where a repo happens to be cloned; a clone anywhere else inherits the default |
| SSH host aliases (`git@github-work:...`) | no | yes | no | Every remote URL has to be rewritten, and keys managed per account |
| `gh auth switch` | no | while gh is the helper, only the *active* account | no | Machine-wide: it breaks the other account's repos ([§1](docs/DECISIONS.md#1-git-credentials-come-from-the-credential-manager-gh-is-for-the-cli)) |
| **repown** | yes, per clone | yes, per clone (GitHub) | yes, once `repown guard on`: every commit the push would publish | `use` and `guard on` once per clone; credential pinning is GitHub-only today ([Hosts](#hosts)) |

repown doesn't replace these tools. It writes plain repo-local git config, uses the
credential manager you already have, and leaves `gh` in charge of the GitHub CLI.

## Install

Needs Node 20+ and git, on Windows, macOS or Linux. It is not on npm yet, so
install it from the repository:

```
git clone https://github.com/makubexD/repown.git
cd repown && npm install && npm run build && npm link
```

`npm link` puts `repown` on your PATH, and `npm unlink -g repown` removes it. The
package is marked `private` and kept off npm until its command surface has
settled.

## Quickstart

**Once per machine**, check what serves your git credentials:

```
repown doctor      # names the fix if gh is the credential helper
repown fix         # only if doctor says so; shows what it removes and the undo first
```

**Once per clone:**

```
$ repown use octocat
OK    identity   Octo Cat <octocat@users.noreply.github.com>  push-as:octocat

  No stored credential for "octocat" yet -- the first push signs in
  once, then never again. Verify it afterwards: repown doctor

  Next: repown guard on    (check every push before it leaves)

$ repown guard on
```

`repown use` takes the account's commit name and email from this machine's registry.
The first time, if they aren't recorded, it asks for them, suggesting the GitHub
noreply address ([§5](docs/DECISIONS.md#5-no-names-or-addresses-live-in-any-repository)),
and records them for every other clone. Without a terminal it can't ask, so
record the account up front:
`repown accounts add octocat --name "Octo Cat" --email octocat@users.noreply.github.com`.

`repown use` writes these repo-local keys and nothing else (the credential key only
where the host's credentials can be pinned, which today means GitHub):

| Key | What it decides |
| --- | --- |
| `user.name`, `user.email` | who **authored** the commit |
| `credential.<host>.username` | which stored credential serves the **push** |
| `user.useConfigOnly` | git refuses to invent an identity from the hostname |

`.git/config` is never tracked, so no name or address reaches the repository.
The same is true on a second machine or after a re-clone, where you run `repown use`
again.

## Day to day

**Moving between accounts needs no command.** `cd` into any pinned clone, then
commit and push. To see who a clone is, run `repown` (short for `repown status`):

```
$ repown

  commits as     Octo Cat <octocat@users.noreply.github.com>
  pushes as      octocat
  origin         octocat  (GitHub)
  helper         manager
  gh active      <your other account>
  push guard     on

WARN  gh         active as "<your other account>", so `gh pr create` here would act as that account.
       fix: gh auth switch -u octocat
OK    identity   this clone is pinned, and its credential mechanism honours it
```

It prints all three things that decide who you are (commit identity, push
credential, gh's active account), because the one you can't see is the one that
catches you out. `repown use octocat --gh` also switches gh to match.

**Re-point a clone** that now belongs to another account: `repown off` removes the
repo-local identity (global config is never touched), then `repown use <other>`.

**Audit every clone** you already have:

```
$ repown scan ~/code ~/work

    repo             owner          host    identity     guard   identities in history
    --------------------------------------------------------------------
    personal-project octocat        github  INHERITED    off     work.example.invalid=122
    the-fork         octocat        github  pinned       on      users.noreply.github.com=8  (excl. mirror)
    work-service     acme           github  INHERITED    off     work.example.invalid=13655 +12 more

  repositories     3
  not pinned       2
  not guarded      2

  The identity column is a FACT, not a verdict: a shared repository
  legitimately carries many addresses. What is worth acting on is a
  repository you own whose history carries an address that is not yours.

  Pin one:  cd <repo> && repown use <account> && repown guard on
```

With no directory it scans the current one, looking 3 levels deep (`--depth`).
It shows domains and counts rather than addresses, because this output gets pasted
into chats; `--emails` shows the exact addresses. The guard stops new wrong
addresses; it cannot rewrite history.

## Commands

| Command | What it does |
| --- | --- |
| `repown status` (or just `repown`) | the state of this repository and this machine |
| `repown use <account> [--gh]` | pin this clone to an account (`--name`/`--email` skip the registry) |
| `repown off` | unpin this clone, leaving global config alone |
| `repown doctor` | what serves credentials on this machine, and to whom |
| `repown fix [--dry-run] [--yes]` | undo `gh auth setup-git` so per-clone pins work again |
| `repown guard on \| off \| status` | install, remove or show the pre-push hook |
| `repown accounts list \| add \| rm` | the accounts this machine knows (`add` takes `--name`, `--email`, `--host github\|azdo\|generic`) |
| `repown scan [dir...] [--emails] [--depth <n>]` | audit every clone under the given directories (default: the current one) |

`repown --help` lists them. `repown help <command>` (or `repown <command> --help`) shows a
command's options, and `repown help guard on` goes one level deeper. Asking for help
never changes anything. `--cwd <dir>` works on every command, and `repown --version`
prints the version. Exit codes: `0` success, `1` failure or refusal, `2` usage error.

## The guard

It reads the refs git is about to push and checks **the commits themselves**:
the author and the committer of every commit the push would publish. So it also
catches a commit made before setup, on another branch, or brought in by a merge,
rebase or cherry-pick. Commits the remote already has are skipped, because
pushing them again publishes nothing new
([§2](docs/DECISIONS.md#2-the-guard-verifies-commits-not-configuration)).

```
$ git push
FAIL  guard      1 commit(s) bound for refs/heads/main were not authored as octocat@users.noreply.github.com.
         fb201afcc  someone-else@example.invalid  not ours

       These addresses become permanent once pushed.

Push stopped by the repown identity guard (above).
Override this one push with: git push --no-verify
```

It also refuses:

- a destination owned by someone other than the pinned account, parsed from the
  URL, so `https://octocat@github.com/someone-else/repo` doesn't pass on its
  userinfo;
- `GH_TOKEN` / `GITHUB_TOKEN`, or `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_EMAIL`,
  because each silently outranks the identity it just checked;
- a clone with no pinned identity;
- commits it can't read. When the remote's branch tip was never fetched (a
  force-push over someone else's push, say), it checks every commit the remote
  doesn't already have instead;
- **itself being unrunnable.** If `repown` can't be found, the hook refuses rather
  than passing. A `repown` found on PATH is trusted only if `repown --version` says
  it is repown ([§3](docs/DECISIONS.md#3-the-hook-calls-the-installed-cli-and-refuses-when-it-cannot)).

It ignores credential problems, because a failed authentication publishes
nothing; `repown` and `repown doctor` warn about those instead
([§8](docs/DECISIONS.md#8-what-refuses-and-what-only-warns)). If a `pre-push` hook
that repown didn't write already exists, `repown guard on` and `repown guard off` leave it
alone. The same goes when `core.hooksPath` sends git to another hooks directory
(husky sets it, for example). The guard reports what git will actually run, and
`repown guard on` refuses to write into a directory it doesn't own. To guard such a
clone, have that tool's `pre-push` hook run
`repown guard check --remote "$1" --url "$2"`.

Two repo-local keys adjust it:

```
git config --local repown.mirrorBranch master        # a branch that only mirrors upstream
git config --local --add repown.allowOwner An-Org    # another owner you may push to (repeatable)
```

Unset `repown.mirrorBranch` means no exemption. On the mirror branch, commits
already on any remote (fetched from upstream, say) don't count, but a commit made
here and on no remote is still refused. An organisation is never an account
name, so organisation repositories need `repown.allowOwner`; `repown use` prints the
exact command when it sees an unknown owner.

**Leave the guard off on shared repositories.** It refuses *any* foreign author,
and pushing a colleague's commit is ordinary work there. `repown use` alone still
pins your identity; a server-side ruleset on author addresses is the right control
for a team.

## Hosts

| Host | Commit identity | Guard | Credential pinning |
| --- | --- | --- | --- |
| GitHub | yes | yes | yes |
| Azure DevOps | yes | yes | **no** ([§6](docs/DECISIONS.md#6-hosts-are-a-strategy-and-only-claim-what-was-measured)) |
| anything else | yes | yes | no |

An author address is the same fact on every host, so pinning and the guard work
everywhere. Credential pinning is claimed only where it was measured.

## Where things live

| Location | Holds | Survives a re-clone? |
| --- | --- | --- |
| repo `.git/config` | the whole identity for that clone | no |
| repo `.git/hooks/pre-push` | the guard | no |
| `%APPDATA%\repown\accounts.json` | name + email per account | yes |
| OS credential store | one credential per account | yes |
| global `.gitconfig` | `credential.helper`, and your default account | yes |
| `gh`'s `hosts.yml` | accounts and the active one (**CLI only, not git**) | yes |

On Linux and macOS the registry is `$XDG_CONFIG_HOME/repown` (default
`~/.config/repown`). `REPOWN_CONFIG_DIR` overrides it everywhere.

## FAQ

**A push asked me for a password.** Run `repown doctor`. Usually `gh auth setup-git`
made gh the credential helper, which serves only gh's *active* account; `repown fix`
hands the host back to the credential manager (it shows the undo first). If
`repown use` said "No stored credential yet", that first push signs in once and is
remembered from then on.

**The guard refused a push, but the commit is mine.** The guard compares each commit's
author *and* committer address with the clone's pinned email. A commit made before
`repown use`, or by an IDE with its own identity, carries the old address. For the
last commit, `git commit --amend --reset-author --no-edit` re-stamps it. For a few
commits, rebase onto the last good one with
`--exec "git commit --amend --reset-author --no-edit"`. If a foreign commit is
legitimate (a colleague's), this is a shared repo and the guard shouldn't be on
([The guard](#the-guard)).

**Pushes to my organisation's repo are refused.** An organisation is never an
account name. `repown use` and `repown` print the exact
`git config --local --add repown.allowOwner <org>` to run.

**My organisation uses SSO and the push failed with an authorization error.** A
credential can be valid and still not authorized for an SSO organisation. Nothing
can see that in advance ([residual risks](docs/DECISIONS.md#residual-risks-stated-plainly)).
Authorize that credential for the organisation on GitHub, then push again.

**Does it work with Azure DevOps or another host?** Commit identity and the guard
work on every host. Choosing the push credential per clone is GitHub-only for now.
Elsewhere it's left to whatever already serves that host ([Hosts](#hosts)).

## Development

```
npm install
npm test          # node's own test runner, no framework
npm run build     # tsc, also the typecheck
```

Developing needs Node 22.6+, even though running needs only 20
([§7](docs/DECISIONS.md#7-typescript-on-node-and-what-that-cost)). Zero runtime
dependencies, by choice. `demo/demo.tape` is a [VHS](https://github.com/charmbracelet/vhs)
script for a demo recording, run with `vhs demo/demo.tape`. It uses placeholder
identities in a throwaway sandbox. No GIF is committed yet, because VHS hasn't
rendered on the machines tried so far. [CLAUDE.md](CLAUDE.md) has the contributor rules;
[docs/DECISIONS.md](docs/DECISIONS.md) explains why every non-obvious choice was
made.

## License

[MIT](LICENSE)
