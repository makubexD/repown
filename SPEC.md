# SPEC: start-screen gaps (G1-G8)
- **Objective:** close G1-G8.
- **Out of scope:**
  - clack's own Unicode detection, its `—`/`·` choices and its `↑/↓` hint;
  - `pass`'s `OK` becoming ✔ (ADR-027 keeps the status/doctor output);
  - refusing an unknown login (offline and enterprise hosts must still work).
- **Success:**
  1. In ASCII mode, a text question has no `│`; Unicode mode is unchanged.
  2. Record an account asks login → host → name → email in the frame, with Back. Name and
     email are prefilled from the GitHub lookup (name: the profile's, else the login; email:
     the noreply address built from the account id). The frame closes on
     `> repown accounts add <login> --name … --email …` (`--host` shown only when not
     github; `-- <login>` when it starts with a dash), and no readline prompt follows.
  3. Changed at GATE 4 (user's choice): a 404 login, or an organisation, is named on the
     name question's detail, first, so Back can fix it before anything is recorded; the
     login is not re-asked. Setup's new-account name question shows it too. Offline or
     any other gh failure stays silent. Typed `accounts add` prints a `warn` on 404 and
     still records.
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

