# How repown works

Every scenario, one card each. Read the headline, and click **Show how** when you want
the diagram and the detail. The reasons behind each rule are in
[decisions/](decisions/README.md), one ADR each.

**In three lines:** each clone is pinned **once** to one account. Moving between
accounts is just `cd`. A `pre-push` guard checks every commit before it leaves.

🟢 passes · 🔴 refused · 🟡 warns · ⚪ not checked (always said out loud, never silent)

## The picture: three things decide who you are

```mermaid
flowchart LR
  subgraph clone["one clone: .git/config (written by repown use)"]
    ID["user.name / user.email<br/>who AUTHORS the commit"]
    CRED["credential.https://github.com.username<br/>which credential PUSHES"]
    ACC["repown.account<br/>whose clone this is"]
  end
  CRED --> GCM["Git Credential Manager<br/>one stored credential per account"]
  GH["gh active account<br/>gh CLI only: pr create, api"]
  HOOK[".git/hooks/pre-push<br/>the guard (repown guard on)"]
  ACC --> HOOK
  ID --> HOOK
```

In a clone, repown writes only `.git/config` and `.git/hooks/pre-push`. Git never pushes
either, so nothing reaches the repository or your teammates. Outside the clone it writes
only its own account registry. Global git config is changed only by `repown fix`, after
it shows you what it removes. gh's active account is changed only by `repown use --gh`.

## Find your case

| I want to… / What happened? | Card |
| --- | --- |
| Set up a new machine | [1](#1-set-up-the-machine) |
| Save an account once, use it everywhere | [2](#2-remember-an-account) |
| Make a clone belong to an account | [3](#3-pin-a-clone) |
| Use Azure DevOps, SSH or another host | [3](#3-pin-a-clone) |
| Work in account X, then Y, then Z | [4](#4-switch-accounts) |
| Check who I am in this clone | [5](#5-check-where-you-are) |
| Get asked for a password, or do my first push | [6](#6-commit-and-first-push) |
| Push failed right after signing in (SSO) | [6](#6-commit-and-first-push) |
| Understand what the guard checks | [7](#7-push-what-the-guard-checks) |
| Fix a push the guard refused | [8](#8-push-refused-and-the-fix) |
| Work with a teammate who doesn't use repown | [9](#9-a-teammate-without-repown) |
| Use husky, or another pre-push hook | [10](#10-other-hook-tools) |
| Audit my clones, re-point one, or move to a new machine | [11](#11-audit-re-point-move-machines) |
| Uninstall repown, or fix "repown cannot be found" | [12](#12-uninstall-or-repown-missing) |

---

### 1. Set up the machine

**Once per machine.** `repown doctor` checks what serves git credentials. 🟢 Git
Credential Manager (GCM) needs nothing more. 🔴 If gh has become the helper, run `repown fix`.

<details><summary>Show how</summary>

```mermaid
flowchart TD
  D[repown doctor] --> Q{"what serves this clone's host?<br/>(github.com outside a clone)"}
  Q -->|Git Credential Manager| OK["🟢 nothing to do<br/>one credential per account, picked per clone"]
  Q -->|gh, from gh auth setup-git| BAD["🔴 gh serves only its ACTIVE account<br/>every other clone gets a password prompt"]
  Q -->|anything else| W["🟡 repown has no opinion<br/>the pin works only if that helper honours it"]
  BAD --> F["repown fix<br/>shows the entries and the undo, asks, removes only gh's"]
  F --> OK
```

| Variant | Command |
| --- | --- |
| See what `fix` would remove | `repown fix --dry-run` |
| No terminal, or a script | `repown fix --yes` |
| Undo `fix` | `gh auth setup-git` |
| Setting in the system scope | re-run `repown fix` in an elevated shell |

**Why:** switching gh's account moves the password prompt to your other account's
clones rather than fixing it ([ADR-001](decisions/ADR-001-credential-manager-not-gh.md)).
</details>

### 2. Remember an account

**Once per account.** Record its commit name and email once, and every `repown use`
after that is one word.

<details><summary>Show how</summary>

```
repown accounts add octocat              # asks; with gh signed in, suggests <id>+octocat@users.noreply.github.com
repown accounts add octocat --name "Octo Cat" --email octocat@users.noreply.github.com
repown accounts add octo-work --host azdo
repown accounts list
repown accounts rm octocat               # clones already pinned keep their identity
```

The registry is `accounts.json` in `%APPDATA%\repown` on Windows and in
`$XDG_CONFIG_HOME/repown` (default `~/.config/repown`) on Linux and macOS.
`REPOWN_CONFIG_DIR` overrides both. It stores a name, an email and a host per account,
never a secret.
</details>

### 3. Pin a clone

**Once per clone.** `repown use <account>` writes the identity into `.git/config`. 🟢

<details><summary>Show how</summary>

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant R as repown use octocat
  participant Reg as registry
  participant G as .git/config
  You->>R: in the clone
  R->>Reg: name + email for octocat?
  alt recorded, or --name and --email given
    Reg-->>R: Octo Cat, noreply address
  else first time
    R->>You: ask once (gh suggests the noreply address), then record it
  end
  R->>G: user.name, user.email, user.useConfigOnly, repown.account
  R->>G: credential.https://github.com.username (GitHub over https only)
  R-->>You: 🟢 pinned, plus any 🟡 warnings, then "Next: repown guard on"
```

| Variant | What happens |
| --- | --- |
| `--gh` | also runs `gh auth switch`, so `gh pr create` acts as the same account |
| No terminal and no record | 🔴 stops and tells you to run `repown accounts add <account> …` |
| SSH remote | no credential key is written, because your SSH key decides; 🟡 `use` says so |
| Azure DevOps or another host | identity and guard work; 🟡 credentials are not pinned ([ADR-009](decisions/ADR-009-hosts-claim-only-measured.md)) |
| Repo owned by an organisation | 🟡 prints `git config --local --add repown.allowOwner octo-org` |
| gh is still the credential helper | 🟡 `fix: repown fix` |
| No stored credential yet | the first push signs in once ([card 6](#6-commit-and-first-push)) |
| Clone has submodules | each submodule is its own clone: pin and guard each one |

</details>

### 4. Switch accounts

**No command. Just `cd`.** Each clone already knows its account, so X, Y and Z work
side by side.

<details><summary>Show how</summary>

```mermaid
flowchart LR
  A["~/code/personal<br/>pinned: octocat"] -->|git push| GCM[Git Credential Manager]
  B["~/work/service<br/>pinned: octo-work"] -->|git push| GCM
  GCM -->|octocat's credential| H1[github.com/octocat/…]
  GCM -->|octo-work's credential| H2[github.com/octo-org/…]
```

Compare `gh auth switch`, which is **machine-wide**. While gh is git's credential
helper, switching to X breaks every Y clone. After [`repown fix`](#1-set-up-the-machine),
gh's active account affects only the gh CLI. To keep it in step with a clone, run
`repown use <account> --gh`.
</details>

### 5. Check where you are

**`repown`** (short for `repown status`) prints all three identities. It changes nothing.

<details><summary>Show how</summary>

```
$ repown

  commits as     Octo Cat <octocat@users.noreply.github.com>
  pushes as      octocat
  origin         octocat  (GitHub)
  helper         manager
  gh active      octo-work
  push guard     on

WARN  gh         active as "octo-work", so `gh pr create` here would act as that account.
       fix: gh auth switch -u octocat
OK    identity   this clone is pinned, and its credential mechanism honours it
```

| You see | Meaning | Fix |
| --- | --- | --- |
| 🔴 `commits as NOT SET LOCALLY` (or `? <address>`) | the clone sets no name or email of its own | `repown use <account>` |
| 🔴 `No account is pinned` | a GitHub https clone with no push account; pushes use the machine default | `repown use <account>` |
| 🔴 `gh is the git credential helper` | only gh's active account can push | `repown fix` |
| 🟡 `no credential helper is set` / `cannot tell whether it honours` | a GitHub https clone, and the helper isn't Git Credential Manager | `repown doctor` ([card 1](#1-set-up-the-machine)) |
| 🟡 `gh active as "…"` | the gh CLI would act as another account | `gh auth switch -u <account>` |
| 🟡 `gh could not be queried` | who `gh pr create` acts as is unknown | `gh auth status` |
| 🟡 `origin belongs to "octo-org"` | an organisation repository | `git config --local --add repown.allowOwner octo-org` |
| 🟡 `guard off` | pushes are not checked | `repown guard on` |
| 🟡 a pre-push hook repown did not write, or `core.hooksPath` | another tool owns the hook | [card 10](#10-other-hook-tools) |
| 🟡 `this clone has submodules` | each submodule is a clone of its own | pin and guard each one |
| 🟢 `commit identity is pinned; its credentials are left to …` | a host where credentials aren't pinned | nothing: expected |
| `pushes as not pinned by repown on …` | a host where credentials aren't pinned | nothing: expected |
| `origin no remote` | nothing to push to yet | nothing |

</details>

### 6. Commit and first push

**Commits use the pinned identity. The first push signs in once per account, and never
again.** 🟢

<details><summary>Show how</summary>

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant Git as git
  participant GCM as Git Credential Manager
  You->>Git: git commit
  Git->>Git: author = the pinned user.email (useConfigOnly: never guessed from the hostname)
  You->>Git: git push
  Git->>GCM: credential for username octocat?
  alt stored
    GCM-->>Git: octocat's credential 🟢
  else first time
    GCM->>You: browser sign-in once (SSO works too), then stored
  end
```

If a push fails right after signing in, the credential may be valid but not yet
**SSO-authorized** for that organisation. Nothing can see this in advance; when Git
Credential Manager is the helper, `repown doctor` prints a reminder. Authorize that credential for the organisation on GitHub (its SSO
settings), then push again.
</details>

### 7. Push: what the guard checks

**`repown guard on`** installs the hook. Every push runs these checks in this order.
It checks the **commits**, not today's config.

<details open><summary>Show how</summary>

```mermaid
flowchart TD
  P[git push] --> E{GH_TOKEN, GITHUB_TOKEN,<br/>GIT_AUTHOR_EMAIL or GIT_COMMITTER_EMAIL set?}
  E -->|yes| X1[🔴 env]
  E -->|no| I{clone has a pinned email?}
  I -->|no| X2[🔴 not pinned]
  I -->|"yes: run all three checks,<br/>report every refusal together"| O{"destination owner = repown.account<br/>or a repown.allowOwner?"}
  I -->|yes| T{"each pushed annotated tag's tagger<br/>= your email or a repown.allowTagger?"}
  I -->|yes| C["for each pushed ref, the commits the remote<br/>does NOT already have"]
  O -->|"can't tell: local path, no owner in URL,<br/>nothing to compare against"| N[⚪ destination not checked]
  O -->|no| X3[🔴 wrong owner]
  T -->|no| X4[🔴 tagger]
  C --> A{"every commit's author AND committer<br/>email = yours? (case-insensitive)"}
  A -->|no| X5[🔴 foreign commit]
  A -->|"couldn't read commits or a tag"| X6[🔴 unreadable]
  O -->|yes| OK["🟢 push goes out<br/>when all three pass"]
  N -.->|a note, not a refusal| OK
  T -->|yes| OK
  A -->|yes| OK
  classDef bad fill:#fdd,stroke:#c00,color:#000
  classDef good fill:#dfd,stroke:#080,color:#000
  classDef na fill:#eee,stroke:#888,color:#000
  class X1,X2,X3,X4,X5,X6 bad
  class OK good
  class N na
```

🟢 These always pass:
- your own commits, on a new branch or an existing one;
- deleting a branch, since it publishes nothing;
- re-pushing commits the remote already has, on any of its branches: pulled work, merged
  branches.

`env` and `not pinned` stop at once. Wrong owner, tagger and commit refusals are all
reported together, so one push shows everything to fix. Only email addresses are
compared, never names. A variable set to an empty string counts as unset. Each 🔴 is explained in
[card 8](#8-push-refused-and-the-fix). Credential problems never
block a push, because a failed login publishes nothing; `repown` and `repown doctor`
report those instead ([ADR-011](decisions/ADR-011-refuse-vs-warn.md)).
</details>

### 8. Push refused, and the fix

**Every refusal says what, which commit, and the fix.** Nothing is published until
you choose.

<details><summary>Show how</summary>

```
FAIL  guard      1 commit(s) bound for refs/heads/main were not authored as octocat@users.noreply.github.com, or were committed by someone else.
         2eccc0911  someone@example.invalid  someone else's commit

       These addresses become permanent once pushed.


Push stopped by the repown identity guard (above).
Override this one push with: git push --no-verify
```

| 🔴 Refusal | Typical cause | Fix |
| --- | --- | --- |
| **foreign commit**, yours | committed before pinning, or by an IDE with its own identity | last commit: `git commit --amend --reset-author --no-edit`; older ones: `git rebase <last-good> --exec "git commit --amend --reset-author --no-edit"`; then push again |
| **foreign commit**, a teammate's | cherry-picked, rebased or fetched from their fork, and not on the remote yet | let them push it, then pull; don't re-author their work ([card 9](#9-a-teammate-without-repown)) |
| **wrong owner** `push goes to "…"` | an organisation repository, or the wrong remote | organisation: `git config --local --add repown.allowOwner octo-org` |
| **env** `GH_TOKEN is set` | a token or email variable overrides the identity | unset it, then push again |
| **not pinned** | the clone has no identity, e.g. after `repown off` | `repown use <account>`, or `repown guard off` |
| **tagger** | an annotated tag made under another address | re-tag; for a fork pushing upstream's tags: `git config --local --add repown.allowTagger <address>` |
| **unreadable** | a missing object, a tag it can't read, or history repown can't parse | `git fetch`, then push again; if it says it can't parse, inspect the commits yourself |
| ⚪ `destination not checked` | a local path, a URL with no owner, or no account or `repown.allowOwner` to compare | nothing: a note, not a refusal; `repown use` again pins the account |

**A fork's mirror branch** is a branch that only fast-forwards to upstream. Set
`git config --local repown.mirrorBranch master` and commits already on any remote stop
counting there, while a commit made here is still refused. Fetch upstream first, and
don't set it on a clone with a private remote.

`repown.allowOwner`, `repown.allowTagger` and `repown.mirrorBranch` count only in the
clone's own config, never global. A tag's tagger is checked even on a public commit,
because whether the tag itself is public can't be told offline.

**Skip the guard for one push:** `git push --no-verify`. Only do this when you mean to
publish those addresses.
</details>

### 9. A teammate without repown

**They need nothing, and they see nothing.** You can still pull, merge and push as
usual. 🟢

<details><summary>Show how</summary>

```mermaid
sequenceDiagram
  autonumber
  participant A as A (repown + guard)
  participant R as shared remote
  participant B as B (plain git)
  B->>R: push commits (B's own address)
  A->>R: pull
  A->>R: push own work on top 🟢
  B->>R: push branch "feature"
  A->>R: merge feature, push 🟢 (B's commits are already on the remote)
  R->>B: pull, then push as usual 🟢 (no config, no hook, no files from A)
  Note over A,B: B commits "fix" locally and never pushes it
  A->>A: cherry-pick B's "fix" (a new commit, with B's address)
  A-xR: push 🔴 A would publish B's address
```

Git never pushes `.git/config` or `.git/hooks`, so B's clone is untouched. The one
refusal is deliberate: the remote has never seen that commit, so A pushing it would
publish B's address from A's machine. This happens with a cherry-pick, a rebase, or a
fetch from B's fork. **If applying other people's patches is your daily work, as for a
maintainer, leave the guard off in that clone.** `repown use` still pins you. For a
whole team, use a server-side rule on author addresses.
</details>

### 10. Other hook tools

**repown never overwrites or deletes a hook it didn't write.** 🟡

<details><summary>Show how</summary>

| Situation | What repown does |
| --- | --- |
| A `pre-push` hook repown didn't write already exists | `guard on` and `guard off` leave it alone and say so |
| `core.hooksPath` is set (husky, lefthook…) | never writes or deletes there; `repown` warns and prints the line below |
| A repown hook left in `.git/hooks` while `core.hooksPath` is set | `guard off` still removes it, so it can't come back when `core.hooksPath` is unset |

To guard such a clone, call repown from that tool's `pre-push` hook, passing stdin through:

```sh
repown guard check --remote="$1" --url="$2"
```

</details>

### 11. Audit, re-point, move machines

**Auditing never changes anything. Re-pointing takes two commands.**

<details><summary>Show how</summary>

```
repown scan ~/code ~/work      # every clone: owner, host, identity, guard, addresses in history
repown scan --emails           # show the exact addresses instead of domains and counts
repown off && repown use octo-work   # re-point this clone to another account
```

| Kept where | Survives a re-clone or a new machine? |
| --- | --- |
| `.git/config`: identity, `repown.*` keys | ❌ run `repown use` again |
| `.git/hooks/pre-push`: the guard | ❌ run `repown guard on` again |
| registry: name and email per account | ✅ on this machine (copy it to a new one) |
| OS credential store: one credential per account | ✅ on this machine |
| global `.gitconfig`: helper, default identity | ✅ untouched by repown, except `repown fix` |
| gh's `hosts.yml`: accounts and the active one (gh CLI only, not git) | ✅ untouched by repown, except `use --gh` |

`scan` looks 3 levels deep by default (`--depth`), and scans the current directory when
given none. It skips `node_modules` and doesn't look inside a clone, so nested clones and
**submodules are not listed**. It shows email domains and counts rather than addresses,
because its output gets pasted into chats: the top 3, then `+N more`. A count is how often
an address appears as author or committer across all refs (branches, tags, remote refs),
not a number of commits; a set `repown.mirrorBranch` is left out and marked `(excl. mirror)`.

| Column | Can read |
| --- | --- |
| identity | `pinned` · `INHERITED` (not pinned) · `commits only` (name and email, no account) |
| owner / host | owner and `github` · `azdo` · `generic`; `?` and `-` when no owner can be read (a local path, say); `no remote` and `-` without `origin` |
| guard | `on` · `off` · `foreign` (another tool's hook; counted as not guarded) |
| identities in history | `-` (empty history) · `(no domain)` · `unknown -- history could not be read` |

A directory `scan` can't open is reported, not skipped. It exits 2 when a directory
doesn't exist or `--depth` is invalid, and 0 otherwise, whatever it finds. The identity column is a fact,
not a verdict: a shared repository carries many addresses. The guard stops **new** wrong
addresses; it can't rewrite history.
</details>

### 12. Uninstall, or repown missing

**Turn the guard off before removing repown.** A guard that can't find repown refuses
rather than letting a push through unchecked.

<details><summary>Show how</summary>

```mermaid
flowchart TD
  H[pre-push hook runs] --> P{"node and repown at the paths<br/>recorded by guard on?"}
  P -->|yes| RUN[repown guard check]
  P -->|no| Q{"repown on PATH, and<br/>repown --version says repown?"}
  Q -->|yes| RUN
  Q -->|no| X["🔴 refuses, and prints the 3 ways out:<br/>reinstall, then repown guard on<br/>or delete .git/hooks/pre-push<br/>or git push --no-verify, once"]
  classDef bad fill:#fdd,stroke:#c00,color:#000
  class X bad
```

To uninstall cleanly:

```
repown scan <dir>        # the "guard" column shows where it's on (submodules aren't listed)
repown guard off         # in each of those clones, and each guarded submodule
repown off               # optional: also drop the pinned identity
npm unlink -g repown     # or: npm uninstall -g repown
```

repown writes nothing else to a clone: no tracked file, nothing that gets committed.

</details>
