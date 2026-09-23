# Decisions

Why `gid` is shaped the way it is. One decision per section: what was wanted,
what was rejected, and what it costs.

Most of this was established empirically — against `cli/cli` source, git's own
documentation, and live probes on a machine running two GitHub accounts and five
Azure Repos clones. Where something was measured, it says so. Where it was not,
it says that too.

---

## 1. Git credentials come from the credential manager. `gh` is for the CLI.

### The requirement

Authenticate once per account, then every repository works from anywhere with no
prompt — including after switching which account you are acting as.

### Why gh cannot meet it

`gh auth setup-git` installs gh as the git credential helper by writing two
entries per host:

```ini
[credential "https://github.com"]
    helper =                                      # EMPTY
    helper = !'…/gh.exe' auth git-credential
```

`gitcredentials(7)` defines the empty value as **resetting the helper list**, so
a perfectly good `credential.helper = manager` underneath is discarded and gh
becomes the only helper for that host.

In `pkg/cmd/auth/gitcredential/helper.go` the lookup is `ActiveToken(host)`. The
username git asks for is a **rejection filter, never a lookup key** — so gh
refuses rather than substitutes:

| git asks gh for | gh returns |
| --- | --- |
| the active account | that account |
| any other account | **nothing**, exit 1 — though its token is in the same keyring |
| no username | the active account |

That guard is byte-identical across every tag from v2.4.0 to v2.89.0.
Multi-account support (v2.40.0) added stored accounts **without** making the
helper account-aware. cli/cli **#8875** is open; PR **#13468**, which would have
added `--account`, was closed unmerged.

So while gh is the helper, every `gh auth switch` guarantees a password prompt
for every repository pinned to a different account. It is structural, not a
configuration mistake:

```
gh auth switch -u personal
git pull                    # in a work repo
    remote: Invalid username or token. Password authentication is not supported
    fatal: Authentication failed for 'https://github.com/...'
```

That is not a bad token. And for an account gated behind SSO, with no
traditional password, there is nothing to type at that prompt.

### Why a wrapper cannot paper over it

It is tempting to have a tool save and restore state around a switch. There is
no state to save. The other account's token is in gh's keyring the entire time;
gh declines to serve it because it is not active. Automating "switch → act →
switch back" still fails for anything done *while* switched, and reproduces the
manual dance rather than removing it.

### Why the credential manager does

Git Credential Manager stores one credential per account, keyed
`git:https://<user>@github.com`, and selects per repository from
`credential.<url>.username`. That is exactly "authenticate once, then it works
from anywhere" — its documented multi-account feature.

### The decision

Remove the two entries per host. `gid fix` does it, showing what it will remove
and the undo first, because a change to global config should be reviewable
rather than magic. `gh auth setup-git` puts them back exactly as they were.

**No switching is required for git at all.** Each clone authenticates as its own
account, permanently. `gh auth switch` becomes invisible to git and can be used
freely — which is why `gid` does not wrap it, and why `gid use --gh` merely
calls it rather than replacing it.

### What was rejected

| Option | Why not |
| --- | --- |
| gh as the helper | The above. Serves only the active account. |
| SSH with repo-local `core.sshCommand` | Viable and cryptographically stronger, but adds key management for machines that use no SSH. |
| A PAT in the remote URL | A live secret in `.git/config`. |
| Per-repo `GH_CONFIG_DIR` | Duplicates the whole gh config per repository to change one field. |

### The maintenance gotcha

Re-running `gh auth login` may offer to configure git credentials again, which
re-adds the two entries. Decline it. Both `gid` and `gid doctor` detect the
re-added helper and name the fix, so the setup cannot silently regress.

---

## 2. The guard verifies commits, not configuration

A wrong-account **push** is recoverable: the account is not a collaborator, so it
is a 403, and nothing is published.

A wrong-author **commit** is not. `user.email` is baked into the author and
committer fields; once pushed to a public repository it is in history, forks,
mirrors and scrapers permanently — and if that address is verified on the other
account, the host attributes the commit to it.

The design this replaced read the pushed ref range on stdin and **discarded it**,
asking instead "is the config right at this instant". That is a proxy. A commit
authored before setup, or on a branch where the identity was never applied,
passed cleanly as soon as the config was corrected afterwards.

So the guard reads its stdin and inspects the author **and committer** address of
every commit in the range being published — covering commits made before setup,
after `gid off`, on any branch, and those introduced by merge, rebase, cherry-pick
or an IDE, none of which a config check can see.

The range excludes what the remote already has (`--not --remotes=<remote>`). A
commit already on a remote-tracking ref made its addresses permanent when it was
first published; pushing it onto a second branch publishes nothing new. Without
the exclusion, a fork that merges upstream into its release branch is refused for
every upstream commit, one step after pushing those same commits to its mirror.
The cost: a stale remote-tracking ref (a branch deleted or force-pushed on the
server) can exclude a commit that is no longer really published, and
`git fetch --prune` corrects it.

It also refuses when `GH_TOKEN` or `GITHUB_TOKEN` is set, because those make gh's
helper set `gotUser = "x-access-token"` and skip its username check **entirely**;
and when `GIT_AUTHOR_EMAIL` or `GIT_COMMITTER_EMAIL` is set, because each
silently overrides the config just validated.

---

## 3. The hook calls the installed CLI, and refuses when it cannot

An earlier design copied the checker's modules into `.git/` at install time. That
bought branch-independence — the checker must not live in the working tree,
because a tool directory that exists only on one branch leaves every other branch
unguarded — but it cost two extra states:

- **stale**: a copy is missing, so the check cannot load;
- **drifted**: the copies are older than the tool they were taken from.

Calling an installed CLI removes both. There is only ever one implementation and
it is current by construction. The absolute path is baked into the hook at
install time, with a `PATH` lookup as a fallback, so neither a `PATH` change nor
a reinstall elsewhere can quietly disable it.

If both fail it **refuses**. A hook that cannot run its check is not a check, and
exiting 0 there is precisely how the previous design let five of six branches
push unguarded.

### Organisations are not accounts

The destination check compares the repository's owner against the pinned
account. An organisation's name is never an account name, so on its own that
check refuses every push to every organisation repository -- which is most
working repositories in most jobs, and would be discovered on the first push
rather than in review.

`gid.allowOwner` lists additional legitimate owners, per repository, explicitly.
Resolving organisation membership from the host API was the alternative and was
rejected: it puts a network call and an auth dependency in the pre-push path,
where a rate limit or an offline laptop turns into a failed push. An explicit
local list is offline, instant and readable.

Listing one owner does not widen anything else; every other owner is still
refused.

### The guard suits single-author repositories

It refuses any foreign author in the pushed range. In a repository where every
commit should be yours that is exactly right. In a shared one it is wrong:
pushing a branch that contains a colleague's commit is ordinary work, and a
guard that refuses ordinary work gets switched off -- taking the identity pin
with it.

So the guard is opt-in per clone rather than implied by `gid use`, and the
documentation says plainly where not to use it. The control that fits a shared
repository is a server-side ruleset on author addresses, enforced on receive.

### The mirror exemption is opt-in

A fork whose `master` only fast-forwards to upstream commits carries other
people's addresses legitimately, and `gid.mirrorBranch` exempts exactly that
branch. **Unset means no exemption.** The previous design's exemption was written
for one mirror branch and silently covered every feature branch as well; an
exemption that applies by default is how that happens.

---

## 4. There is no profile store

There used to be a JSON identity store with `capture` / `define` / `use` / `list`
/ `forget` / `restore` around it, to switch identity inside one clone.

Nothing needs that. **A clone belongs to one account, permanently.** What you
switch is the CLI's active account, which is a machine-wide mode and the CLI's
own business. The store solved a problem that does not arise, and reimplemented a
per-clone config store that git already provides.

Identity is now repo-local git config, set once. `.git/config` is exactly as
un-committable as the JSON file was, with none of the bespoke code.

### But the account registry is per machine, and that is different

`gid use <account>` needs a name and address. Looking those up from the host API
and then asking, in every repository, every time, is what makes a tool annoying
enough to go unused. So they are recorded **once per machine**, outside every
repository, in `accounts.json`.

That is not the profile store coming back. It holds no per-clone state and
switches nothing; it is a lookup table so the per-clone command can be one word.

---

## 5. No names or addresses live in any repository

A repository may be public, and anything committed to one is published
permanently. So the tool contains no identifiers: everything personal lives in
`.git/config`, which git cannot track, or in the per-machine registry.

That is also why setup is per machine and why a re-clone repeats it. A deliberate
cost, not an oversight — and the reason `gid scan` prints domains and counts
rather than addresses by default.

For GitHub, `gid use` suggests the account's noreply address
(`<login>@users.noreply.github.com`). It is publishable by design and still links
the commit to the account.

---

## 6. Hosts are a Strategy, and only claim what was measured

An author address is the same fact on every host, so commit pinning and the guard
are host-independent and work everywhere, including hosts no provider claims.

Credential pinning is not. It needs the host's credential model to be understood,
and a provider that guesses is worse than none: it writes config that **looks**
like configuration while selecting nothing.

| Host | Commit identity | Guard | Credential pinning |
| --- | --- | --- | --- |
| GitHub | yes | yes | yes — the mechanics in §1 |
| Azure DevOps | yes | yes | **no** |
| anything else | yes | yes | no |

### Why Azure DevOps is recognised but not pinned

It is recognised because leaving it to the generic provider would be **wrong**,
not merely incomplete. Its two URL forms disagree about the first path segment:

```
https://<org>.visualstudio.com/<project>/_git/<repo>    organisation is the SUBDOMAIN
https://dev.azure.com/<org>/<project>/_git/<repo>       organisation is the PATH
```

A generic "first segment is the owner" reports the *project* as the owner on the
legacy form — so the guard would compare the wrong thing and let a push to
another organisation pass.

Its credentials are left alone because what was probed did not support pinning:
`credential.https://dev.azure.com.usehttppath=true` ships in Git for Windows'
system config but does **not** apply to a `*.visualstudio.com` remote, and with
`credential.azreposcredentialtype=pat` the `azure-repos` GCM namespace is empty —
a PAT is stored against the generic credential key and never appears there.

Making it work is real work: the PAT and OAuth paths separated, each verified
against a live remote. Until then the provider claims only what was measured.
`src/core/hosts/azdo.ts` records the open questions.

---

## 7. TypeScript on Node, and what that cost

The predecessor was PowerShell, and the recommendation was to keep it: the logic
is subprocess orchestration and formatting, which no language does better, and
the pre-push hook needed only `sh` and `pwsh`, both guaranteed on a Windows git
machine.

The counter-argument that carried: an npm package (installed from the repository
today, with `npm install -g` once published) is a far better answer to "available
on every machine, in every project" than a shell module, and the hook's new
dependency mostly dissolves under npm distribution — a machine that installed the
tool has Node by construction. The hook runs the Node executable and CLI path
recorded at install time, falls back to `gid` on the `PATH` of the shell git
invokes hooks from, and refuses rather than passing if neither runs.

**The real cost was that ~900 lines of empirically-verified logic lost their
verification.** Not the code — the evidence. Each finding below was re-proven in
TypeScript before the PowerShell version was deleted:

| Finding | Re-proven by |
| --- | --- |
| An empty `credential.<url>.helper` resets the list | a test with that exact config shape, against real git |
| GCM is not on `PATH`; it ships inside Git's directory | resolved from PowerShell, where a `PATH` lookup fails |
| gh has a third state — "could not be queried" ≠ "no active account" | an error result callers cannot collapse into the empty case |
| The hook must be LF-only; `sh` rejects CRLF | a test asserting no carriage returns, plus `od` on the installed hook |
| `git config --get` exits 1 for "not set" — an answer, not an error | unit tests on the git wrapper |
| Guard scenarios A–E | the same matrix, run through the check against real repositories in a sandbox |

Zero runtime dependencies, deliberately. This reads credential configuration; the
smallest possible supply chain is part of that job.

### Strip-only TypeScript, and two Node versions

The source uses only TypeScript that type stripping can erase: no enums, namespaces
or parameter properties, and nothing that needs generated code. So every file runs
under bare `node` with no build step. That is why the tests import `src/` directly,
and why a change can be verified without compiling.

The cost is two different Node requirements. **Running `gid` needs Node 20;
developing it needs 22.6+.** The tests need type stripping, and `npm test` passes
a glob to `node --test`, which Node 20 does not expand (it reports
`Could not find 'test/*.test.ts'`). Neither applies to the published package,
which is compiled JavaScript. So `engines` stays at `>=20`, and CI's install job
proves that on Node 20 rather than assuming it.

---

## 8. What refuses, and what only warns

A condition can be reported at two severities by two commands without either
being wrong, because they answer different questions. The rule is **what is
irreversible**:

| | Refuses | Warns |
| --- | --- | --- |
| **Question** | Would this publish something that cannot be taken back? | Is something here not as it should be? |
| **Asked by** | the pre-push guard | `gid`, `gid doctor` |

A **commit** is irreversible once pushed. That is what the guard refuses over.

A **credential** problem is not: a wrong helper makes a push fail to
authenticate — loudly, immediately, with nothing published. Blocking the push
adds nothing the failure would not already say, and would refuse pushes that are
in fact perfectly safe.

| Condition | `guard check` | `gid` | Why |
| --- | --- | --- | --- |
| A commit in the pushed range has a foreign author | **refuse** | not its job | Irreversible once published |
| No identity pinned in this clone | **refuse** | **fail** | The next commit inherits the machine's identity |
| `GH_TOKEN` / `GIT_AUTHOR_EMAIL` set | **refuse** | — | Silently outranks the config just validated |
| Push destination is not this account's | **refuse** | **warn** | Wrong repository entirely; `gid` only warns because an organisation owner may simply need `gid.allowOwner` |
| gh is the git credential helper | — | **fail** | Cannot forge a commit; it only breaks authentication |
| gh active as another account | — | **warn** | Affects `gh pr create`, never the push |
| gh could not be queried | — | **warn** | Unknown, and said so rather than skipped |
| A foreign pre-push hook is installed | — | **warn** | Someone else's hook; left alone |

The rule this encodes: **a check that was skipped must never look like one that
passed.** Every "unknown" above is printed, never omitted.

---

## 9. Deliberately not done

| Not done | What it would fix | Why not |
| --- | --- | --- |
| **`includeIf "gitdir:…"` in global config** | The fresh-clone window: between `git clone` and `gid use`, a commit inherits the machine's identity. | It writes new identity behaviour into global config. `gid fix` only *removes* entries; this would add. The guard catches such commits at push time instead. |
| **A host-side ruleset restricting author and committer emails** | The only control `git push --no-verify` cannot bypass, since the host enforces it on receive. | A settings change per repository rather than per machine. Worth doing if `--no-verify` becomes a habit. |
| **A `pre-commit` hook** | Would catch a wrong-author commit as it is made. | Skipped by `commit --no-verify`, and by merge, rebase, cherry-pick and revert — partial cover for a risk the range check already covers completely. |
| **Rewriting existing history** | Commits already carrying the wrong address. | Destructive, and only the owner can weigh it. `gid scan` reports them; nothing rewrites them. |
| **Proactive SSO-authorization-state detection** | The incident this tool exists to prevent (§1, the SSO prompt with nothing to type): a credential that is valid but not yet SSO-authorized for an organisation looks identical to "fine" until the push/fetch that actually needs that org's resources fails — with no password to fall back on. | Measured directly, not assumed: `gh auth status --json hosts` (checked against gh v2.89.0's real output, and against `cli/cli`'s `pkg/cmd/auth/status/status.go` source on `trunk`) has exactly three `state` values — `success`, `timeout`, `error` — and `error` is set only when a call to resolve the token's login name fails, a general identity check that is never scoped to one organisation. SAML/SSO enforcement is enforced per-organisation on resource access, so nothing short of a request against that specific org's resources can observe it — the same rate-limit/auth dependency §3 already rejected for `gid.allowOwner`. Git Credential Manager's `diagnose` subcommand writes free-form logs for a human to read, not a field `gid` could parse. The signal exists only at the moment `git push`/`git fetch` actually hits the protected resource, and only in that command's own error text — reactive, not something a `doctor`-style check can see in advance. |

## Residual risks, stated plainly

- `git push --no-verify` skips the guard, as does any tool pushing through
  libgit2 rather than the `git` binary. Hooks are advisory by design.
- Environment variables outrank config. The guard refuses when it can **see**
  them set, which is a check, not a guarantee.
- A fresh clone has no hook until `gid guard on` runs.
- `gh pr create` and `gh api` act as gh's active account, and no git config
  affects them. `gid` warns when it differs; nothing can enforce it.
- Commits already made with the wrong author must be rewritten by hand.
- Credential pinning on a host with no provider is not done, and `gid` says so
  rather than implying otherwise.
- A credential that is valid but not SSO-authorized for an organisation looks
  identical to "fine" in `gid doctor`/`gid` right up until a push or fetch
  against that org's resources fails. Nothing pre-flights this.
