# Configuration

What you can set, where repown keeps things, and how to use it from scripts. None of this
is needed to get started: [README](../README.md#quick-start) covers that.

**Contents:** [Environment variables](#environment-variables) ·
[The account registry](#the-account-registry) · [Per-clone keys](#per-clone-keys) ·
[Scripts and CI](#scripts-and-ci) · [What repown writes](#what-repown-writes)

## Environment variables

| Variable | Effect |
| --- | --- |
| `REPOWN_CONFIG_DIR` | where the account registry lives |
| `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb` | colour off or on, as `repown --help` describes; with `NO_COLOR` or `FORCE_COLOR=0`, and always with `TERM=dumb`, `repown setup` asks with plain numbered choices |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` | not settings: the guard **refuses** a push while any is set, because they override the pinned identity or credential ([card 7](HOW-IT-WORKS.md#7-push-what-the-guard-checks)) |

## The account registry

One file, `accounts.json`, holding each account's name, email and host (no credentials).
Once one is recorded, `repown accounts list` prints its path:

| OS | Folder |
| --- | --- |
| Windows | `%APPDATA%\repown` |
| macOS, Linux | `$XDG_CONFIG_HOME/repown`, else `~/.config/repown` |

## Per-clone keys

`repown use` writes these repo-local keys and nothing else:

| Key | What it decides |
| --- | --- |
| `user.name`, `user.email` | who **authored** the commit |
| `repown.account` | whose clone this is; the guard checks the destination against it |
| `credential.<host>.username` | which stored credential serves the **push** (GitHub over https only) |
| `user.useConfigOnly` | git refuses to invent an identity from the hostname |

Three more repo-local keys widen what the guard accepts. They are opt-in and global config doesn't count.
`repown`, `repown use`, `repown setup`'s review and the guard's refusals print the
`git config` line for `allowOwner`, and the refusals a template for `allowTagger`;
`mirrorBranch` you set yourself (card 8).

| Key | Allows | Card |
| --- | --- | --- |
| `repown.allowOwner` | pushing to repositories another owner holds: an organisation you're in, or an account you collaborate with (`repown setup` asks about it) | [8](HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| `repown.allowTagger` | pushing another tagger's annotated tags (a fork pushing upstream's tags) | [8](HOW-IT-WORKS.md#8-push-refused-and-the-fix) |
| `repown.mirrorBranch` | a fork's branch that only fast-forwards to upstream: commits already on a remote stop counting there | [8](HOW-IT-WORKS.md#8-push-refused-and-the-fix) |

## Scripts and CI

**Nothing prompts without a terminal.** Record accounts with `repown accounts add
--name --email`, confirm `repown fix` with `--yes`, and give `repown setup` its answers as
flags with `--no-input`: every question not given as a flag counts as No.

```
repown setup octocat --guard --no-input
repown setup octo-work --allow-owner octo-org --guard --no-input
repown setup octo-work --name "Octo Work" --email octo-work@users.noreply.github.com --no-input
```

Without `--no-input` and without a terminal, `repown setup` exits `2` and names the flags
it would need. `--allow-owner` must name origin's owner, or it exits `2` with nothing
written. More in [card 13](HOW-IT-WORKS.md#13-guided-setup).

**JSON:** `repown scan --format json` and `repown accounts list --format json` print one
JSON document on stdout. Those fields are stable; the text layout isn't. Every field of
both is listed in [ADR-014](decisions/ADR-014-json-for-scripts.md):

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
| the clone's `.git/config` | `user.name`, `user.email`, `user.useConfigOnly`, `repown.account`, and `credential.<host>.username` on GitHub over https | `repown use` (and `setup`); removed by `repown off` |
| the clone's `.git/config` | `repown.allowOwner`, `repown.allowTagger`, `repown.mirrorBranch` | you (`setup` writes `allowOwner` when you say Yes) |
| the clone's `pre-push` hook (where git runs hooks) | the guard | `repown guard on`; removed by `repown guard off` |
| your user config folder | `accounts.json`: each account's name, email and host | `repown accounts add`, and `use` or `setup` for a new account |
| git config, whichever scope holds them | removes the credential-helper entries `gh auth setup-git` added | `repown fix`, after showing them; undo: `gh auth setup-git` |
| gh | its active account | `repown use --gh` (and `setup` when you say Yes) |
