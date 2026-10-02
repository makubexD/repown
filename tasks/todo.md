# Start-screen gaps

Status: Phase 5 done; GATE 5 waiting.

- [x] 1. Plan: SPEC.md + tasks/todo.md
- [x] 2. G1 + G6: the text question's gutter follows clack's bar; `type < to go back` stays whole
- [x] 3. G3: a profile lookup that knows "no such user"; `accounts add` warns
- [x] 4. G2 + G7 + G8 + G3: Record an account asks login, host, name, email in the frame
- [x] 5. G4: ADR-028, the start screen returns to its menu after a machine-level action
- [x] 6. G5: `repown use <account>` accented after `accounts add`
- [x] Phase 5: review (code-reviewer + docs drift), fixes folded in
- [ ] Phase 6: close-out

## Queued after close-out (not this feature)
- Test-suite speed, as its own architecture feature (user, 2026-10-02): parallelism and/or
  cheaper algorithms, without losing any test or what it proves. Start with measurement.
  Known facts: `node --test "test/*.test.ts"` already runs files in parallel (8 cores here,
  so 7 at once); about 12-15 min per full run on this Windows machine; `status` spawns about 60
  processes; the 2026-09 spec (PR #7) deferred "reduce repown's own git spawns" to a later
  spec + ADR.
