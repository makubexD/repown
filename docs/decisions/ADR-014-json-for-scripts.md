# ADR-014: `--format json` is the contract for scripts; text is for people

**Status:** Accepted

## Context

`repown scan` and `repown accounts list` print aligned columns, a dashed rule, a
summary and advice on stdout. People read that well, but a script that pipes it into
`jq`, `awk` or `cut` breaks whenever a column widens or a line of advice changes. And
text can't tell "the history could not be read" apart from "the history is empty"
without parsing prose.

## Decision

- **`--format text|json` on the commands whose payload a script may read:** `scan` and
  `accounts list`. `text` stays the default, so nothing changes for people.
- **Only `json` is a stable contract.** Its field names and meanings don't change
  without a new ADR. The text layout can change at any time.
- **JSON is one document on stdout, and nothing else is.** Warnings and failures stay
  on stderr, as they do in text mode. Nothing found prints `[]`, never an empty stream.
- **Unknown is `null`, never a guess.** A `scan` history that couldn't be read is
  `history: null`; an empty one is `[]`. An owner that can't be read from the URL is
  `owner: null` with `remote: true`.
- **`scan` keeps its privacy default.** `history` holds `{ domain, count }` entries;
  only `--emails` turns them into `{ email, count }`. As in text, `count` is how often an
  address appears as author or committer across all refs, not a number of commits.

The fields:

| Command | Each element |
| --- | --- |
| `accounts list` | `account`, `name`, `email`, `host` (`github` when none was recorded) |
| `scan` | `repo` (relative to the scanned root), `path` (absolute), `remote`, `owner`, `host`, `identity` (`pinned` · `commits-only` · `inherited`), `guard` (`on` · `off` · `foreign`), `mirrorExcluded`, `history` |

## Alternatives considered

- **Tab-separated text.** It's enough for `cut`, but it can't carry `null`, and the
  privacy switch would change what a column means.
- **JSON on every command.** `status` and `doctor` report checks rather than data. Their
  answer to a script is the exit code, so JSON can wait until someone needs it.

## Consequences

- Renaming or removing a JSON field is a breaking change. Adding one is not.
- `test/cli.test.ts` locks both shapes, including `[]` for nothing found.
