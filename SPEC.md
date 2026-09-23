# Spec: gid -> repown, public, richer README

Temporary. Deleted at close-out once every fact has its permanent home.

## Objective

repown is public at github.com/makubexD/repown, with no personal email anywhere in its
history. A reader understands it from the README, including why not the alternatives, and
sees it work in a demo.

The name: **repown** = repo + own, "each repo owns its identity". With it you can have 8
repos on 8 accounts, providers or sign-in methods, jump back to any of them, and pull, push
and commit just work. `gid` was unclear and is taken on npm.

## Success criteria

1. `git log --all --format='%ae%n%ce' | sort -u` shows only
   `makubexD@users.noreply.github.com`. This is checked again right before going public.
2. `repown --help` works, and `git grep -iw gid` matches only the DECISIONS "formerly gid"
   note. Renamed: the package name and bin, `repown.mirrorBranch` / `repown.allowOwner`,
   `REPOWN_CONFIG_DIR`, the registry folder `repown`, the hook marker, variables and
   messages, help, CI, and the docs.
3. Clean break: no fallback for old keys, the old env var or the old registry. One exception:
   a hook with the old `gid-identity-guard` marker is treated as legacy, so `repown guard on`
   replaces it.
4. The README gains a comparison with the alternatives, badges, a status note, an FAQ, and a
   demo GIF from a committed VHS script (placeholder identities only). There is an MIT
   `LICENSE` ("Copyright (c) 2026 makubexD").
5. `npm test`, `npm run build` and CI all pass.

## Out of scope

npm publishing; renaming the local folder; new features; migration code beyond the hook
exception.

## Boundaries

- Always: commits use `makubexD <makubexD@users.noreply.github.com>`; stage files by name.
- Ask first (⚠, an explicit go each time): the history rewrite and force-push; the repo
  rename and the switch to public; installing VHS.
- Never: push without that go; put personal names or addresses in files or commits.
