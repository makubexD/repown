# SPEC: start-screen gaps, round 2

Scaffolding for this feature only; Phase 6 moves what stays true into ADR-027/028 notes and
the CHANGELOG, then deletes this file.

## Objective
Whatever repown prints to copy pastes and runs the same in bash, zsh, fish, sh/dash,
PowerShell 5.1/7 and cmd, on Linux, macOS and Windows. The account questions say where each
prefill came from, and warn when the login isn't one this machine is signed in as. The start
screen can remove an account.

## Success criteria
1. **Quoting (N2), one rule on every OS:** bare when `^[\w.\/-][\w.@+\/:-]*$`; else double
   quotes when the value has none of `` " $ ` % ! ``, no `\\`, and doesn't end in `\`; else
   POSIX single quotes.
2. **`--` (N2b):** where `formatCommand` must print `--`, it prints `"--"` (PowerShell drops a
   bare `--` from a `.ps1` shim's `$args`).
3. **Marker (N7):** command lines in setup and the start screen start with `$ `, not `> `;
   cyan only where stderr has colour.
4. **Email (N3):** a prefilled GitHub private address is named as such; the `1234+` example
   only when nothing is prefilled.
5. **Name (N4):** a name prefill that is the login says so ("GitHub shows no name for X, so
   this is the login" / offline "this is the login"). Machine sentences: "your default git
   name here is X: type it only if this account uses it too" (and the address).
6. **Detail (N5):** clack draws a step's detail under its hint, before "type < to go back".
7. **Signed in (N1):** on GitHub, when gh or Git Credential Manager lists github.com accounts
   and the login (any case) isn't among them and no 404/organisation sentence shows, the name
   detail says "signed in as A, B, not X: if X isn't your account, go back; otherwise the
   first push asks you to sign in as it". Silent otherwise.
8. **Remove (N6):** "Remove an account" on the start screen when the registry reads and has
   accounts: pick or Back, confirm or Back, `$ repown accounts remove X`, the menu returns.

## Out of scope
Refusing an unsigned login; the note in typed `accounts add`; a confirm in typed `accounts
remove`; values with `` $ ` " % ! `` in cmd; nushell; East Asian display width; mintty without
ConPTY.

## Riskiest assumption
The double-quote rule round-trips in zsh, fish and dash: `test/paste.test.ts` on CI proves it.
