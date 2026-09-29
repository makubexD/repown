# Implementation Plan: setup leaves the clone push-ready

Spec: [../SPEC.md](../SPEC.md). Tasks: [todo.md](todo.md).

## Overview

Three capabilities, built bottom-up so every commit leaves repown working:
1. **Know** what blocks the next push (offline reads → a pure blocker list), and say it
   (setup review, settled screen, closing line, status).
2. **Fix** what setup can fix: repoint a sign-in URL, fetch the destination (reviewed steps).
3. **Rewrite** only when asked: `repown reauthor`, then setup's opt-in step that runs it.

## Architecture decisions

- Blockers are data (`src/wizard/blockers.ts`, pure), read once in `setup-context.ts`
  and re-read after the run for the closing line. Status reuses the same builder.
- `repown reauthor` is a real command (`src/commands/reauthor.ts`); setup runs its `run()`
  like `use` and `fix` (`commandFor` in setup-run). No wizard-only behaviour.
- Fetch and rebase go through `Git` / `exec.ts` (`env` already supported): prompts off via
  `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`.
- Rebase base: parent of the oldest foreign unpushed commit (never the user's own).
- ADR-026 lands before any code that rewrites (task 5), with the amendments' status lines.

## Dependency graph

    T1 locks → T2 base → T3 blockers → T4 setup/closing → T8 status
                                   ├→ T5 reauthor ─┐
                                   └→ T6 repoint + fetch → T7 setup re-author step

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A rewrite touches published commits | High | fetch first; foreign-only base; a test proves the push is a fast-forward past the guard |
| Rebase conflict or failure mid-way | Med | clean tree required; `rebase --abort`; backup ref; test |
| Fetch prompts or hangs | Med | prompts off, `exec` timeout; failure = unknown |
| Clean clones' output drifts | Med | T1 characterization tests first |
| Windows `--exec` quoting | Med | git runs `--exec` through its own sh; CI covers three OSes |
