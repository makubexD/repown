# Changelog

Every release of repown, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change
commands. How a release is cut: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

### Added
- The start screen's **Remove an account**: pick a recorded account, read what stays
  (pinned clones keep their settings and the push guard), confirm, and it runs
  `repown accounts remove`; the menu then comes back, its summary one account fewer (ADR-028, its note).

### Changed
- The wizard (`repown setup`, and bare `repown` in a terminal) is easier to read in colour,
  with nothing to set: the title is a cyan badge, each summary value is bold cyan, the
  commands setup shows and runs are cyan, and setup's closing line leads with a green ✔ (done) or a yellow ▲ (the next push
  will fail). On a terminal that can't draw Unicode (Windows' console without a known terminal, or
  the Linux console), the marks are `+` and `!`. Without colour (a
  pipe, a log, `NO_COLOR`), the output is exactly as before
  (ADR-027).
- `repown accounts add <login>`, when it asks, warns when github.com has no account by that
  name (a typo) or the name is an organisation. It still records the account, and says nothing
  when GitHub can't be asked.
- The start screen's **Record an account** asks everything in its frame: the login, where
  it's hosted, and the commit name and email, prefilled from GitHub (name, noreply address), with Back on
  each. It then runs `repown accounts add` with every answer as a flag, so the bare `Commit
  name` / `Commit email` prompts are gone from it, and a login already recorded is refused as
  in setup. In setup and on the start screen, the name question first says when github.com
  has no account by that login, or it is an organisation, so a typo can be fixed before it
  is recorded.
- `repown accounts add` prints its suggested next command, `repown use <account>`, in
  cyan where stdout has colour, and exactly as before where it has none (ADR-027's rule).
- In setup and on the start screen, a new account's name question says when this machine
  is signed in to GitHub (gh, Git Credential Manager) as other accounts only: "signed in as
  octo-work, not octocat: if octocat isn't your account, go back; otherwise the first push
  asks you to sign in as it". A login that exists can still be a stranger's, and its noreply
  address would link your commits to them (ADR-028, its note).
- A new account's name and email questions say where their value came from: "GitHub shows
  no name for octocat, so this is the login" (a stranger's or an empty profile no longer
  passes unnoticed), and "prefilled with the private address GitHub gives octocat" instead
  of a `1234+` example beside the real address. The machine's identity reads "your default
  git name here is …: use it only if this account does too".
- A question's note (this clone's current account, what the history holds, what GitHub said
  about a login) is drawn inside that question, under its hint, instead of as a separate
  line above it that read as part of the previous answer. Plain prompts already did this.
- `repown status`, `doctor`, `scan`, the pre-push guard, the start screen's read of each clone and setup's first read start
  far fewer git processes: they read each config scope once instead of once per key
  (`repown status` in a clone: 68 processes became 38, about a third faster on Windows) (ADR-029).
- Commands setup and the start screen draw to copy start with `$ ` instead of `> `: pasted
  whole, `>` was a redirect in every shell and left an empty file named `repown` (ADR-027).
- After Record an account, Check this machine or Stop gh serving credentials, the start
  screen comes back with a fresh summary instead of exiting; Quit, Esc or Ctrl-C leave it
  (ADR-028).

### Fixed
- Commands repown prints to copy paste correctly in cmd and PowerShell as well as POSIX shells:
  a value with a space or an apostrophe is in double quotes (`--name "Octo Cat"`, on every OS),
  a GitHub noreply address and a URL are no longer quoted, a leading `@` and a dashed word with
  `.` or `:` are quoted (PowerShell read them as a splat, or split them), and the `--` before a
  dashed login is `"--"` (PowerShell dropped a bare one).
- A value no quoting keeps literal in every shell (`$`, a backtick, `"`, `%`, `!`, a curly double
  quote, a control character, an escaping backslash) no longer gets a single-quoted command:
  pasted into PowerShell or cmd, part of it ran as code. A remote's owner made of such text could
  do that through the guard's, `status`'s or `use`'s allow-owner advice. Repown now says to add
  it by hand, shows `[value not safe to paste]` in a command it runs itself, and prints the owner
  with control and bidi characters escaped.
- On a terminal that can't draw Unicode (classic Windows cmd), a text question's hint lines drew
  a `│` beside a gutter of `|`. They now use the same bar as the rest of the frame.
- "type < to go back" no longer breaks across two lines; when it doesn't fit after the hint, it
  takes a line of its own.

## [0.4.0] - 2026-09-30

### Added

- `repown reauthor [--yes]`: gives this branch's unpushed commits by another address
  the pinned identity. It fetches the push destination first, rewrites only commits
  no remote has (from the oldest one by another address), refuses on a merge in that
  range, uncommitted changes, identity overrides or a destination it can't fetch,
  runs without hooks, keeps a backup ref, prints the undo, and never pushes (ADR-026).
- `repown setup --repoint` and `--fetch`, which Recommended answers Yes where they
  apply. Repoint: where the branch pushes to a URL naming the same repository as a
  remote, setup points it back at that remote (`git config --local <key> <remote>`);
  the URL, which can carry a token, is never printed. Fetch: where commits by another
  address wait behind a remote never fetched, setup fetches it first (prompts off),
  so the count and the rebase advice are right; a failed fetch is a warning (ADR-026).
- `repown setup --reauthor`: where unpushed commits carry another address, setup
  asks (default No, in Recommended too) whether to re-author them as the account,
  and runs `repown reauthor --yes` as its last step. Like `fix`, Enter at the review
  is Decline and at the step is Skip. An already set-up clone offers **Re-author
  them** on its first screen (ADR-026).

### Fixed

- `repown use` and setup's review no longer advise `git rebase --root` for commits a
  never-fetched remote may already have. Where the branch's push destination has no
  remote-tracking refs, pushes elsewhere than it fetches from, or is a URL or a name with no
  remote, they say so, say how to fetch and count again where there is a remote to fetch,
  and offer the rebase only for when the destination has none of those commits. The URL
  is never printed (ADR-025).
- `repown setup` no longer says `done` when the next push would fail. It names what is in the way, first among the review's notes, on the already-set-up screen, and in its closing line (`set up for <account>; the next push will fail: …`): commits the guard will refuse, a sign-in in the push URL, identity or token variables, `author.email` in config, a destination owner, a diverged branch, a missing upstream, a detached HEAD (ADR-026).
- With the guard off, setup and status still name commits by another address, a destination owner and `GH_TOKEN`, but as a warning (`the guard is off, so …`): they no longer stop `done` or `ready` (ADR-026).
- `repown status` no longer says `ready` when the next push would fail. It prints what is in the way first among its warnings (`WARN push`), and ends `the next push will fail: …`; the exit code is unchanged (ADR-026).
- The re-author advice says `or pin that address` only when one address made them all.
- The suggested `git rebase` starts at the parent of the oldest commit by another address,
  not the oldest unpushed one, so your own commits before it are never rewritten.

## [0.3.0] - 2026-09-29

### Changed

- In a terminal, bare `repown` outside a clone, or in a bare repository, opens a
  start screen. It shows the accounts on this machine, whether gh serves git's
  credentials, and the clones found up to 2 levels below, then offers the next
  command. Nothing changes until you pick one. Quit exits 0; Esc or Ctrl-C exits
  130. With stdout redirected, a clone still prints status, and outside a clone it
  still prints help (exit 0). Without a terminal on stdin or stderr, it is still
  status.
- The start screen draws its summary inside its frame, and closes that frame with
  the command it is about to run. Show help closes with `> repown --help`, then
  prints the help. Inside a clone, bare `repown` draws its opening sentence inside
  setup's frame. Typing `<` at Record an account's login question returns to the menu.
- The start screen looks inside a directory whose `.git` git refuses, with the levels
  it has left, and does not search a bare repository for clones. Account names, and
  the folder in the title, show control characters as escapes.

## [0.2.0] - 2026-09-28

### Added

- `repown setup`: a guided setup of the clone you're in. It asks which account owns
  it (and records a new one), whether this clone may push to origin's owner, whether
  to turn the guard on, whether to push branches without `-u` (git 2.37+), whether to
  switch gh or sign the account in to gh, and whether to stop gh being git's
  credential helper (`fix`, machine-wide). The review lists only steps that would
  change something, nothing changes until you choose Run, and the run ends by listing
  what changed in the clone and on the machine.
  - **Recommended** (the default) asks only what it must and fills in the rest; the
    steps still show in the review, where you can change any answer. **Step by step**
    (`--step-by-step`) asks every question, then confirms each step (Yes, Skip or
    Stop) before running it.
  - The first question lists the accounts it can already see (origin's owner, gh's,
    Git Credential Manager's) and suggests the one that owns the repository.
  - Every question is also a flag, and `--no-input` runs it from a script. Exit
    codes: 0 done or already set up, 1 declined or can't start, 2 for flags that
    don't fit, 130 on Esc or Ctrl-C, and a failed step's own code.
  - A clone that is already set up opens on **This clone is already set up**, with
    Done, Use another account, and a gh option when gh acts as someone else.
  - In a plain terminal it asks with numbered choices.
- `repown use <account> --gh` signs the account in to gh when gh doesn't list it
  (in a terminal, gh 2.40 or later).
- `repown use` warns about commits on the branch that no remote has yet and that
  another address authored, which the guard would refuse, and prints the rebase that
  re-authors them. Setup's review notes the same.
- `repown guard on` warns when it runs from npx's cache, because the hook would call a
  temporary copy that later disappears.
- One optional runtime dependency, `@clack/prompts` 1.8.1, pinned and locked by the
  `npm-shrinkwrap.json` that now ships. Only `repown setup` loads it, never the
  pre-push hook; where it can't load, setup falls back to plain prompts.

### Changed

- In a terminal, bare `repown` in a clone always opens `repown setup`, set up or not.
  Outside a clone it shows help; without a terminal, or with output redirected, it
  still prints status, so scripts and CI get the report.
- `repown status` says what it shows: a title, the clone's path and branch, "This
  clone" and "This machine" groups, the branch's upstream, whether the account is
  recorded, and a closing count. The verdict comes first. gh acting as another
  account is an optional note, not a warning, and it names a gh fix that works.
- `repown doctor` shows each account's readiness for git and for gh, and ends with
  one verdict line. The SSO reminder is one sentence naming the host.
- On Windows, `status` and `doctor` show paths with backslashes.
- Docs: the README starts with `repown setup` and keeps what a new user needs.
  Configuration moved to docs/CONFIGURATION.md, and the FAQ and the comparison with
  other approaches to docs/FAQ.md. SECURITY.md explains private reporting.

### Fixed

- `repown help scan` said `--emails` dropped the counts; it keeps them and shows
  exact addresses instead of domains.

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

[Unreleased]: https://github.com/makubexD/repown/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/makubexD/repown/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/makubexD/repown/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/makubexD/repown/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/makubexD/repown/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/makubexD/repown/releases/tag/v0.1.0
