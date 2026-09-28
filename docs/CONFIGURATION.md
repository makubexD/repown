# Configuration

What you can set, where repown keeps things, and how to use it from scripts. None of this
is needed to get started: [README](../README.md#quick-start) covers that.

**Contents:** [Environment variables](#environment-variables) ·
[The account registry](#the-account-registry) · [Per-clone keys](#per-clone-keys) ·
[Scripts and CI](#scripts-and-ci) · [What repown writes](#what-repown-writes)

## Environment variables

| Variable | Effect |
| --- | --- |
| `REPOWN_CONFIG_DIR` | the folder that holds `accounts.json`, on any OS; overrides the [default](#the-account-registry) |
| `NO_COLOR` | a non-empty value turns colour off |
| `FORCE_COLOR` | colour even when output isn't a terminal; `0` or `false` turns it off. Wins over `NO_COLOR` and `TERM` |
| `TERM=dumb` | colour off (unless `FORCE_COLOR`) |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` | not settings: the guard **refuses** a push while any is set to a non-empty value, because the email variables override the pinned identity and the token variables make gh serve that token ([card 7](HOW-IT-WORKS.md#7-push-what-the-guard-checks)) |

`repown setup` asks with plain numbered choices instead of arrow-key lists when colour is
off on stderr (`NO_COLOR` without `FORCE_COLOR`, or `FORCE_COLOR=0`/`false`), always with
`TERM=dumb`, and when the optional prompt library can't load.

## The account registry

One file, `accounts.json`, holding each account's name, email and host (no credentials).
Once one is recorded, `repown accounts list` prints its path:

| OS | Folder |
| --- | --- |
| Any, when set | `$REPOWN_CONFIG_DIR` |
| Windows | `%APPDATA%\repown` |
| macOS, Linux (and Windows without `%APPDATA%`) | `$XDG_CONFIG_HOME/repown`, else `~/.config/repown` |

On macOS and Linux the file is readable by you only (on Windows, your user folder's
permissions apply). repown never overwrites one it can't read; fix or
delete it, and saving works again.

## Per-clone keys

`repown use` writes these repo-local keys and nothing else:

| Key | What it decides |
| --- | --- |
| `user.name`, `user.email` | who **authored** the commit |
| `repown.account` | whose clone this is; the guard checks the destination against it |
| `credential.https://github.com.username` | which stored credential serves the **push** (GitHub over https only) |
| `user.useConfigOnly` | git refuses to invent an identity from the hostname |

Three more keys widen what the guard accepts. They are optional and count only in this
clone's own config, never global. repown prints the exact `git config` line when you need
`allowOwner` (from `repown`, `use`, the setup review, or a refusal) or `allowTagger` (from
a refusal); `mirrorBranch` you set yourself.

| Key | Value | Allows | Card |
| --- | --- | --- | --- |
| `repown.allowOwner` | an owner login; add one line each (`--add`) | pushing to repositories another owner holds: an organisation you're in, or an account you collaborate with (`repown setup` asks about it) | [8](HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| `repown.allowTagger` | an email address; one line each | pushing another tagger's annotated tags (a fork pushing upstream's tags) | [8](HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| `repown.mirrorBranch` | one branch name | a fork's branch that only fast-forwards to upstream: there, and on tag pushes, commits already on any remote (upstream included) stop counting | [8](HOW-IT-WORKS.md#8-push-refused-and-the-fix) |

`push.autoSetupRemote` is git's own key, from git 2.37. `repown setup` may set it to
`true` in this clone only (`git config --local push.autoSetupRemote true`), so the first
`git push` of a branch without an upstream sets that upstream and creates the branch on
origin. It does not change what the guard checks. When the effective value is already
true, from any scope, setup leaves it alone. The flag is `--auto-upstream`.

## Scripts and CI

**Nothing prompts without a terminal** (stdin and stderr must both be one, so
`repown setup 2>log` counts as none). Record accounts with `repown accounts add --name
--email`, confirm `repown fix` with `--yes`, and give `repown setup` its answers as flags
with `--no-input`. Yes/no questions you don't pass as a flag are answered No; the account
must be given, with `--name` and `--email` if it isn't recorded yet (`--host` defaults to
origin's). There's no review. Re-running is safe once the account is recorded: drop
`--name`, `--email` and `--host` then, or it exits `2`.

```
repown setup octocat --guard --auto-upstream --no-input
repown setup octo-work --allow-owner octo-org --guard --no-input
repown setup octo-work --name "Octo Work" --email octo-work@users.noreply.github.com --no-input
```

Nothing is written when `repown setup` refuses:

- **exit `2`:** no terminal and no `--no-input` (it names the flags it needs); no
  `<account>`, or a new one without `--name`/`--email`; `--name`/`--email`/`--host` for an
  account already recorded; `--allow-owner` that isn't origin's owner;
  `--step-by-step` together with `--no-input` (step by step needs a terminal).
  `--no-input` does not use Recommended's Yes answers.
- **exit `1`:** not in a clone; an unreadable registry; `--guard` where another tool owns the hook or
  `core.hooksPath` points elsewhere. `--fix` when gh isn't the helper is dropped with a note.

Other commands without a terminal: `repown use` of an unrecorded account exits `1` (record
it first, or pass `--name` and `--email`), and `repown fix` without `--yes` exits `1` when it has something to remove. For
checks, `repown` exits `1` when something is wrong (a fresh CI clone is never pinned, so
it always does there), and `repown doctor` when gh is the credential helper. More in [card 13](HOW-IT-WORKS.md#13-guided-setup).

**JSON:** `repown scan --format json` and `repown accounts list --format json` print one
JSON document on stdout (warnings still go to stderr; nothing found prints `[]`). Scripts
should read JSON: its field names don't change without a major version, while the text
layout may. `scan`'s fields are `repo`, `path`, `remote`, `owner`, `host`, `identity`,
`guard`, `mirrorExcluded` and `history` (`{domain, count}`, or `{email, count}` with
`--emails`; `null` when unread); details in
[ADR-014](decisions/ADR-014-json-for-scripts.md):

```
$ repown accounts list --format json
[
  {
    "account": "octocat",
    "name": "Octo Cat",
    "email": "octocat@users.noreply.github.com",
    "host": "github"
  }
]
```

## What repown writes

Everything, in one place. Nothing here is committed or pushed.

| Where | What | Written by |
| --- | --- | --- |
| the clone's `.git/config` | `user.name`, `user.email`, `user.useConfigOnly`, `repown.account`, and `credential.https://github.com.username` on GitHub over https | `repown use` (and `setup`); removed by `repown off` |
| the clone's `.git/config` | `repown.allowOwner`, `repown.allowTagger`, `repown.mirrorBranch` | you (`setup` writes `allowOwner` when you say Yes) |
| the clone's `.git/config` | `push.autoSetupRemote` | `repown setup`, when you say Yes, in this clone only (git 2.37+) |
| the clone's own hooks folder: `pre-push` | the guard (`guard on` refuses if `core.hooksPath` points elsewhere: [card 10](HOW-IT-WORKS.md#10-other-hook-tools)) | `repown guard on`; removed by `repown guard off` |
| your user config folder | `accounts.json`: each account's name, email and host | `repown accounts add` and `remove`; `use` or `setup` when they ask for a new account |
| git config, whichever scope holds them | removes the credential-helper entries `gh auth setup-git` added | `repown fix`, after showing them; undo: `gh auth setup-git` |
| gh | its active account | `repown use --gh` (and `setup` when you say Yes) |
