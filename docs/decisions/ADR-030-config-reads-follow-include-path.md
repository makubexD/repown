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

- **A global or system read passes `--includes`** (`Git.reading`, `followsIncludes`,
  `src/core/git.ts`), and so does that scope's snapshot `--list -z`. Such a read returns
  what the scope contributes, includes and all, which is what git applies. Unscoped reads
  are unchanged, since git already follows includes there.
- **A local read stays bare.** A clone's `include.path` can name a file the repository
  tracks (`git config --local include.path ../.gitconfig` is common). Following it would
  let committed content set `repown.allowOwner`, `repown.mirrorBranch`, `repown.allowTagger`
  or the pinned identity as if this clone had, which would loosen the guard (ADR-011). It
  would also break `pinHolds` (two values, never held) and `off` (unset reports removed while
  the included value stays). The global and system files, and what they include, are the
  user's own.
- **Writes are unchanged**: a scope's write goes to that scope's own file. A read of one
  file named outright (`--file=`) does not follow includes, so it sees only that file's values.
- **`repown fix` edits the file that holds gh's entries.** `planRepair` reads each scope
  once (`--show-origin -z --get-regexp` over the github.com and gist.github.com helper
  keys, includes followed for global and system) and plans one entry per (file, key) that
  holds gh's value. `repair` rewrites a global or system key in its file (`--file=`, an
  absolute origin), and a local key through `--local`: git prints the local origin relative
  to the worktree (`.git/config`), and `--file=` would resolve that against the cwd, so a
  run from a subdirectory would fail. The preview names the file, because it may not be the
  one the user expects.
- `configOrigins` reads `-z`, so a value with a tab or a newline is parsed as git wrote it.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Pass `--includes` only in `fix` | The machine default identity had the same blind spot, and the next global read would too. One rule in one place is cheaper. |
| `--includes` on every scope, local too (this branch's first version) | A review found that a tracked file behind a local include could set the guard's keys, and that `--file=` with a relative local origin fails from a subdirectory. Both were measured on git 2.50. |
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
- A file that both global and system include is planned once per scope, so its preview
  repeats. Rewriting it twice is harmless, since the second rewrite finds no gh value.
- gh's pair in a file a clone's local config includes is seen by doctor (an unscoped read)
  and not by `fix`. That is deliberate: such a file may be tracked, and `fix` doesn't edit
  repository content. gh never writes there itself.
