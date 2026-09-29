# ADR-024: Bare repown outside a clone opens a start screen

**Status:** Accepted. Supersedes the help-outside-a-clone branch of
[ADR-018](ADR-018-bare-repown-guides-new-clones.md) and
[ADR-021](ADR-021-bare-repown-always-opens-setup.md), in a terminal only.

## Context

A new user ran bare `repown` in their home folder and got the top help. They expected
to be guided, as they would be inside a clone. Setup needs a clone to pin, so ADR-018
printed help wherever there was none. But a folder that isn't a clone usually holds
clones, or the user is still at the machine-level steps (recording accounts, taking
the credential helper back from gh), and repown can see all of that without asking.

Common CLI practice (clig.dev, and tools such as gh, npm init, fly and firebase init)
points the same way. A bare command should do the most useful thing for where it runs.
Help is the fallback when nothing better is known, and it stays one step away. Prompts
only when every stream is a terminal. An onboarding screen should read before it
acts, and should name the command each action stands for.

While checking, a drift turned up. ADR-018's Decision says help still prints outside a
clone when only stdout is redirected, and `test/start.test.ts` pins that. Its
Consequences, ADR-021, the top help, the README and HOW-IT-WORKS card 5 say "with stdout
redirected, it is always status". The code and the test are right. The docs are corrected
here, and ADR-018 and ADR-021 are left as written.

## Decision

- **When stdin, stdout and stderr are all terminals, and the directory isn't a clone
  (including a bare repository), bare `repown` opens a start screen.** It no longer prints
  the top help there.
- **The start screen reads, then asks.** A summary shows the registry's accounts,
  whether gh is git's credential helper, and the clones found below this folder, split
  into set up and not (`identityProblems`). A read that fails says so, never "none".
  Then one menu: set up a clone found here, stop gh serving credentials (only when it
  does), record an account, check this machine, show help, quit.
- **Every action is an existing command's own `run()`,** printed first as the command it
  stands for (`repown setup --cwd <path>`, `repown fix`, `repown accounts add`,
  `repown doctor`). Setting up a found clone continues into setup in that clone. Quit,
  Esc and Ctrl-C change nothing.
- **Discovery is bounded and quieter than `scan`.** It uses scan's walk, 2 levels deep,
  and skips dot-directories, `node_modules` and, on Windows, `AppData`. It lists at most
  20 clones and points to `repown scan` for the rest. `repown scan` itself is unchanged.
- **Every other path is unchanged.** Inside a clone it is setup (ADR-021). With stdout
  redirected outside a clone it is the top help, exit 0. Without a terminal on stdin or
  stderr it is status, exit 1 outside a clone. Any argument runs as typed.
- **Dispatch stays generic.** `chooseDefault` may return a runner as well as a command
  name or `'help'`, and dispatch uses the runner's exit code. The start screen's modules
  load only through that runner, so `guard check` and typed commands never load them.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep the help, with a better first line | Still leaves the newcomer to work out the next command. |
| Guided text with no prompts | Tells the user what to type, when repown could offer to do it. |
| A machine-only wizard, with no clone discovery | Misses the common case: the clones are one folder down. |
| Start setup and ask for a clone path | Asks the user for something repown can find itself. |
| Scan as deep as `repown scan` (3 levels, every folder) | Too slow and noisy in a home folder (`AppData`, caches). |

## Consequences

- **In a terminal, outside a clone, bare `repown` prompts** where it used to print help and
  exit 0. Quit still exits 0. `repown --help` and `repown help` print the help as before,
  and so does the menu's Show help.
- **One bounded directory walk plus one `inspectRepo` per clone found,** only on this path,
  with a busy line while it runs.
- **The docs name the rule as it is:** status only without a terminal; with stdout
  redirected, status in a clone and the top help outside one.
