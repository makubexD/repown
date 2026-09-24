# ADR-012: Which pre-push hooks count as repown's, and where they are

**Status:** Accepted

## Context

A hook that repown can't prove it wrote may be someone else's check. Overwriting or
deleting it could quietly remove that check.

`core.hooksPath` moves the hooks git runs out of `.git/hooks`. Tools like husky and
git-secrets set it, and so does corporate tooling. A repown hook left in `.git/hooks`
would then read `on` while every push goes unchecked.

## Decision

- **A hook is repown's only if its second line starts with `# repown-identity-guard:`.**
  That's exactly where `guard on` writes it, right after the shebang. Every other hook is
  **foreign**, and `guard on` and `guard off` leave it alone. That includes:
  - a hook that merely mentions the marker;
  - one with repown's body pasted below lines of its own;
  - hooks from other identity tools.
- **State is read from `git rev-parse --git-path hooks`,** the directory git will actually run.
- **When that directory is elsewhere,** neither `guard on` nor `guard off` touches it. It
  belongs to another tool, or to every repository on the machine, where a pinned-identity
  hook would refuse pushes in clones that were never pinned.
  - `guard off` still removes a repown hook from `.git/hooks`, which would otherwise come
    back as soon as `core.hooksPath` is unset. If a repown hook is also in the redirected
    directory, `guard off` fails and names it rather than reporting `off`, because that
    one still runs.
  - To guard such a clone, have that tool's `pre-push` run
    `repown guard check --remote="$1" --url="$2"` and pass its stdin through.
- **Paths are compared as real paths,** so a symlinked `.git/hooks` isn't mistaken for a
  redirect.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Hardcode `.git/hooks` | Reports `on` while git runs another directory. |
| Install into the `core.hooksPath` directory | That directory may serve every repository on the machine. |
| `--path-format=absolute` | Needs git 2.31. Older git echoes the unknown flag back and exits 0, so a path nobody runs hooks from would look installed. |

## Consequences

- The hook is written LF-only, because `sh` rejects a CRLF script.
- `repown` reports a redirected hooks directory and prints the line to chain.
