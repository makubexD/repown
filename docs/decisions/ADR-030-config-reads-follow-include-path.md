# ADR-030: Config reads follow include.path, and fix edits the file that holds gh's entries

**Status:** Accepted. Supersedes ADR-029's "Includes" line.

## Context

A field report: `repown doctor` said gh was the credential helper, "Installed by
`gh auth setup-git`, in: ~/.gitconfig.local", and `fix: repown fix`. `repown fix` answered
"nothing to undo -- gh is not installed as a credential helper." Each re-run gave the same
two answers, so the user was stuck in a loop with no way out from repown.

`~/.gitconfig.local` was pulled in by `include.path` from `~/.gitconfig`. Measured on
git 2.50 with a global config that includes a file holding gh's pair:

| Command | Result |
| --- | --- |
| `git config --get-urlmatch credential.helper https://github.com` | gh: git applies the included file |
| `git config --show-origin --get-all <key>` (no scope) | both values, origin the included file |
| `git config --global --get-all <key>` | nothing, exit 1 |
| `git config --global --includes --get-all <key>` | both values |
| `git config --global --unset-all <key>` | exit 5, the included file unchanged |
| `git config --file=<included file> --unset-all <key>` | exit 0, and the helper underneath answers again |

git turns `include.*` off whenever a scope or file is named, unless `--includes` is passed
(git-config(1)). doctor reads without a scope, so it followed the include. `fix` read
each scope with `--global`, `--local` or `--system`, so it did not. ADR-029 copied that rule
into the snapshot so the snapshot would match a plain read. The wrong part was the rule
itself: a scope names where a value comes from, and git applies an included file under
the scope of the file that includes it. The same blind spot hid a `user.email` kept in an
included file from the machine default identity (`identity.ts`).

## Decision

- **Every scoped read passes `--includes`** (`Git.reading`, `src/core/git.ts`), and so does
  the snapshot's per-scope `--list -z`. A scoped read now returns what that scope
  contributes, includes and all, which is what git applies. Unscoped reads are unchanged,
  since git already follows includes there.
- **Writes are unchanged**: a scope's write goes to that scope's own file. A read of one
  file named outright (`--file=`) does not follow includes, so it sees only that file's values.
- **`repown fix` edits the file that holds gh's entries.** `planRepair` reads each scope
  once (`--show-origin --includes -z --get-regexp` over the github.com and gist.github.com
  helper keys) and plans one entry per (file, key) that holds gh's value. `repair` rewrites
  the key in that file (`--file=`). The preview names the file, because it may not be the
  one the user expects.
- `configOrigins` reads `-z`, so a value with a tab or a newline is parsed as git wrote it.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Pass `--includes` only in `fix` | The machine default identity had the same blind spot, and the next scoped read would too. One rule in one place is cheaper. |
| One effective `--show-origin --show-scope` read | `--show-scope` needs git 2.26. When older git rejected it, the failed read would come back as "nothing to undo", the very answer this ADR removes. Three reads work on any git that has includes. |
| Remove gh's entries with `--global --unset-all` and tell the user about included files | The command that should fix it would print instructions to fix it by hand. |
| Copy the included file's path from doctor's output | doctor already reads the origin. Duplicating that path logic in `fix` would let the two drift apart again. |

## Consequences

- `doctor`, `status`, `fix`, the start screen and setup now agree on gh's helper wherever
  git reads it.
- `fix` may edit a file other than `~/.gitconfig`, `.git/config` or the system file. That
  could be a dotfile under version control. The preview says which, and the confirmation
  comes after it.
- **Spawn budget:** setup's `planRepair` read went to the snapshot before (0 spawns). It
  now passes through to git, one read per scope (3 spawns, recorded in ADR-029's note).
  `fix` and the start screen make 3 reads where they made 6.
- A key in a file that both local and global include is planned once per scope that
  includes it. Rewriting it twice is harmless, since the second rewrite finds no gh value.
