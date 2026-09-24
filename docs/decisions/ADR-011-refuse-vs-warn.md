# ADR-011: The guard refuses only what's irreversible; the rest is a warning

**Status:** Accepted

## Context

The same condition can be reported at two severities by two commands, and neither is
wrong, because they answer different questions:

| | Refuses | Warns or fails |
| --- | --- | --- |
| **Question** | Would this publish something that can't be taken back? | Is something here not as it should be? |
| **Asked by** | the pre-push guard | `repown` (status); `repown doctor` covers the credential helper only |

A **commit** can't be taken back once pushed. A **credential** problem can: the push
fails to authenticate, loudly and at once, and nothing is published. Blocking it adds
nothing, and would refuse pushes that are actually safe.

## Decision

| Condition | `guard check` | `repown` | Why |
| --- | --- | --- | --- |
| A pushed commit has a foreign author or committer | **refuse** | — | Irreversible once published |
| A pushed annotated tag has a foreign tagger | **refuse** | — | Same. `git log` skips past the tag, so it's read separately; `repown.allowTagger` names upstream's taggers |
| No identity pinned in this clone | **refuse** | **fail** | The next commit inherits the machine's identity |
| A credential key is pinned but no account is | — | **fail** | Pushes fall back to the machine default |
| The pushed commits can't be read | **refuse** | — | An empty answer would read as "nothing foreign" |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_AUTHOR_EMAIL` or `GIT_COMMITTER_EMAIL` set | **refuse** | — | Quietly overrides the config just checked |
| Push destination isn't this account's | **refuse** | **warn** | `repown` only warns, because an organisation may just need `repown.allowOwner` |
| gh is the git credential helper | — | **fail** (also `doctor`) | Can't forge a commit; it only breaks authentication |
| The helper isn't GCM, or none is set, on a pinned clone | — | **warn** | The pin may select nothing |
| gh active as another account | — | **warn** | Affects `gh pr create`, never the push |
| gh couldn't be queried | — | **warn** | Unknown, and reported as unknown |
| Guard off, or a foreign pre-push hook installed | — | **warn** | Nothing checks the push; someone else's hook is left alone |

## Alternatives considered

| Option | Why not |
| --- | --- |
| Refuse on credential problems too | Blocks safe pushes, and the push itself would fail anyway. |

## Consequences

- **A check that was skipped must never look like one that passed.** Every "unknown"
  above is printed, never left out.
- In code, an answer like "gh couldn't be queried" is a `Result` (`src/core/result.ts`),
  never null or empty.
