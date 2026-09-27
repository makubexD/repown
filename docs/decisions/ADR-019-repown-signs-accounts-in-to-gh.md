# ADR-019: repown can sign an account in to gh; the terminal is handed over, never read

**Status:** Accepted

## Context

In a real run, setup asked about gh only when the account was already signed in.
A new GitHub account skipped that question with no word. `repown status` then
warned that gh was active as someone else, and the fix it printed was
`gh auth switch -u <account>`. That command fails for an account gh has never
seen: switch only works for a login gh already lists. `repown doctor` reported
the helper and gh's one active account, and never the accounts repown had
recorded, so nothing showed whether git and gh were ready for this one.

Signing the account in means running `gh auth login`. That command, on a
terminal, offers `Authenticate Git with your GitHub credentials?` (default
Yes), and no flag both opens the browser and skips the offer while keeping
HTTPS. The gates below were read from cli/cli, tag v2.88.1, and the same gate
is still present in v2.101.0 (2026-09-15). A login was not run. The public
manual (fetched 2026-09-24) lists no "skip git setup" option. The offer itself
dates from gh 1.4.0 (2020-12-15, PR #2449).

## Decision

- **`repown use <account> --gh` signs the account in only when a query of gh
  succeeded and gh does not list it.** The account gh already lists is still
  `gh auth switch`, including when it is already active. A query that failed
  keeps that same switch attempt, and the failure stays unknown
  ([ADR-011](ADR-011-refuse-vs-warn.md)). The login runs only when stdin and
  stderr are both terminals, the same test a prompt uses. The argv, with
  `shell: false`, is always:

  ```
  gh auth login --hostname github.com --web --git-protocol https
  ```

  `--hostname github.com` is the host that was read, and it
  keeps `GH_HOST` from sending the flow elsewhere
  ([ADR-009](ADR-009-hosts-claim-only-measured.md)). The child environment is
  the parent's with `GH_TOKEN` and `GITHUB_TOKEN` removed, in any capitalisation:
  either one, when set, makes this login refuse to store a credential and exit
  1. Other variables are left as they are.

- **gh older than 2.40.0 does not get that login.** Before 2.40.0 (2023-12-07,
  PR #8425) one host held one account, and `auth login` replaced it. From
  2.40.0 the login adds an account and the browser's account becomes the active
  one. `gh --version` must match `gh version X.Y.Z` and that version must be at
  least 2.40.0. Older gh is warned that login would replace an account, and a
  version that cannot be read is warned that sign-in was skipped. Both name
  the same fix: upgrade gh to 2.40.0 or newer, then `repown use <account> --gh`.

- **`inherit` in `src/core/exec.ts` hands the terminal to that child, and this
  file still writes nothing.** `run` captures the child's output and returns
  it, because credential helpers print live secrets and nothing in this file
  may show them ([CLAUDE.md](../../CLAUDE.md#hard-rules)). `inherit` is the one
  spawn that does not capture: `stdio: 'inherit'`, so gh draws its own prompts
  and the one-time code on the terminal. The result's stdout and stderr stay
  empty. repown never receives those bytes, so a one-time code or a token gh
  prints cannot pass through it. There is no timeout; the person is at the
  browser. `inherit` itself does not check for a terminal. In the program,
  only this login calls it, and only on the path above.

- **The parent ignores SIGINT while that child runs.** Node's default is to
  exit the process on SIGINT. An empty listener replaces that default for the
  child's lifetime, so Ctrl-C belongs to gh and the parent stays up until gh
  exits. The listener is removed when the child closes or fails to spawn, and
  a Ctrl-C after that is repown's again. It does not replace listeners already
  registered: `repown setup` still notices the interrupt and stops the steps
  that have not run. gh's own survey cancellation exits 2, which repown reports
  as `gh sign-in cancelled`. A Ctrl-C while the device flow is polling was not
  measured; any other non-zero is a failed login (`gh auth login exited N`),
  and the account list is not assumed to have changed.

- **The credential question cannot be skipped, so repown says what to answer
  and then checks what git's helper became.** With `--git-protocol https`, on
  a terminal, gh asks `Authenticate Git with your GitHub credentials?` unless
  gh is already the helper (`Helper.IsOurs` in `pkg/cmd/auth/shared/git_credential.go`,
  unchanged from the 1.x flow through v2.88.1 and v2.101.0). repown says so
  before the child starts, from the helper it already read:
  - gh is already the helper: gh will not ask, and repown says nothing about
    the question.
  - no helper is configured: answer No. Yes would make gh answer git's sign-in
    requests for every repository, and repown would then need `repown fix`.
  - some other helper is configured, Git Credential Manager included
    (`credential.helper=manager` counts): Yes also stores this sign-in there,
    so the first push won't ask again. The line names Git Credential Manager
    when that is the helper, and otherwise names the helper's value.

  Yes is decided before the browser opens. What it writes, from the same
  source: when a helper is configured and it is not gh, gh runs
  `git credential reject` and then `git credential approve` for that helper.
  gh is not installed as the helper, and a later read of the helper list does
  not show gh. When no helper is configured, Yes writes the same entries as
  `gh auth setup-git` (the login does not run that command): an empty helper
  value, then gh's, for `github.com` and for `gist.github.com`. That serves
  gh's active account only
  ([ADR-001](ADR-001-credential-manager-not-gh.md)). After a login that exits
  0, repown reads gh and the helper again. The active login is whoever finished
  the browser flow. When it is the named account, compared case-insensitively,
  the line is `signed in as <account>, now gh's active account`. Anyone else is
  a warning that names who signed in, and how to retry in a private window.
  When gh was not the helper before and is afterwards, the warning's fix is
  `repown fix`. Answering Yes on the user's behalf, or writing global git
  config so the question would not appear, is the sort of new global behaviour
  [ADR-013](ADR-013-deliberately-not-done.md) turns down: `repown fix` only
  ever removes that helper.

- **`-p ssh` and `GH_PROMPT_DISABLED` are not how the question is avoided.**
  `--git-protocol ssh` never enters the credential question, and it writes
  host-level `git_protocol: ssh`. Since 2.40.0 that value is one setting for
  the host, not for the user: `gh repo clone` would then use SSH for every
  account on github.com. `GH_PROMPT_DISABLED` (any value, including empty) and
  gh's own `prompt: disabled` turn prompting off. `--web` then prints a URL
  and does not open a browser. The sign-in is the browser.

- **With no terminal, `--gh` does not log in.** The warning is
  `<account> isn't signed in to gh`, and the fix is `gh auth login`, then
  `repown use <account> --gh`. The pin has already been written. A gh problem
  is a warning: `repown use` still exits 0, and the guard does not look at it
  ([ADR-011](ADR-011-refuse-vs-warn.md)).

- **Setup asks, and the command above does the work.** The wizard only asks,
  then runs the commands the answers stand for
  ([ADR-016](ADR-016-clack-for-the-setup-wizard.md)). On a GitHub clone whose
  gh query succeeded, a new question appears when gh does not know the account:
  `Sign in to gh as <account> too?`, default No, the same default as the
  switch question. The hint says git pushes don't need gh, and that Yes opens
  a browser, after which gh acts as that account in every terminal. The line
  under it names gh's active account, or says gh isn't signed in to any. Yes
  plans `repown use <account> --gh`. The question is absent when gh could not
  be queried. Without a terminal, setup never reaches a question
  ([ADR-016](ADR-016-clack-for-the-setup-wizard.md)); `--no-input --gh` still
  goes through `use`, which signs in only when that run itself has a terminal.

- **Leaving gh on another account is said twice, with a command that works.**
  Both lines come from the same advice as `repown status`. When the sign-in
  was not chosen and gh has an active account that isn't this one, the review
  says gh still acts as that account, so `gh pr create` here would too, and
  names the fix: `gh auth switch -u <login>` in gh's own spelling when gh
  already lists it, otherwise `repown use <account> --gh`. After a run that
  finishes, the same advice is read again and printed as `still to do:`, with
  the leading `fix:` left off. A run that ends on gh's active account prints
  neither. A query that failed stays off the review (it is not "gh acts as
  someone else") and the closing line still reports it, because a skipped
  check is said out loud ([ADR-011](ADR-011-refuse-vs-warn.md)).

- **`repown doctor` is where each account's readiness is read.** The title is
  `repown doctor · how this machine signs in to git hosts`. **This machine**
  is the helper, Git Credential Manager, and gh's active account. **Accounts**
  is one row for every login the registry, Git Credential Manager or gh knows:
  recorded accounts in registry order, then the others alphabetically. git is
  `stored` when Git Credential Manager's store holds the account;
  `not signed in yet (the first push signs in)` when that store was read, Git
  Credential Manager is the helper, and the account is absent;
  `unknown` when Git Credential Manager is missing, its store could not be
  read, or another helper serves pushes and the account is not stored; and
  `your host's own sign-in` for a recorded account whose host is not GitHub
  ([ADR-009](ADR-009-hosts-claim-only-measured.md)). gh is `active`,
  `signed in`, `not signed in`, or `unknown`. A non-GitHub account has no gh
  cell, and neither does a row when gh is not installed (`not installed` is
  the machine line, once). `not recorded by repown` and `recorded: unknown`
  say how the row met the registry, and `(this clone)` marks the account this
  clone is pinned to. A failed read is `unknown` in the cells that depend on
  it, plus one warning naming the source. The failure is printed, and it is
  never presented as "not signed in". Names that only the failed source knew
  are absent, because they could not be read; the warning says so. When every
  source that could be read named nobody (gh not installed counts as no gh
  accounts), the table says `none recorded, stored or signed in yet` and
  points at `repown setup`. The diagnosis under the table, including the SSO
  note, is unchanged
  ([ADR-013](ADR-013-deliberately-not-done.md)). `repown doctor` still exits 1
  only when gh is the helper.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep skipping the question when gh does not know the account | That was the bug. Status then prescribed `gh auth switch`, which cannot add an account. |
| `gh auth login -p ssh` (with or without `--skip-ssh-key`) | The credential question is skipped, and host-level `git_protocol` becomes `ssh` for every account on github.com. `--skip-ssh-key` (gh 2.48.0) only skips the SSH-key prompts. |
| Set `GH_PROMPT_DISABLED` so the question is never asked | `--web` then prints a URL and does not open a browser. |
| Answer Yes for the user, or add a flag that skips the question | No such flag exists from gh 1.4.0 through 2.101.0. Yes with no helper configured installs gh as git's helper ([ADR-001](ADR-001-credential-manager-not-gh.md)). |
| Capture gh's output so a token error can be quoted | Those bytes would pass through repown. The parent learns the outcome from the exit code, then from `gh auth status` and git config, as it already did. |
| Run the login with no terminal, and relay the URL | Same as prompting disabled: no browser, and relaying means reading the child. |

## Consequences

- **`-p https` writes host-level `git_protocol: https` for every account on
  github.com**, interactive or not, and even when the credential question is
  declined. gh's own comment, present since 2.40.0, says the protocol is a
  host setting: a previous `ssh` is overwritten, and `gh repo clone` uses HTTPS
  for all of those accounts until something sets it back. This is gh's config,
  not git's credential helper.
- **Yes into an existing helper is invisible to the helper list.** The
  afterwards check looks for gh's helper value. A token approved into Git
  Credential Manager does not set that value, so it does not raise
  `fix: repown fix`. The line printed beforehand is the record of that choice.
  repown still does not read the token.
- **The browser chooses the account.** gh activates whoever completes the
  flow, including an account that was already stored. repown cannot pass the
  login it was asked for into `gh auth login`.
- **`GH_PROMPT_DISABLED`, when it is already set, is left in the child
  environment.** Only the two token variables are removed. Prompting then
  stays off, and `--web` does not open a browser. gh config `prompt: disabled`
  does the same and is not an environment variable.
- **A sign-in that is cancelled, fails, or is skipped does not unpin the
  clone.** The warning is the whole report. Exit codes of `repown use` are
  unchanged.
- **Doctor's text layout changed.** Text isn't a contract
  ([ADR-014](ADR-014-json-for-scripts.md)). `repown doctor` has no
  `--format json`. Its exit codes are unchanged.
- **Where this is written up for use:** [card 3](../HOW-IT-WORKS.md#3-pin-a-clone)
  for `use --gh`, [card 13](../HOW-IT-WORKS.md#13-guided-setup) for the
  question and the leftover lines, [card 1](../HOW-IT-WORKS.md#1-set-up-the-machine)
  for the Accounts table, [card 5](../HOW-IT-WORKS.md#5-check-where-you-are)
  for status's fix, and [the FAQ](../FAQ.md#questions) for when the login
  contacts GitHub.
