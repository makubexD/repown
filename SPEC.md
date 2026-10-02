# SPEC: start-screen gaps (G1-G8)
- **Objective:** close G1-G8.
- **Out of scope:**
  - clack's own Unicode detection, its `—`/`·` choices and its `↑/↓` hint;
  - `pass`'s `OK` becoming ✔ (ADR-027 keeps the status/doctor output);
  - refusing an unknown login (offline and enterprise hosts must still work).
- **Success:**
  1. In ASCII mode, a text question has no `│`; Unicode mode is unchanged.
  2. Record an account asks login → host → name → email in the frame, with Back. Name and
     email are prefilled from the profile (email: the GitHub noreply address). The frame
     closes on `> repown accounts add --host=… --name=… --email=… -- <login>`, and no
     readline prompt follows.
  3. A 404 login gives a note and the login question again, prefilled. Typing the same
     login again accepts it. An organisation gets its own note. Offline or any other gh
     failure stays silent. Typed `accounts add` prints a `warn` on 404 and still records.
  4. After Record an account, Check this machine or Stop gh serving credentials, a new
     frame opens with a fresh summary and the menu. Setup, Show help and Quit still end.
     Quit exits 0; Esc/Ctrl-C exit 130.
  5. `repown use x` is cyan where stdout has colour.
  6. `type < to go back` is never split.
  7. An already-recorded login (any case) is refused with setup's wording.
  8. The host is asked, defaulting to GitHub.
- **Riskiest assumption:** that gh's 404 is recognisable: stderr contains `(HTTP 404)`
  (seen above). Anything else is "unknown".
- **Open questions:** none.

