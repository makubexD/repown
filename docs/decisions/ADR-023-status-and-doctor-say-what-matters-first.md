# ADR-023: Status and doctor say what matters first

**Status:** Accepted

## Context

The audit behind [ADR-022](ADR-022-set-up-clone-opens-on-settled-screen.md) also read
`repown status` and `repown doctor` on a clone that was already pinned, with gh
active as another account.

Status printed the gh line, tagged WARN, before the OK identity line, then closed
with `ready: … · 1 warning (optional: gh)`. That line already says git pushes are
unaffected. Leading with it, and calling it a warning, made an optional CLI
mismatch look like the thing that was wrong.
[ADR-011](ADR-011-refuse-vs-warn.md) lists "gh active as another account" as a
warning because it affects `gh pr create`, never the push. "gh couldn't be
queried" is a different row: the answer is unknown, and a skipped check must not
look like one that passed.

Doctor printed Git Credential Manager's path with the operating system's
separators, while status printed the clone path with the forward slashes git
reports. It also printed a three-line SSO reminder on every healthy run, and then
stopped, with no line that said whether the machine was ready.
[ADR-013](ADR-013-deliberately-not-done.md) records why that reminder cannot be a
check: nothing offline can see SSO authorization, and the failure looks like a
bad token. [ADR-021](ADR-021-bare-repown-always-opens-setup.md) left both commands
unchanged on purpose. That note is what this decision revises.

The upstream field already says `set on the first push (push.autoSetupRemote)`.
It stays.

## Decision

- **gh acting as another account is a NOTE.** Same columns as WARN, on stderr,
  dim when that stream has colour and plain when it does not. The fix line stays.
  It is written after the identity line: the OK when the clone passes, the FAILs
  when it does not. It does not count as a warning.
- **A gh that could not be queried stays a WARN**, in its old place, and it still
  counts. The answer is unknown.
- **Status's closing line.** With only the note:
  `ready: commits and pushes use <account> · gh: optional (see the note above)`,
  or the same suffix on `ready: commits use <account>; pushes use this host's own sign-in`.
  With real warnings, the tally counts only those. With problems, the tally is
  unchanged.
- **Shown paths use one rule.** On Windows, native separators. Elsewhere, the
  string is unchanged. The helper is used for the clone path in status's header
  and the Git Credential Manager path in doctor. A path used for work is not
  rewritten.
- **The SSO reminder stays on the healthy diagnosis**, including when the store
  was read and is empty. It is not withheld until a push fails. It is one sentence,
  wrapped at the report's width, and it is the report's last line:
  `If a push fails although the account is stored, the org may need SSO authorization: authorize it in the org's SSO settings on <host>`.
  `<host>` is the origin's host, or github.com outside a clone.
  Any other host says `check <label>'s SSO settings`. The gh-helper and
  unknown-helper diagnoses do not add it; they already name their own problem.
- **Doctor closes the way status does**, a blank line then one line, on stderr:
  - Git Credential Manager, and the store holds an account:
    `ready: each clone signs in as its own account through Git Credential Manager`
  - Git Credential Manager, and the store was read and is empty:
    `ready · no accounts stored yet: the first push signs in once`
    (the WARN above it stays)
  - gh is the helper, which still exits 1:
    `1 problem: gh answers git's sign-in requests: run repown fix`
  - any other helper, including none:
    `unchecked: repown can't tell whether <helper> honours the per-clone pin`
    (`nothing` when no helper is set)

  A source that could not be read (the registry, the store, gh) keeps its WARN,
  and the verdict adds ` · N warning(s)`, so a ready line never hides an unknown.
- **Exit codes are unchanged.** Neither command has `--format json`
  ([ADR-014](ADR-014-json-for-scripts.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep the gh line a WARN and only print it under the OK | It would still tally as something wrong with a clone whose git is fine |
| Drop the gh line when the clone is otherwise ready | A skipped check must not look passed ([ADR-011](ADR-011-refuse-vs-warn.md)). The note is how it stays visible |
| Treat "could not be queried" as a note too | That answer is unknown. A note would look like advice |
| Print the SSO reminder only after a failure | The failure is when the hint is hardest to find. [ADR-013](ADR-013-deliberately-not-done.md) says it cannot be detected in advance, so it has to be there before |
| Print the SSO reminder on the gh-helper screen too | That screen's problem is gh, and the fix is `repown fix` |
| Show every path with forward slashes | Windows reads backslashes. The bug was the two commands disagreeing |
| Fold doctor's source warnings into the verdict | Those warnings already name the source. The verdict names the helper outcome |

## Consequences

- **ADR-011's row for gh active as another account is superseded in part.**
  Status notes it. The guard still ignores it. The row for a gh that could not
  be queried stays a warning.
- **ADR-020's closing tag `(optional: gh)` is superseded in part** by the note's
  own closing line. The upstream field, and the exit codes from that ADR, stand.
- **ADR-021's note that status and doctor stay unchanged is superseded in part.**
  Bare `repown` still opens setup in a terminal. Nothing in that routing changes.
- **Text layout is not a contract** ([ADR-014](ADR-014-json-for-scripts.md)).
  Exit codes are unchanged.
- **Where this is written up:** [card 5](../HOW-IT-WORKS.md#5-check-where-you-are)
  for status, [card 1](../HOW-IT-WORKS.md#1-set-up-the-machine) for doctor, the
  README sample, and CHANGELOG.
