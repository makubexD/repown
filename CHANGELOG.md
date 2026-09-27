# Changelog

Every release of repown, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change
commands. How a release is cut: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

- `repown use` warns when the current branch has commits no remote has by another
  address: `N commits on <branch> not on any remote are by <addresses>; the guard
  will refuse them`, then `re-author it` (one commit) or `re-author them` (more):
  `git rebase <base> --exec "git commit --amend --no-edit --reset-author --allow-empty"`, or
  `git rebase --root --exec "git commit --amend --no-edit --reset-author --allow-empty"` when
  that history has no parent, or pin that address. `<base>` is the short hash of
  the parent of the oldest of those commits. Up to three addresses are named, then
  `and N more`. `repown setup`'s review notes the same fact, including in
  Recommended mode, and does not rewrite the commits. A detached HEAD is skipped.
  If the commits can't be read, the warning says so and gives no rebase command.
  The exit code is unchanged.
- After `repown setup` runs (Recommended or Step by step, including skips, Stop,
  a failed step, and **Apply the same settings again**), it prints what changed
  in this clone: `changed in this clone:` and one line per local key,
  `key: old -> new`, `(added)`, or `old -> (removed)`. `repown.allowOwner`
  lists the values added or removed. The guard is `push guard: off -> on`.
  When nothing in the clone changed, the line is `nothing changed in this clone`.
  Recording an account adds `changed on this machine:` and
  `this machine's account registry: added <account>`. A `use --gh` step that
  leaves that account active adds `gh: <account> is now gh's active account
  (every terminal)`. Only config values are shown.
- In Step by step, after Run, `repown setup` confirms each step before running it.
  It shows what the step changes (the config keys and values, or the gh action),
  why, and the command, then asks `Run this step?` (Yes / Skip / Stop). Enter is
  Yes, except for `fix`, where Enter is Skip. Skip leaves that step unchanged.
  Stop, or Esc, runs nothing further and lists the steps that were not run.
  `done: this clone is set up for <account>` is printed only when the pin ran;
  a skipped step is named with `skipped:`. Recommended mode is unchanged.
- `repown setup` starts by asking `How should setup work?`. Recommended (the default)
  asks for the account — and the host, name and email when the account is new — and
  fills in the push guard, push new branches without `-u`, and a gh switch when gh
  already lists the account. Those steps still appear in the review, and Change an
  answer can open them. When origin belongs to someone else, Recommended still asks
  whether this clone may push there (default Yes). A gh sign-in, which opens a
  browser, and `fix`, which changes the whole machine, are still asked, default No.
  Step by step asks every question. The flag is `--step-by-step`.
  `repown setup <account>` skips the mode question and uses Recommended, so a recorded
  account goes straight to the review when nothing else must be asked.
  `--step-by-step --no-input` exits 2.
  `--no-input` still answers an ungiven question No. A clone that is otherwise ready,
  where push new branches without `-u` was left off, counts as already set up and notes
  `repown setup --auto-upstream`.
- `repown setup` asks `Push new branches without -u?` (default Yes) when git is
  2.37.0 or newer and `push.autoSetupRemote` is not already true. Yes runs
  `git config --local push.autoSetupRemote true` in this clone only. The flag is
  `--auto-upstream`. With `--no-input`, leaving the flag off keeps the answer No.
  On older git, or when `git --version` cannot be read, the question is not asked
  and the review notes `git push -u origin <branch>`.
- `repown status` shows the branch's `upstream`: the tracked remote branch,
  `none yet: git push -u origin <branch>`, or `set on the first push
  (push.autoSetupRemote)`. Missing on a detached HEAD or with no remote, and
  never counted as a warning. With no problems it closes with
  `ready: commits and pushes use <account>` where credentials are pinned, or
  `ready: commits use <account>; pushes use this host's own sign-in` where they
  are not. Either way, ` · N warning(s)` follows when there are warnings, tagged
  `(optional: gh)` when every warning is about gh.
- `repown setup` offers to sign the account in to gh when gh doesn't already
  know it (default No). Yes runs `repown use <account> --gh` and opens a
  browser. If gh is left acting as another account, the review and the line
  after "done" say what's left: `gh auth switch -u <account>` when gh already
  lists it, otherwise `repown use <account> --gh`.
- In a terminal, `repown use <account> --gh` signs the account in to gh when gh
  doesn't list it. gh before 2.40.0 replaces an account, so that sign-in is
  refused until gh is upgraded. Outside a terminal there is no sign-in: repown
  says the account isn't signed in to gh and names `gh auth login`, then
  `repown use <account> --gh`.
- `repown status` names a gh fix that works. When gh already lists the account,
  the line is `gh auth switch -u <account>`, in gh's own spelling. When it
  doesn't, the line is `repown use <account> --gh`, which signs that account in.
- `repown doctor` says what it shows. The title is
  `repown doctor · how this machine signs in to git hosts`. "This machine" is
  the helper, Git Credential Manager and gh's active account. "Accounts" is one
  row per account repown, Git Credential Manager or gh knows: whether git has a
  sign-in for it, and whether gh does.

- In a terminal, bare `repown` in a clone that isn't set up starts `repown setup`.
  Outside a clone it shows help. Otherwise, and always without a terminal, it's status
  as before, so a script, CI or an alias still gets the report.
- `repown status` now says what it shows: a title, the clone's path and branch, "This
  clone" and "This machine" groups with the machine's default identity, whether the
  clone's account is recorded (a warning when its name or email drifted), a
  `repown setup` pointer for a clone that isn't set up, and a closing count of
  problems and warnings.

- New: `repown setup`, a guided setup of the clone you're in. It asks which account owns
  it (recording a new one), whether to switch gh, whether this clone may push to origin's
  owner (an organisation or a collaborator), whether to turn the guard on, and whether to
  stop gh being git's credential helper (machine-wide). It shows each step in plain words
  with its exact command, and changes nothing until you choose Run. A clone that is
  already set up says so and offers Done. In a plain terminal it asks with numbered
  choices.
- `repown setup` exit codes: 0 when done or already set up, 1 when declined or it can't
  start, 2 for flags that don't fit or no terminal without `--no-input`, 130 on Esc or
  Ctrl-C. A failing step
  stops the rest, lists what didn't run, and exits with that command's code.
- Every `repown setup` question is also a flag; add `--no-input` to run it from a script.
- `repown setup`'s first question lists the GitHub accounts it can already see (origin's
  owner, gh's, Git Credential Manager's) and suggests the one that owns the repository,
  never one it only found in gh or Git Credential Manager. An owner known to be an
  organisation is left out of the list, and an owner whose kind couldn't be checked is
  listed but not suggested. The machine's own identity is shown on the name and email
  questions, never filled in.

- Docs: the README starts with `repown setup` and keeps what a new user needs, with one
  table of commands ordered by when you run them; the configuration (environment
  variables, registry, per-clone keys, scripts and JSON) moved to docs/CONFIGURATION.md,
  and the FAQ and the comparison with other approaches to docs/FAQ.md. SECURITY.md
  explains how to report a vulnerability privately.
- `repown help scan`: `--emails` shows exact addresses instead of domains; the counts
  stay (the help said they went).
- `repown guard on` warns when it runs from npx's cache: the hook would call that
  temporary copy, and once that is deleted it refuses every push unless another repown
  is on PATH. Install globally, then run `repown guard on` again.
- One optional runtime dependency, `@clack/prompts` 1.8.1, for interactive prompts. It's
  pinned exactly, its tree is locked by the `npm-shrinkwrap.json` that now ships in the
  package, and only `repown setup` loads it; the pre-push hook never does. Where it can't
  load, `repown setup` asks with plain numbered prompts.

## [0.1.1] - 2026-09-25

- Fixed: `repown use -` (and `accounts add -`, `accounts remove -`, `scan -`) is a
  usage error again. 0.1.0 read the bare `-` as a name and pinned an account called
  "-".
- Unknown commands and actions now say which `repown help` to run.
- Published from GitHub Actions through npm trusted publishing, with provenance.

## [0.1.0] - 2026-09-25

- First release on npm: `npm install -g repown`.
- `repown use <account>` pins a clone to one account: repo-local `user.name`,
  `user.email`, `repown.account`, `user.useConfigOnly`, and the credential username
  where it was measured (GitHub; not Azure DevOps).
- `repown guard on | off | status` manages a `pre-push` hook that refuses commits
  authored or committed by anyone else, pushes to a foreign destination owner, and
  pushes with identity-overriding environment variables set.
- `repown status`, `repown doctor` and `repown fix` show and repair what serves
  credentials on the machine.
- `repown accounts list | add | remove` keeps the per-machine account registry.
- `repown scan` audits every clone under a directory; `--format json` is a stable
  contract for scripts.
- Runs on Node 20+ on Windows, macOS and Linux, with zero runtime dependencies.

[Unreleased]: https://github.com/makubexD/repown/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/makubexD/repown/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/makubexD/repown/releases/tag/v0.1.0
