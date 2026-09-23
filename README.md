# gid

**Use several git accounts on one machine without ever switching.** Each clone
commits and pushes as its own account, so you can go from a work repo to a
personal one to a client one and every push is authenticated as the right
account. A push carrying the wrong identity is refused before it leaves.

```
gid doctor             # once per machine: is git's credential helper ready?
gid use octocat        # once per clone: this clone is octocat's
gid guard on           # refuse any push that carries another identity
```

## The problem

- Every clone inherits the identity in your global git config, and a commit's
  author address is permanent once pushed to a public repository.
- `gh auth switch` changes the account machine-wide. While `gh` is git's
  credential helper, every switch breaks the *other* account's repositories, and
  an SSO-only account has no password to type at the prompt.
  ([DECISIONS §1](docs/DECISIONS.md#1-git-credentials-come-from-the-credential-manager-gh-is-for-the-cli))

## How gid solves it

- **Pin each clone:** `gid use <account>` writes the commit identity and the push
  account into that clone's `.git/config`. It is set once and never switched.
- **One credential per account:** Git Credential Manager already stores one
  credential per account and picks it per clone. `gid doctor` checks that it is the
  helper, and `gid fix` hands the host back to it if `gh auth setup-git` took over.
  `gh` stays your account store for `gh pr create` and `gh api`.
- **Guard every push:** `gid guard on` installs a `pre-push` hook that checks the
  commits themselves, not just today's config.

## Install

Needs Node 20+ and git, on Windows, macOS or Linux. It is not on npm yet, so
install it from the repository:

```
git clone https://github.com/makubexD/gid.git
cd gid && npm install && npm run build && npm link
```

`npm link` puts `gid` on your PATH, and `npm unlink -g gid` removes it.

## Quickstart

**Once per machine**, check what serves your git credentials:

```
gid doctor      # names the fix if gh is the credential helper
gid fix         # only if doctor says so; shows what it removes and the undo first
```

**Once per clone:**

```
$ gid use octocat
OK    identity   Octo Cat <octocat@users.noreply.github.com>  push-as:octocat

  No stored credential for "octocat" yet -- the first push signs in
  once, then never again. Verify it afterwards: gid doctor

  Next: gid guard on    (check every push before it leaves)

$ gid guard on
```

The first time you use an account, `gid use` asks for its commit name and email,
suggesting the GitHub noreply address, and remembers them for every other clone.
To record an account up front instead, run `gid accounts add octocat`.

`gid use` writes four repo-local keys and nothing else:

| Key | What it decides |
| --- | --- |
| `user.name`, `user.email` | who **authored** the commit |
| `credential.<host>.username` | which stored credential serves the **push** |
| `user.useConfigOnly` | git refuses to invent an identity from the hostname |

`.git/config` is never tracked, so no name or address reaches the repository.
The same is true on a second machine or after a re-clone, where you run `gid use`
again.

## Day to day

**Moving between accounts needs no command.** `cd` into any pinned clone, then
commit and push. To see who a clone is, run `gid` (short for `gid status`):

```
$ gid

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
catches you out. `gid use octocat --gh` also switches gh to match.

**Re-point a clone** that now belongs to another account: `gid off` removes the
repo-local identity (global config is never touched), then `gid use <other>`.

**Audit every clone** you already have:

```
$ gid scan ~/code ~/work

    repo                    owner       host    identity     guard   identities in history
    ------------------------------------------------------------------------------------
    personal-project        octocat     github  INHERITED    off     work.example=122
    work-service            acme        github  INHERITED    off     work.example=13655 +12 more
    the-fork                octocat     github  pinned       on      octocat.example=8 (excl. mirror)
```

It shows domains and counts rather than addresses, because this output gets pasted
into chats; `--emails` shows the exact addresses. A shared repository legitimately
has many identities. The row worth acting on is a repository you own whose history
carries an address that isn't yours. The guard stops new ones; it cannot rewrite
history.

## Commands

| Command | What it does |
| --- | --- |
| `gid status` (or just `gid`) | the state of this repository and this machine |
| `gid use <account> [--gh]` | pin this clone to an account (`--name`/`--email` skip the registry) |
| `gid off` | unpin this clone, leaving global config alone |
| `gid doctor` | what serves credentials on this machine, and to whom |
| `gid fix [--dry-run] [--yes]` | undo `gh auth setup-git` so per-clone pins work again |
| `gid guard on \| off \| status` | install, remove or show the pre-push hook |
| `gid accounts list \| add \| rm` | the accounts this machine knows (name and email per account) |
| `gid scan <dir>... [--emails]` | audit every clone under a directory |

`gid --help` lists them, and `gid help <command>` shows one command's options.
Asking for help never changes anything. `--cwd <dir>` works on every command.
Exit codes: `0` success, `1` failure or refusal, `2` usage error.

## The guard

It reads the refs git is about to push and checks **the commits themselves**, so
it also catches a commit made before setup, on another branch, or brought in by a
merge, rebase or cherry-pick
([§2](docs/DECISIONS.md#2-the-guard-verifies-commits-not-configuration)).

```
$ git push
FAIL  guard      1 commit(s) bound for refs/heads/main were not authored as octocat@users.noreply.github.com.
         fb201afcc  someone-else@example.invalid  not ours

       These addresses become permanent once pushed.

Push stopped by the gid identity guard (above).
Override this one push with: git push --no-verify
```

It also refuses:

- a destination owned by someone other than the pinned account, parsed from the
  URL, so `https://octocat@github.com/someone-else/repo` doesn't pass on its
  userinfo;
- `GH_TOKEN` / `GITHUB_TOKEN`, or `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_EMAIL`,
  because each silently outranks the identity it just checked;
- a clone with no pinned identity;
- **itself being unrunnable.** If `gid` can't be found, the hook refuses rather
  than passing ([§3](docs/DECISIONS.md#3-the-hook-calls-the-installed-cli-and-refuses-when-it-cannot)).

Credential problems only warn: a failed authentication publishes nothing
([§8](docs/DECISIONS.md#8-what-refuses-and-what-only-warns)).

Two repo-local keys adjust it:

```
git config --local gid.mirrorBranch master        # a branch that only mirrors upstream
git config --local --add gid.allowOwner An-Org    # another owner you may push to (repeatable)
```

Unset `gid.mirrorBranch` means no exemption. An organisation is never an account
name, so organisation repositories need `gid.allowOwner`; `gid use` prints the
exact command when it sees an unknown owner.

**Leave the guard off on shared repositories.** It refuses *any* foreign author,
and pushing a colleague's commit is ordinary work there. `gid use` alone still
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
| `%APPDATA%\gid\accounts.json` | name + email per account | yes |
| OS credential store | one credential per account | yes |
| global `.gitconfig` | `credential.helper`, and your default account | yes |
| `gh`'s `hosts.yml` | accounts and the active one (**CLI only, not git**) | yes |

On Linux and macOS the registry is `$XDG_CONFIG_HOME/gid` (default
`~/.config/gid`). `GID_CONFIG_DIR` overrides it everywhere.

## Development

```
npm install
npm test          # node's own test runner, no framework
npm run build     # tsc, also the typecheck
```

Developing needs Node 22.6+, even though running needs only 20
([§7](docs/DECISIONS.md#7-typescript-on-node-and-what-that-cost)). Zero runtime
dependencies, by choice. [CLAUDE.md](CLAUDE.md) has the contributor rules;
[docs/DECISIONS.md](docs/DECISIONS.md) explains why every non-obvious choice was
made.
