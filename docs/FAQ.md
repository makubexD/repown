# FAQ

Short answers, each with where to read more. Every scenario, with diagrams, is in
[HOW-IT-WORKS.md](HOW-IT-WORKS.md).

**Contents:** [Compared with the alternatives](#compared-with-the-alternatives) ·
[Questions](#questions)

## Compared with the alternatives

| Approach | Right commit identity | Right push credential | Checked before push | Downside |
| --- | --- | --- | --- | --- |
| `git config user.email` by hand in each repo | yes, if you never forget | no | no | Forgetting once publishes the wrong address permanently |
| `includeIf "gitdir:~/work/"` in global config | yes, by folder | only if each folder's config also sets `credential.https://github.com.username` | no | Depends on where a repo happens to be cloned; a clone anywhere else inherits the default |
| SSH host aliases (`git@github-work:...`) | no | yes | no | Every remote URL has to be rewritten, and keys managed per account |
| `gh auth switch` | no | only gh's *active* account, while gh is git's credential helper | no | Machine-wide: it breaks the other account's repos |
| **repown** | yes, per clone | yes, per clone (GitHub over https; on SSH, your key decides) | yes, once `repown guard on`: every commit and tag the push would publish, and where it goes | one `repown setup` per clone |

repown doesn't replace these tools. It writes plain repo-local git config, uses the
credential manager you already have, and leaves `gh` in charge of the GitHub CLI.

## Questions

**Does it change anything outside the clone?** Only its account registry, plus `repown fix`
and `repown use --gh` when you ask ([full list](CONFIGURATION.md#what-repown-writes)).

**Azure DevOps, GitLab, SSH?** Commit identity and the guard work on any host. The
credential pin is measured only for GitHub over https, so elsewhere repown says the
credential isn't pinned rather than guessing
([card 3](HOW-IT-WORKS.md#3-pin-a-clone)). On Azure DevOps the owner is the organisation, so
allow it once per clone with `repown.allowOwner`. GitHub means github.com: GitHub Enterprise
Server hosts count as another host.

**Worktrees?** They share the clone's config and hooks, so one pin and one guard cover
every worktree.

**My teammates don't use it.** Nothing changes for them: repown writes nothing that gets
committed ([card 9](HOW-IT-WORKS.md#9-a-teammate-without-repown)).

**Can I skip the guard for one push?** `git push --no-verify`. That is also why the guard
is a safety net, not a lock
([SECURITY.md](../SECURITY.md#what-repown-protects-and-what-it-doesnt)).

**The guard refuses commits I made before pinning.** They still carry the address they
were made with. `repown use` warns, and `repown setup`'s review notes it, when the
current branch has commits no remote has by another address. Re-author it, or them:
`git rebase <base> --exec "git commit --amend --no-edit --reset-author --allow-empty"`
(`git rebase --root --exec "git commit --amend --no-edit --reset-author --allow-empty"` when that
commit has no parent), or pin that address when one address made them all. `<base>` is the short hash of the parent
of the oldest of those commits, so your own commits before it are left alone. If no remote-tracking ref reaches where the branch pushes
(a remote never fetched or still empty, one that pushes elsewhere than it fetches from, or a
URL), the warning says so, says how to fetch and count again where it can, and offers the
rebase only for when that destination has none of them: rebasing below what it already has
would rewrite published commits
([ADR-025](decisions/ADR-025-unpushed-advice-behind-an-unknown-destination.md)). Or run `repown reauthor`: it fetches first, rewrites only commits no remote has, keeps a backup ref and never pushes. Nothing else here rewrites history
([card 3](HOW-IT-WORKS.md#3-pin-a-clone), [card 8](HOW-IT-WORKS.md#8-push-refused-and-the-fix)).

**I ran `repown setup` again and it said "already set up". Is that right?** Yes, when the
clone already uses that account exactly as recorded and this run has nothing left to
write. It opens on that screen before any question. **Done** changes nothing. **Use
another account** continues at the account question. When gh acts as someone else, a
third option signs that account in to gh (`repown use <account> --gh`), or makes it gh's
active account when gh already lists it. A pin that would change nothing is left out, so
there is nothing to apply again. Bare `repown` in a terminal, inside a clone, opens
setup too, even when the clone is already pinned. A line inside setup's frame says the
clone isn't set up yet, or, when it is pinned, that setup is checking it
([card 5](HOW-IT-WORKS.md#5-check-where-you-are)). `repown status` shows the settings
without asking ([card 13](HOW-IT-WORKS.md#13-guided-setup)).

**I ran `repown` outside a clone. What happens?** In a terminal (stdin, stdout and
stderr), a start screen. It shows the accounts on this machine (or `could not read`
and the registry's path, or `N unreadable in <path>: run repown accounts list` when
the file has entries it cannot read), a line when gh serves git's credentials, and
the clones found up to 2 levels below. You can set one of those up, stop gh serving credentials, record an
account, check this machine, or show help. The summary is in the frame. The frame
closes with the command you pick, and then that command runs (Record an account first
asks the login, host, name and email in the frame). After recording an
account, checking the machine or stopping gh, the start screen comes back with a fresh
summary. Nothing changes until you pick one. Quit exits 0. Esc or Ctrl-C exits 130. With no clones below, it says to `cd` into a clone
(or `git clone` one), then run `repown`. With stdout redirected it prints the top help
and exits 0. Without a terminal on stdin or stderr it prints status and exits 1
([card 14](HOW-IT-WORKS.md#14-outside-a-clone),
[ADR-024](decisions/ADR-024-bare-repown-outside-a-clone-opens-a-start-screen.md)).

**Can I run it in CI or a script?** Yes, with flags instead of questions:
[Scripts and CI](CONFIGURATION.md#scripts-and-ci).

**Where are my accounts stored? Can I edit or delete them?** In one `accounts.json`
([where](CONFIGURATION.md#the-account-registry)); `repown accounts remove` forgets one.

**I use husky (or `core.hooksPath`).** `repown guard on` refuses there; call the check
from that tool's hook instead ([card 10](HOW-IT-WORKS.md#10-other-hook-tools)).

**What does it send over the network?** Nothing of its own, and no telemetry. It runs
`git` and `gh`: gh may contact GitHub when `repown`, `repown doctor`, `repown setup`,
`repown use` or `repown fix` asks for its accounts, and `use --gh` switches its account.
`repown use --gh` may run `gh auth login`, in a terminal only. For an account that isn't
recorded yet, on a terminal, `repown setup`, the start screen's Record an account,
`repown use` or `repown accounts add` (without both `--name` and `--email`) asks gh for
its public profile to suggest a name and noreply address. Setup, the start screen and
`accounts add` also ask whether that login exists and is a user, to warn about a typo or
an organisation. They read which accounts gh and Git Credential Manager are signed in as
(gh's own account list, and GCM's store on this machine) to say when the login isn't one
of them. `repown setup` may also ask GitHub whether origin's owner is a user or an
organisation.
