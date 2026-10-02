# Spec: the wizard looks alive by default

## Objective
Bare `repown`, `repown setup` and the start screen look visibly coloured and carry status
marks on a normal terminal, with nothing to set. Where a stream has no colour (a pipe, a
log, `NO_COLOR`, `FORCE_COLOR=0`, `TERM=dumb`) every byte stays as it is today.

Measured on 0.4.0: clack already colours its own symbols (green ◇, cyan ◆, green ●, dim
hints) and falls back to ASCII where Windows can't draw Unicode. Its gutter is bright-black,
nearly invisible on a VS Code dark theme, and nothing repown passes it is coloured: account
names, paths, commands, the run report and the closing `done:` line. It reads as plain text.

## The look ("Accented")
- The title is a black-on-cyan badge.
- In a `Label   value` line the frame shows, the value is bold cyan.
- Command lines (`> repown ...`, review commands) are cyan.
- Setup's closing line leads with a mark: ✔ green (done), ▲ yellow (the next push will
  fail). ASCII where the terminal can't draw Unicode: `+`, `!`. A stop keeps its red FAIL
  word (review: no ✖, nothing would call it).
- No emoji: they are two columns wide on some terminals and break the alignment.

## Boundaries
- Always: TDD, one commit per task, ticking tasks/todo.md. Colour is still decided by
  `useColour` (unchanged). Marks appear only where that stream has colour. Styling is
  applied after wrapping, never measured.
- Ask first: anything in status, doctor or use output; a new env var or flag.
- Never: emoji; change clack's own gutter or hint; import @clack/prompts outside clack.ts
  (ADR-016); push.

## Commands
    npm test · npm run build
    FORCE_COLOR=1 CLICOLOR_FORCE=1 npm test
    NO_COLOR=1 npm test

## Success criteria
1. With colour on, the clack screens show the badge, cyan values and commands; the closing
   line shows its mark.
2. On win32 with none of the Unicode signals (WT_SESSION, TERM_PROGRAM=vscode,
   TERM=xterm-256color, ...), the marks are `+ !`.
3. Without colour, output is byte-identical to today: the characterization and
   wizard-screens tests pass unchanged.
4. Wrapped widths are the same with and without colour.

## Scenarios
| # | Situation | Today | Planned |
|---|---|---|---|
| S1 | Windows Terminal / VS Code, PowerShell | clack symbols coloured, everything else plain | badge, cyan values and commands, ✔ ▲ |
| S2 | Legacy console, no Unicode signal | `T | * >` in colour | same, plus `+ !` marks |
| S3 | `repown setup 2>log`, a pipe, `NO_COLOR=1` | plain | plain, byte-identical |
| S4 | `repown setup --no-input` on a terminal | OK/WARN words coloured | the same, plus the closing mark |
