# ADR-027: The wizard decorates only where it draws colour

**Status:** Accepted.

## Context

A user tried bare `repown` in PowerShell and Git Bash under VS Code and expected colour and
symbols, with nothing to enable. The 0.4.0 wizard did detect the terminal by itself:
@clack/prompts coloured its own symbols (a green ◇, a cyan ◆, a green ●, dim hints) and
drew `T | * >` where Windows can't draw Unicode. But its gutter is bright-black, nearly
invisible on a dark VS Code theme, and nothing repown handed it was coloured: account
names, paths, commands, setup's run report and its closing line. It read as plain text.

The same output also goes to logs, pipes and scripts (`repown setup --no-input 2>log`),
and the tests compare it byte for byte. NO_COLOR, FORCE_COLOR and TERM=dumb are honoured
(`useColour`, decided per stream).

## Decision

- **Nothing is added where there is no colour.** A pipe, a log, `NO_COLOR`, `FORCE_COLOR=0`
  and `TERM=dumb` get exactly the bytes they got before. Marks are part of the decoration,
  not of the words. Two deciders are involved, and both say no in those cases:
  - setup's run report (the closing line, its `> ` and not-run commands) asks `useColour`
    of stderr, through `marked` and `accent`;
  - inside the clack frame, colour follows `node:util`'s `styleText`, as clack's own
    symbols do. It checks stdout, so `repown setup > out.log` draws the frame plain while
    the run report on the terminal is coloured. On Node 20, `styleText` checks no stream;
    the frame is only drawn when stderr has colour (ADR-016), so it never colours a pipe.
- **The wizard's frame is accented.** The title is a black-on-cyan badge. In a
  `Label   value` line drawn as information (the start screen's summary, a step's
  changes), the value is bold cyan, on its continuation lines too. Commands are cyan:
  in the review box (they were dim), on `> ` lines, and on the start screen's hand-over
  line. The review box's other lines stay plain. Styling is applied after wrapping, so
  every line wraps at the width it had without colour.
- **Setup's closing line leads with a mark where stderr has colour:** a green ✔ when done,
  a yellow ▲ when the next push will fail; the blockers under it are indented two columns
  more, so they stay deeper than the marked line. Its step and not-run commands are cyan.
  A stop keeps its red `FAIL` word and gets no mark of its own. The words and exit codes
  are unchanged, with or without `--no-input`.
- **Symbols follow the frame.** `unicodeTerminal()` is a copy of clack 1.8.1's
  `isUnicodeSupported`: every terminal outside Windows except the Linux console
  (`TERM=linux`); on Windows only one that signals it: Windows Terminal (`WT_SESSION`),
  VS Code or Terminus (`TERM_PROGRAM`), `TERM=xterm-256color` (Git Bash's mintty) or
  `alacritty`, CI, cmder, JetBrains. Elsewhere the marks are `+` and `!`. The list is
  copied, not imported, because only clack.ts may import the package (ADR-016); a clack
  upgrade re-checks it.

## Alternatives considered

- **Emoji (✅ ⚠️ ❌).** Brighter, but they are two columns wide on many terminals and one
  on others, which breaks the aligned columns. Rejected.
- **Marks in plain output too.** It would make logs and scripts read differently from
  today and change what the characterization tests lock. Rejected: decoration follows
  colour.
- **The same marks in `repown status` and `doctor`.** Their OK/WARN/FAIL words already
  carry colour, and their layout is what users and docs show. Left for a decision of its
  own.
- **A variable to turn the decoration on.** The point is that nobody has to; NO_COLOR
  already turns it off.
- **Recolouring clack's gutter.** clack hardcodes it; changing it would mean patching
  the library.

## Consequences

- On Windows Terminal, VS Code and macOS/Linux terminals the wizard shows the badge, cyan
  values and commands, and setup closes on ✔ or ▲; on the legacy Windows console the same
  colours, with clack's ASCII frame and `+` or `!`.
- Output without colour is unchanged, so scripts, logs and the existing tests are too.
- clack's own key hint still prints `↑/↓` and `•` on a non-Unicode terminal; that is
  inside the library.

## Notes

- **2026-10-02, the mark changed.** Command lines drawn to copy now start with `$ ` instead
  of `> ` (`COMMAND_MARK`, `src/wizard/review-text.ts`), and the cyan rule above keys on
  it. Pasted whole, `>` is a redirect in sh, bash, zsh, fish, PowerShell and cmd alike: it
  leaves an empty file named `repown` and runs nothing; `$` there is only a harmless
  error. The colour decision itself is unchanged.
