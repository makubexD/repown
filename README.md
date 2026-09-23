# gid

Pin a git clone to one account, and refuse to push commits that carry another
identity.

If you use more than one GitHub account on one machine — a work account and a
personal one — then every clone on that machine inherits whichever identity is
in your global config. That is fine until it isn't: a commit's author address is
baked into the commit object, and on a public repository it is permanent.

`gid` makes each clone say who it is, once, and then checks every push before it
leaves.

```
gid use octocat        # this clone is octocat's, permanently
gid guard on           # and nothing else gets pushed from it
```

## Why not just switch accounts

Because switching is the problem, not the solution.

`gh auth switch` changes which account the GitHub CLI acts as, machine-wide. If
the CLI is also your git credential helper — which `gh auth setup-git` makes it —
then switching breaks every repository belonging to the *other* account:

```
gh auth switch -u personal
git pull                    # in a work repo
    remote: Invalid username or token. Password authentication is not supported
    fatal: Authentication failed for 'https://github.com/...'
```

That is not a bad token. `gh auth git-credential` looks the token up by **host**
and serves only the **active** account; asked for any other it returns nothing
and exits 1, even though that account's token is sitting in the same keyring.
So while gh is the helper, every switch guarantees a prompt on the other side.

Git Credential Manager already does the right thing: one credential per account,
keyed `git:https://<user>@github.com`, chosen per repository from
`credential.<url>.username`. Hand the host back to GCM and **no switching is
needed at all** — each clone authenticates as itself, from anywhere, forever.

```
gid doctor      # what actually serves credentials here
gid fix         # undo `gh auth setup-git`, reversibly
```

`gh` keeps the job it is good at: it stays the account store, and `gh pr create`
and `gh api` keep working. It simply stops being involved in push and pull.

## Install

Needs Node 20+ and git. Windows, macOS and Linux. (Developing it needs Node
22.6+ — see below.)

Not on npm yet, so install from the repository:

```
git clone https://github.com/makubexD/gid.git
cd gid && npm install && npm run build && npm link
```

`npm link` puts `gid` on your PATH. To remove it again: `npm unlink -g gid`.

Once published, this becomes `npm install -g gid`. The package is written
publish-ready, and deliberately not published until the command surface has
settled.

## Use

### Once per machine

Record an account so you never have to type its details again:

```
$ gid accounts add octocat
OK    accounts   octocat  Octo Cat <octocat@users.noreply.github.com>

  Use it in any clone:  gid use octocat
```

With no `--name` / `--email` it asks, suggesting the account's public name and
its GitHub noreply address — which is publishable by design and still links the
commit to the account.

### Once per clone

```
$ gid use octocat
OK    identity   Octo Cat <octocat@users.noreply.github.com>  push-as:octocat

  No stored credential for "octocat" yet -- the first push signs in
  once, then never again. Verify it afterwards: gid doctor

  Next: gid guard on    (check every push before it leaves)
```

That writes four repo-local git config keys and nothing else:

| Key | What it decides |
| --- | --- |
| `user.name`, `user.email` | who **authored** the commit |
| `credential.<host>.username` | which stored credential serves the **push** |
| `user.useConfigOnly` | git refuses to invent an identity from the hostname |

All of it lands in `.git/config`, which git never tracks. Nothing is written to
the repository, which is what keeps a name or address out of a public one — and
also why it is per clone: a second machine, or a re-clone, runs it again.

You do not switch this afterwards, and you do not need to. `gid use <account> --gh`
also switches the CLI's active account, for when you want the two to agree.

### Any time

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

Three separate things decide who you are, and they fail differently. All three
are printed, because the one that is invisible is the one that catches people
out.

### Help, and exit codes

`gid --help` lists every command; `gid <command> --help` (or `gid help
<command>`) shows one command's own options, and for `guard` and `accounts`,
its actions — `gid guard on --help` goes one level deeper. Asking for help
never changes anything, no matter what the command itself would otherwise do.

Every command exits `0` on success, `1` on a failure or a refusal, and `2` on
a usage error — a missing account, an unknown option, or the like.

## The guard

```
gid guard on
```

Installs a `pre-push` hook that reads the refs git is about to push and checks
**the commits themselves**.

That distinction is the entire point. A config check answers "is the identity
right at this moment" — which a commit authored before setup, or on a branch, or
introduced by a merge, rebase, cherry-pick or an IDE, passes cleanly as soon as
the config is put right afterwards. The push is recoverable. The commit is not.

```
$ git push
FAIL  guard      1 commit(s) bound for refs/heads/main were not authored as octocat@users.noreply.github.com.
         fb201afcc  someone-else@example.invalid  not ours

       These addresses become permanent once pushed.

Push stopped by the gid identity guard (above).
Override this one push with: git push --no-verify
```

It also refuses:

- a push whose **destination** is owned by someone other than the pinned account,
  parsed as a URL — so `https://octocat@github.com/someone-else/repo` does not
  pass on its userinfo alone;
- `GH_TOKEN` / `GITHUB_TOKEN`, which make gh serve that token whatever account
  git asked for, skipping its own username check entirely;
- `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_EMAIL`, which silently override the
  identity the guard just validated;
- a clone with no pinned identity, because it cannot tell your commits from
  anyone else's;
- **itself being unrunnable.** If `gid` cannot be found, the hook refuses rather
  than exiting 0. A hook that cannot run its check is not a check.

### Two repo-local keys it reads

```
git config --local gid.mirrorBranch master        # a branch that mirrors someone else
git config --local --add gid.allowOwner An-Org    # another owner you may push to
```

**`gid.mirrorBranch`** — a fork whose `master` only ever fast-forwards to
upstream commits carries other people's addresses legitimately. This exempts
exactly that branch. Unset means **no exemption**, which is the safe default: an
exemption that applies by default is how guards end up covering one branch and
missing the ones that carry the actual work.

**`gid.allowOwner`** — repeatable. An organisation is never an account name, so
without this the destination check refuses every push to every organisation
repository, which is most repositories in most jobs. Listing one owner does not
open the door to any other. `gid` prints the exact command when it sees an owner
it does not recognise.

Organisation membership could have been resolved from the host API instead. It
deliberately is not: that would put a network call and an auth dependency in the
pre-push path, where a rate limit or an offline laptop becomes a failed push.

### When the guard is the wrong tool

It refuses **any** foreign author in a push. That is right for a repository where
every commit should be yours, and wrong for a shared one, where pushing a branch
containing a colleague's commit is ordinary work.

So on a team repository: `gid use` it, and leave the guard off. You still get an
explicit identity that cannot drift with your global config, and the credential
pin that makes multi-account work. The control that fits a shared repository is a
server-side ruleset on author addresses, which the host enforces on receive and
`--no-verify` cannot bypass.

## Auditing what you already have

```
$ gid scan ~/code ~/work

    repo                    owner       host    identity     guard   identities in history
    ------------------------------------------------------------------------------------
    personal-project        octocat     github  INHERITED    off     work.example=122
    work-service            acme        github  INHERITED    off     work.example=13655 +12 more
    the-fork                octocat     github  pinned       on      octocat.example=8 (excl. mirror)

  repositories     3
  not pinned       2
  not guarded      3
```

Domains and counts by default, never addresses — this is the sort of output that
gets pasted into a chat window. `--emails` opts in when you need the exact value.

The identity column is a **fact, not a verdict**: a shared repository
legitimately carries many addresses. What is worth acting on is a repository you
own whose history carries an address that is not yours — the first row above.

The guard stops new ones. It cannot undo commits that already exist.

## Hosts

| Host | Commit identity | Guard | Credential pinning |
| --- | --- | --- | --- |
| GitHub | yes | yes | yes |
| Azure DevOps | yes | yes | **no** — see below |
| anything else | yes | yes | no |

An author address is the same fact everywhere, so commit pinning and the guard
work on any host. Credential pinning needs the host's credential model to be
understood, and `gid` only claims the ones that were actually measured.

Azure DevOps is recognised — including that its two URL forms disagree about
what the first path segment means, so the organisation is read correctly from
both — but its credentials are deliberately left alone. `src/core/hosts/azdo.ts`
records exactly what was probed and what remains open.

Adding a host is one file implementing `HostProvider` and one line in
`src/core/hosts/index.ts`.

## Where things live

| Location | Holds | Survives a re-clone? |
| --- | --- | --- |
| repo `.git/config` | the whole identity for that clone | no |
| repo `.git/hooks/pre-push` | the guard | no |
| `%APPDATA%\gid\accounts.json` | name + email per account | yes |
| OS credential store | one credential per account | yes |
| global `.gitconfig` | `credential.helper`, and your default account | yes |
| `gh`'s `hosts.yml` | accounts and the active one — **CLI only, not git** | yes |

`GID_CONFIG_DIR` overrides the registry location. On Linux and macOS it follows
`XDG_CONFIG_HOME`, defaulting to `~/.config/gid`.

## Development

```
npm install
npm test          # node's own test runner, no framework
npm run build
```

**Running it needs Node 20. Developing it needs Node 22.6+.** Those are
genuinely different requirements and CI checks both. The tests import `src/*.ts`
directly, which needs type stripping, and `npm test` passes a glob to
`node --test`, which Node 20 does not expand — it reports
`Could not find 'test/*.test.ts'`. Neither applies to the published package,
which is compiled JavaScript, so `engines` stays at `>=20` and the CI install
job proves that on Node 20 rather than assuming it.

Zero runtime dependencies, by choice: this tool reads credentials configuration,
and the smallest possible supply chain is part of that job.

The source is **strip-only TypeScript** — no parameter properties, no enums, no
namespaces, nothing that needs code generated rather than types removed. So every
file runs under bare `node` with no build step, which is why the tests import
`src/` directly and why a change can be verified without compiling first.
