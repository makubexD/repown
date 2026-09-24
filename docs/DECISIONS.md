# Decisions

Why `repown` is shaped the way it is. One decision per section: what was wanted,
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

Remove the two entries per host. `repown fix` does it, showing what it will remove
and the undo first, because a change to global config should be reviewable
rather than magic. `gh auth setup-git` puts them back exactly as they were. It
removes gh's value and the empty reset beside it, and only on a key that holds a
gh value. Any other helper configured for the host stays, because the undo would
never bring it back.

**No switching is required for git at all.** Each clone authenticates as its own
account, permanently. `gh auth switch` becomes invisible to git and can be used
freely — which is why `repown` does not wrap it, and why `repown use --gh` merely
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
re-adds the two entries. Decline it. Both `repown` and `repown doctor` detect the
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
after `repown off`, on any branch, and those introduced by merge, rebase, cherry-pick
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
a reinstall elsewhere can quietly disable it. The fallback trusts a `repown` only
if `repown --version` names it. A program that merely shares the name and exits 0
would otherwise pass every push unchecked.

If both fail it **refuses**. A hook that cannot run its check is not a check, and
exiting 0 there is precisely how the previous design let five of six branches
push unguarded.

### Organisations are not accounts

The destination check compares the repository's owner against the clone's
account, `repown.account`, which `repown use` writes on every host. It used to
come only from the credential key, which Azure DevOps, generic hosts and every SSH
remote don't have. There the check had nothing to compare and returned nothing,
silently. A check that can't run now says `destination not checked` in the guard's
output. An organisation's name is never an account name, so on its own that
check refuses every push to every organisation repository -- which is most
working repositories in most jobs, and would be discovered on the first push
rather than in review.

`repown.allowOwner` lists additional legitimate owners, per repository, explicitly.
It's read from the clone's own config only, and so is `repown.mirrorBranch`. A
global entry would silently widen every clone on the machine.
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

So the guard is opt-in per clone rather than implied by `repown use`, and the
documentation says plainly where not to use it. The control that fits a shared
repository is a server-side ruleset on author addresses, enforced on receive.

### The mirror exemption is opt-in

A fork whose `master` only fast-forwards to upstream commits carries other
people's addresses legitimately, and `repown.mirrorBranch` exempts exactly that
branch. **Unset means no exemption.** The previous design's exemption was written
for one mirror branch and silently covered every feature branch as well; an
exemption that applies by default is how that happens.

The exemption is narrower than skipping the branch. On the mirror branch, a commit
already on **any** remote-tracking ref, upstream's included, doesn't count, because
it's public already. A commit on no remote was made here, and it's still checked.
Skipping the branch outright let `git push origin feature:master` publish anything.
So fetch upstream before pushing the mirror. On such a clone, tag pushes use
the same wider exclusion for their commits; their taggers are still checked
(`repown.allowTagger`, §8). The known gap is a **private**
remote: a commit only a private remote carries isn't public, yet on the mirror
branch it doesn't count. Naming the upstream remote in its own key would close
that gap, but at the cost of one more setting for a case no user has.

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

`repown use <account>` needs a name and address. Looking those up from the host API
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
cost, not an oversight — and the reason `repown scan` prints domains and counts
rather than addresses by default.

For GitHub, `repown use` suggests the account's noreply address
(`<id>+<login>@users.noreply.github.com`, built from the account's numeric id). It is
publishable by design and still links the commit to the account. The id comes from
`gh api`, so the suggestion needs gh installed and signed in. Without that, the
prompt simply has no default.

---

## 6. Hosts are a Strategy, and only claim what was measured

An author address is the same fact on every host, so commit pinning and the guard
are host-independent and work everywhere, including hosts no provider claims.

Credential pinning is not. It needs the host's credential model to be understood,
and a provider that guesses is worse than none: it writes config that **looks**
like configuration while selecting nothing.

| Host | Commit identity | Guard | Credential pinning |
| --- | --- | --- | --- |
| GitHub | yes | yes | yes over https — the mechanics in §1. Not over SSH, where the SSH key decides and no helper is consulted |
| Azure DevOps | yes | yes | **no** |
| anything else | yes | yes | no |

### Why Azure DevOps is recognised but not pinned

It is recognised because leaving it to the generic provider would be **wrong**,
not merely incomplete. Its two URL forms disagree about the first path segment:

```
https://<org>.visualstudio.com/<project>/_git/<repo>    organisation is the SUBDOMAIN
https://dev.azure.com/<org>/<project>/_git/<repo>       organisation is the PATH
git@ssh.dev.azure.com:v3/<org>/<project>/<repo>         organisation follows v3/
<org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo> organisation follows v3/
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
while it stays unpublished) is a far better answer to "available
on every machine, in every project" than a shell module, and the hook's new
dependency mostly dissolves under npm distribution — a machine that installed the
tool has Node by construction. The hook runs the Node executable and CLI path
recorded at install time, falls back to `repown` on the `PATH` of the shell git
invokes hooks from, and refuses rather than passing if neither runs.

**The real cost was that ~900 lines of empirically-verified logic lost their
verification.** Not the code — the evidence. Each finding below was re-proven in
TypeScript before the PowerShell version was deleted:

| Finding | Re-proven by |
| --- | --- |
| An empty `credential.<url>.helper` resets the list | a test with that exact config shape, against real git |
| GCM is not on `PATH`; it ships inside Git's directory | probed by hand from PowerShell, where a `PATH` lookup fails; not covered by a test |
| gh has a third state — "could not be queried" ≠ "no active account" | an error result callers cannot collapse into the empty case |
| The hook must be LF-only; `sh` rejects CRLF | a test asserting no carriage returns, plus CI grepping the installed hook for `\r` |
| `git config --get` exits 1 for "not set" — an answer, not an error | unit tests on the git wrapper |
| Guard scenarios A–E | the same matrix, run through the check against real repositories in a sandbox |

Zero runtime dependencies, deliberately. This reads credential configuration; the
smallest possible supply chain is part of that job.

### Strip-only TypeScript, and two Node versions

The source uses only TypeScript that type stripping can erase: no enums, namespaces
or parameter properties, and nothing that needs generated code. So every file runs
under bare `node` with no build step. That is why the tests import `src/` directly,
and why a change can be verified without compiling.

The cost is two different Node requirements. **Running `repown` needs Node 20;
developing it needs 22.18+.** The tests need type stripping without a flag, which
22.18 was the first 22.x to ship. 22.6–22.17 strip types only behind
`--experimental-strip-types`, which `npm test` doesn't pass. And `npm test` passes
a glob to `node --test`, which Node 20 does not expand (it reports
`Could not find 'test/*.test.ts'`). Neither applies to the published package,
which is compiled JavaScript. So `engines` stays at `>=20`. CI's install job packs
the tarball, installs it on Node 20, and drives `accounts add`, `use`, `guard on`,
a real push the hook checks (one allowed, one foreign-authored and refused), and
`off`. The full suite runs on 22 and 24.

---

## 8. What refuses, and what only warns

A condition can be reported at two severities by two commands without either
being wrong, because they answer different questions. The rule is **what is
irreversible**:

| | Refuses | Warns |
| --- | --- | --- |
| **Question** | Would this publish something that cannot be taken back? | Is something here not as it should be? |
| **Asked by** | the pre-push guard | `repown`, `repown doctor` |

A **commit** is irreversible once pushed. That is what the guard refuses over.

A **credential** problem is not: a wrong helper makes a push fail to
authenticate — loudly, immediately, with nothing published. Blocking the push
adds nothing the failure would not already say, and would refuse pushes that are
in fact perfectly safe.

| Condition | `guard check` | `repown` | Why |
| --- | --- | --- | --- |
| A commit in the pushed range has a foreign author | **refuse** | not its job | Irreversible once published |
| A pushed annotated tag has a foreign tagger | **refuse** | not its job | Same: `git log` peels past the tag, so it's read separately. A fork names upstream's taggers in `repown.allowTagger`, because a tag sitting on a public commit may still have been made here |
| No identity pinned in this clone | **refuse** | **fail** | The next commit inherits the machine's identity |
| The pushed commits cannot be read | **refuse** | — | An empty answer would read as "nothing foreign"; a remote tip this clone never fetched is checked as a new branch instead |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_AUTHOR_EMAIL` or `GIT_COMMITTER_EMAIL` set | **refuse** | — | Silently outranks the config just validated |
| Push destination is not this account's | **refuse** | **warn** | Wrong repository entirely; `repown` only warns because an organisation owner may simply need `repown.allowOwner` |
| gh is the git credential helper | — | **fail** | Cannot forge a commit; it only breaks authentication |
| gh active as another account | — | **warn** | Affects `gh pr create`, never the push |
| gh could not be queried | — | **warn** | Unknown, and said so rather than skipped |
| No pre-push hook installed (guard off) | — | **warn** | Nothing checks the push |
| A foreign pre-push hook is installed | — | **warn** | Someone else's hook; left alone |

The rule this encodes: **a check that was skipped must never look like one that
passed.** Every "unknown" above is printed, never omitted.

---

## 9. Deliberately not done

| Not done | What it would fix | Why not |
| --- | --- | --- |
| **`includeIf "gitdir:…"` in global config** | The fresh-clone window: between `git clone` and `repown use`, a commit inherits the machine's identity. | It writes new identity behaviour into global config. `repown fix` only *removes* entries; this would add. The guard catches such commits at push time instead. |
| **A host-side ruleset restricting author and committer emails** | The only control `git push --no-verify` cannot bypass, since the host enforces it on receive. | A settings change per repository rather than per machine. Worth doing if `--no-verify` becomes a habit. |
| **A `pre-commit` hook** | Would catch a wrong-author commit as it is made. | Skipped by `commit --no-verify`, and by merge, rebase, cherry-pick and revert — partial cover for a risk the range check already covers completely. |
| **Rewriting existing history** | Commits already carrying the wrong address. | Destructive, and only the owner can weigh it. `repown scan` reports them; nothing rewrites them. |
| **Proactive SSO-authorization-state detection** | The incident this tool exists to prevent (§1, the SSO prompt with nothing to type): a credential that is valid but not yet SSO-authorized for an organisation looks identical to "fine" until the push/fetch that actually needs that org's resources fails — with no password to fall back on. | Measured directly, not assumed: `gh auth status --json hosts` (checked against gh v2.89.0's real output, and against `cli/cli`'s `pkg/cmd/auth/status/status.go` source on `trunk`) has exactly three `state` values — `success`, `timeout`, `error` — and `error` is set only when a call to resolve the token's login name fails, a general identity check that is never scoped to one organisation. SAML/SSO enforcement is enforced per-organisation on resource access, so nothing short of a request against that specific org's resources can observe it — the same rate-limit/auth dependency §3 already rejected for `repown.allowOwner`. Git Credential Manager's `diagnose` subcommand writes free-form logs for a human to read, not a field `repown` could parse. The signal exists only at the moment `git push`/`git fetch` actually hits the protected resource, and only in that command's own error text — reactive, not something a `doctor`-style check can see in advance. |

---

## 10. The name, and which hooks count as ours

**repown** is repo + own: each repo owns its identity, so any of several clones, on
any account, host or sign-in method, can be returned to without switching anything.
The name is also free on npm, which a shorter one often isn't.

A pre-push hook is repown's only if its second line starts with
`# repown-identity-guard:`, exactly where `guard on` writes it (right after the
shebang). Every other
hook is **foreign**, and `guard on` and `guard off` leave it alone. That includes a
hook that merely mentions the marker, one with repown's body pasted below lines of
its own, and hooks left by other identity tools, even ones that look similar.
Overwriting or deleting a hook we can't prove we wrote could silently remove
someone else's check.

The hook that counts is the one git will **run**. `core.hooksPath`, which husky,
git-secrets and corporate tooling set, moves that out of `.git/hooks`. A repown
hook left in `.git/hooks` would then read `on` while every push goes unchecked. So
the state is read from `git rev-parse --git-path hooks`. When that is anywhere
else, neither `guard on` nor `guard off` touches it. The directory belongs to
another tool, or to every repository on the machine, and a pinned-identity hook
there would refuse pushes in clones that were never pinned. `guard off` still
removes a repown hook in `.git/hooks`, which would otherwise come back the moment
`core.hooksPath` is unset. The paths are compared as real paths, so a
symlinked `.git/hooks` is not mistaken for a redirect. They are read without
`--path-format`, because that needs git 2.31. Older git echoes an unknown flag
back and exits 0, which would make a path nobody runs hooks from look installed.

---

## Residual risks, stated plainly

- `git push --no-verify` skips the guard, as does any tool pushing through
  libgit2 rather than the `git` binary. Hooks are advisory by design.
- Environment variables outrank config. The guard refuses when it can **see**
  them set, which is a check, not a guarantee.
- A fresh clone has no hook until `repown guard on` runs.
- `gh pr create` and `gh api` act as gh's active account, and no git config
  affects them. `repown` warns when it differs; nothing can enforce it.
- Commits already made with the wrong author must be rewritten by hand.
- Credential pinning on a host with no provider is not done, and `repown` says so
  rather than implying otherwise.
- A credential that is valid but not SSO-authorized for an organisation looks
  identical to "fine" in `repown doctor`/`repown` right up until a push or fetch
  against that org's resources fails. Nothing pre-flights this.
- **Submodules are separate clones.** A submodule has its own config and hooks. If it
  isn't pinned and guarded itself, `git push --recurse-submodules` (or
  `push.recurseSubmodules`) publishes its commits unchecked, while the
  superproject's guard reports `on`. `repown` warns when a clone has submodules;
  pin and guard each one like any clone.
- **"Already on the remote" is read from the remote-tracking refs.** With a
  `pushurl` pointing somewhere other than `url`, those refs describe the fetch
  side. A commit fetched from a private `url` is then excluded when pushing to a
  public `pushurl`. The same holds for a stale ref (`git fetch --prune` corrects
  it) and, on a mirror branch, for any private remote (§3).
- **A clone pinned before `repown.account` existed.** Older versions wrote
  `credential.<scheme>://<host>.username` for every remote, SSH included. The guard
  still reads that as the account when `repown.account` is missing, and `off`
  removes it. A clone with neither key (Azure DevOps, generic hosts) has no account
  to compare. The guard prints `destination not checked` until `repown use` runs
  again there.
- **git versions.** CI tests the runners' current git; older versions are not
  tested, and no minimum is claimed. `--path-format` (git 2.31) was removed
  because older git echoes an unknown flag back and exits 0. The test suite
  itself needs git 2.32 (`GIT_CONFIG_GLOBAL`).
