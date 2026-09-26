# FAQ

Short answers, each with where to read more. Every scenario, with diagrams, is in
[HOW-IT-WORKS.md](HOW-IT-WORKS.md).

**Contents:** [Compared with the alternatives](#compared-with-the-alternatives) ·
[Questions](#questions)

## Compared with the alternatives

| Approach | Right commit identity | Right push credential | Checked before push | Catch |
| --- | --- | --- | --- | --- |
| `git config user.email` by hand in each repo | yes, if you never forget | no | no | Forgetting once publishes the wrong address permanently |
| `includeIf "gitdir:~/work/"` in global config | yes, by folder | only if you also add the credential key per folder | no | Depends on where a repo happens to be cloned; a clone anywhere else inherits the default |
| SSH host aliases (`git@github-work:...`) | no | yes | no | Every remote URL has to be rewritten, and keys managed per account |
| `gh auth switch` | no | while gh is the helper, only the *active* account | no | Machine-wide: it breaks the other account's repos |
| **repown** | yes, per clone | yes, per clone (GitHub) | yes, once `repown guard on`: every commit the push would publish | `use` and `guard on` once per clone, or `repown setup` |

repown doesn't replace these tools. It writes plain repo-local git config, uses the
credential manager you already have, and leaves `gh` in charge of the GitHub CLI.

## Questions

**Does it change anything outside the clone?** Its own account registry, and two things
only on request: `repown fix` removes what `gh auth setup-git` added to git config, after
showing it, and `repown use --gh` switches gh's active account. Everything else is
repo-local.

**Azure DevOps, GitLab, SSH?** Commit identity and the guard work on any host. The
credential pin is measured only for GitHub over https, so elsewhere repown says the
credential isn't pinned rather than guessing
([card 3](HOW-IT-WORKS.md#3-pin-a-clone)).

**My teammates don't use it.** Nothing changes for them: repown writes nothing that gets
committed ([card 9](HOW-IT-WORKS.md#9-a-teammate-without-repown)).

**Can I skip the guard for one push?** `git push --no-verify`. That is also why the guard
is a safety net, not a lock
([SECURITY.md](../SECURITY.md#what-repown-protects-and-what-it-doesnt)).

**I ran `repown setup` again and it said "already set up". Is that right?** Yes: the clone
is pinned to that account exactly as recorded, git would use those settings, and nothing
else you asked for is left to do (the guard line shows whether the guard is on). Choose
**Done**, or **Apply the same settings again** to run `repown use` anyway
([card 13](HOW-IT-WORKS.md#13-guided-setup)).

**What does it send over the network?** Nothing of its own, and no telemetry. It runs
`git` and `gh`: gh may contact GitHub when repown asks for its accounts, and on a
terminal, `repown setup`, `repown use` or `repown accounts add` without `--name` and
`--email` asks gh for the account's public profile to suggest a name and noreply address.
