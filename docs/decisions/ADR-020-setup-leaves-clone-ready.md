# ADR-020: Setup leaves the clone ready to work, in one of two modes

**Status:** Accepted

## Context

In a real run, setup pinned a clone completely: name, address, `useConfigOnly`,
`repown.account`, the credential username, and the guard. The next `git push` on a
new branch still failed, with git's own `The current branch <b> has no upstream branch`.
That isn't an identity problem, but it read as unfinished setup. Status then ended
with `1 warning` for gh's active account, which [ADR-011](ADR-011-refuse-vs-warn.md)
already classes as advice that never affects the push.

The same clone held 24 unpushed commits by two other addresses. After the pin, the
guard would have refused every one. Nothing said so before the push.

The user asked for one run that leaves everything working. It should show what it will do
and what it changed, offer a manual mode that explains each change, and switch to an account
from an earlier setup without questions.

## Decision

- **Setup's first question is the mode.** `How should setup work?` offers
  *Recommended* (the default) and *Step by step*. The flag is `--step-by-step`. The
  choice is not stored ([ADR-007](ADR-007-no-profile-store.md)).
  - Recommended asks only for the account (and, for a new one, host, name and
    address). The questions that change only this clone and need nothing only the
    user knows take their recommended value: guard on, push new branches without
    `-u`, and a gh *switch* when gh already lists the account. Each of these is a step
    in the review, so nothing is hidden, and the review is still the one confirmation.
  - Three questions are asked in both modes. The gh sign-in opens a browser
    ([ADR-019](ADR-019-repown-signs-accounts-in-to-gh.md)), and `fix` changes the whole
    machine ([ADR-013](ADR-013-deliberately-not-done.md)); their defaults stay No.
    Letting the clone push to an origin owner that isn't the account is a fact only
    the user knows (membership or collaboration), and it is the guard's check that the
    chosen account matches the repository ([ADR-004](ADR-004-destination-owner.md)):
    answering it silently would let a wrong account choice through. It keeps its
    default Yes, and is always asked.
  - Step by step asks every question. After the review, before each step, it shows
    the config keys and values the step writes (or the gh action), why, and the
    command, then asks `Run this step?` with Yes / Skip / Stop.
  - `--no-input` keeps its meaning: an unanswered question is No.
    `--step-by-step --no-input` is a usage error.
- **Setup offers `push.autoSetupRemote=true`, in this clone only.** The question is
  `Push new branches without -u?`, default Yes, and the flag is `--auto-upstream`.
  The step is the ordinary command
  `git config --local push.autoSetupRemote true`, like `repown.allowOwner`. The
  setting exists from git 2.37.0. On older git, or when `git --version` can't be read,
  the question isn't asked and the review notes the `git push -u` form instead. When the
  effective value is already true, from any scope, nothing is asked or written. The
  guard is unaffected: the hook reads the same pushed range either way.
- **After a run, setup lists what changed.** It reads the clone's keys before and
  after: `user.name`, `user.email`, `user.useConfigOnly`, `repown.account`, each
  provider credential key, `repown.allowOwner`, `push.autoSetupRemote`, and the guard
  state. It prints `changed in this clone:` with `key: old -> new`, or
  `nothing changed in this clone`, and names a gh switch or sign-in. Only config
  values are shown, never credential output.
- **Status shows the branch's upstream and says when the clone is ready.**
  - The `upstream` field is informational, never a warning:
    - `origin/<b>`
    - `none yet: git push -u origin <b>`
    - `set on the first push (push.autoSetupRemote)`
    - absent on a detached HEAD or with no remote
  - With no problems, the closing line is `ready: commits and pushes use <account>`
    where credentials are pinned. Where `credentialKeys()` is empty, it is
    `ready: commits use <account>; pushes use this host's own sign-in`
    ([ADR-009](ADR-009-hosts-claim-only-measured.md)): a push identity is claimed
    only where it was measured. Warnings follow, and when every warning is about gh
    they are tagged `(optional: gh)`. The severities of ADR-011 and the exit codes
    are unchanged.
- **Pinning names unpushed commits by another address.** When commits on the current
  branch that no remote has carry an author or committer other than the pinned
  address, setup's review and `repown use` say how many, by whom, and that the guard
  will refuse them. This is a warning, never a refusal; rewriting history stays the
  owner's call ([ADR-013](ADR-013-deliberately-not-done.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Set `push.autoSetupRemote` globally | New global behaviour, which [ADR-013](ADR-013-deliberately-not-done.md) turns down; `repown fix` only ever removes |
| Set it in every clone without asking or listing it | The user asked to see every change; the review lists it and step by step can skip it |
| Run `git push -u` as part of setup | Publishes. The first push belongs to the user, behind the guard |
| Drop the gh warning when the clone is otherwise ready | A skipped check must not look passed ([ADR-011](ADR-011-refuse-vs-warn.md)); it is labelled optional instead |
| Remember the chosen mode | A preference store ([ADR-007](ADR-007-no-profile-store.md)); the flag is enough |

## Consequences

- Status gains a field and its closing line changes. Text isn't a contract
  ([ADR-014](ADR-014-json-for-scripts.md)); `--format json` is untouched.
- In Recommended mode, a gh switch happens without its own question when gh already
  lists the account. That changes which account `gh` acts as in every terminal, and the
  review says so.
- Setup reads `git --version` once.
