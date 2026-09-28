# SPEC: final review fixes

## Objective

This is the last review of a real run: `doctor`, `status`, bare `repown` on a settled clone,
and a push. It fixes what disagrees with the code or misleads the reader, and rewrites the
README so a first-time reader can follow it: clear, organised, with practical examples.
Nothing in it is lost.

## Boundaries

- **Always:**
  - strip-only TypeScript;
  - functions of at most 20 lines and at most 4 parameters;
  - ADR citations in the form ADR-0NN;
  - no names or email addresses (use octocat, octo-work, octo-org, `*.example.invalid`);
  - `npm run build` and `npm test` green.
- **Ask first:** any JSON field (ADR-014), exit codes, guard severity (ADR-011).
- **Never:**
  - change routing (ADR-021), `--no-input` semantics or setup flags;
  - put emoji in `##` headings (it breaks `#anchors` that other docs link to);
  - push.

## Commands

    npm run build
    npm test
    node --test test/docs.test.ts
    node dist/cli.js doctor | status | (bare)

## Scenarios

| # | Given | When | Then (exact line) |
| --- | --- | --- | --- |
| 1a | Settled clone, the branch tracks `origin/main`, `push.autoSetupRemote` true | setup opens | `upstream    origin/main` |
| 1b | Settled clone, no tracked ref, `push.autoSetupRemote` true | setup opens | `upstream    set on the first push (push.autoSetupRemote)` |
| 1c | Settled clone, no tracked ref, flag not true | setup opens | no upstream line |
| 1d | Any clone | `repown status` | the upstream field is unchanged (it uses the same helper) |
| 2a | GCM helper, GitHub origin on github.com | `repown doctor` | `  authorization: authorize it in the org's SSO settings on github.com`, with no `<host>` and no `gh auth refresh` |
| 2b | GCM helper, outside a clone | `repown doctor` | the same line, with `github.com` |
| 2c | GCM helper, a non-GitHub origin | `repown doctor` | `  authorization: check <label>'s SSO settings` (unchanged) |
| 3a | Settled screen, gh active as another account, gh does not list the account | setup opens | `… (git pushes are unaffected). If you use gh here, choose "Sign in to gh as octocat" below.` |
| 3b | Review (not the opening screen), gh left acting as another | review | `… If you use gh here: repown use octocat --gh (signs octocat in to gh).`, with no triple space and no `later: ` |
| 3c | gh lists the account | review | `… If you use gh here: gh auth switch -u octocat.` |
| 4 | README | read | no stray `demo` line |
| R | README rewrite | `node --test test/docs.test.ts` | passes; every fact in the old README is still present |

## Success criteria

- Every scenario above is covered by a test, where it is testable, and passes.
- The docs quote the new strings. Grepping `refresh -h <host>` and `later: repown use` across
  the docs and src finds nothing.
- The README follows the target layout in tasks/todo.md.

## Open questions

- None.
