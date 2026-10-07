# Spec: the "Wrong advice" round

Objective: repown's advice is true for the host the clone actually uses.

Dropped (already fixed in 0.5.1): doctor's SSO hint naming gh (#1), an unpinned clone told
`repown use` only (#5).

## Success criteria
1. **#2:** in a clone with no credential keys (Azure DevOps, SSH, another host), `repown use`
   prints neither "No stored credential ... the first push signs in" nor "gh is still the git
   credential helper, so this pin is not honoured", as setup's `credentialGap` already does.
   GitHub over HTTPS is unchanged.
2. **#3:** in a clone with no credential keys, doctor says in one line that this clone's pushes
   use that host's own sign-in and repown pins none there, and its machine diagnosis (helper,
   GCM explanation, verdict, SSO line) is about github.com, as outside a clone. ADR-023 note.
3. **#4:** top help: `Exit codes: 0 success, 1 failure or refusal, 2 usage error, 130 cancelled
   (setup, the start screen).` README's exit-code table says the same.
4. **#22:** the accounts group summary names remove; `accounts add`'s summary says the name and
   email are suggested from GitHub through gh.
5. **Docs:** HOW-IT-WORKS' Recommended and Step by step setup samples match the real screens.

Out of scope: exit codes, JSON, the guard, any wording on GitHub-over-HTTPS clones.
Riskiest assumption: "no credential keys" is the right test for every non-pinning case (status
and setup already use it).
