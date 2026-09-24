# ADR-011: The guard refuses only what's irreversible; the rest is a warning

**Status:** Accepted

## Context

The same condition can be reported at two severities by two commands, and neither is
wrong, because they answer different questions:

| | Refuses | Warns or fails |
| --- | --- | --- |
| **Question** | Would this publish something that can't be taken back? | Is something here not as it should be? |
| **Asked by** | the pre-push guard | `repown` (status); `repown doctor` covers the credential helper and the account registry |

The guard also prints a note (⚪) when it cannot compare the destination: a skipped
check is said out loud, never passed silently.

A **commit** can't be taken back once pushed. A **credential** problem can: the push
fails to authenticate, loudly and at once, and nothing is published. Blocking it adds
nothing, and would refuse pushes that are actually safe.

## Decision

| Condition | `guard check` | `repown` | Why |
| --- | --- | --- | --- |
| A pushed commit has a foreign author or committer | **refuse** | — | Irreversible once published |
| A pushed annotated tag has a foreign tagger | **refuse** | — | Same. `git log` skips past the tag, so it's read separately; `repown.allowTagger` names upstream's taggers |
| No local `user.email` | **refuse** | **fail** | The next commit inherits the machine's identity |
| No local `user.name` (email set) | — | **fail** | Same; the guard compares emails only |
| A GitHub https clone with no push account pinned | — | **fail** | Pushes fall back to the machine default |
| The pushed commits, or a pushed tag, can't be read | **refuse** | — | An empty answer would read as "nothing foreign". A remote tip this clone never fetched (a force-push over someone else's push) is not unreadable: the push is checked as if the branch were new |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_AUTHOR_EMAIL` or `GIT_COMMITTER_EMAIL` set (non-empty) | **refuse** | — | Quietly overrides the config just checked |
| Push destination isn't this account's | **refuse** | **warn** | `repown` only warns, because an organisation may just need `repown.allowOwner` |
| gh is the git credential helper | — | **fail** (also `doctor`) | Can't forge a commit; it only breaks authentication |
| The helper isn't GCM, or none is set, on a GitHub https clone | — | **warn** (also `doctor`) | The pin may select nothing |
| gh active as another account | — | **warn** | Affects `gh pr create`, never the push |
| gh couldn't be queried | — | **warn** | Unknown, and reported as unknown |
| Guard off, a foreign pre-push hook, or `core.hooksPath` elsewhere | — | **warn** | Nothing checks the push; someone else's hook is left alone |
| The clone has submodules | — | **warn** | Each is a clone with its own identity and hook |
| No accounts recorded on this machine | — | `doctor` **warns** | `repown use` will have to ask |

## Alternatives considered

| Option | Why not |
| --- | --- |
| Refuse on credential problems too | Blocks safe pushes, and the push itself would fail anyway. |

## Consequences

- **A check that was skipped must never look like one that passed.** Every "unknown"
  above is printed, never left out.
- In code, an answer like "gh couldn't be queried" is a `Result` (`src/core/result.ts`),
  never null or empty.
