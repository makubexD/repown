# ADR-007: No profile store; a per-machine account registry instead

**Status:** Accepted

## Context

An earlier design had a JSON identity store, with commands to capture, define, use,
list, forget and restore identities within one clone. Nothing needs that. A clone
belongs to one account, permanently. What gets switched is the CLI's active account,
and that's gh's business ([ADR-001](ADR-001-credential-manager-not-gh.md)).

## Decision

- **Identity is repo-local git config, set once.** `.git/config` can't be committed any
  more than the JSON file could, and needs no custom code.
- **Account details are recorded once per machine.** `repown use <account>` needs a name
  and an address, and asking for them in every repository makes a tool annoying enough
  to go unused. So they live in `accounts.json`, outside every repository.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A per-clone profile store | Duplicates what `.git/config` already is. |
| Ask the host API on every `use` | Needs the network and prompts on every run. |

## Consequences

- The registry holds no per-clone state and switches nothing. It's a lookup table so
  that `repown use` needs only one word.
- On a new machine, you add the accounts again or copy the registry across.
