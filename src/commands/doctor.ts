// What actually supplies a credential on this machine.
//
// This is the answer to "why am I being asked for a password". That failure
// otherwise looks identical to a bad token:
//
//     remote: Invalid username or token. Password authentication is not supported
//     fatal: Authentication failed for 'https://github.com/...'
//
// which appears when the GitHub CLI is the credential helper and its active
// account is not the one the repository asked for. gh serves only its active
// account and returns nothing for any other, so the fix is not a new token -- it
// is to stop gh being the helper.

import { inspectRepo, inspectAuth, activeAccountLabel, storedAccountsLabel, type AuthState } from '../core/inspect.ts';
import { gitFor, type Args } from '../ui/args.ts';
import type { Command } from '../ui/command.ts';
import * as out from '../ui/format.ts';

export default {
  summary: 'what serves credentials on this machine, and to whom',
  examples: ['repown doctor'],

  async run(args: Args): Promise<number> {
    const git = gitFor(args);
    const repo = await inspectRepo(git);
    const auth = await inspectAuth(git, repo.originUrl ?? undefined);

    out.line();
    out.field('helper', auth.helper ?? 'none configured', 18);
    out.field('stored accounts', storedAccountsLabel(auth), 18);
    out.field('gh accounts', ghAccountsLabel(auth), 18);
    out.field('gh active', activeAccountLabel(auth), 18);
    if (auth.gcmPath) out.line(out.dim('  ' + ' '.repeat(18) + ' ' + auth.gcmPath));
    out.line();

    if (auth.ghIsHelper) return diagnoseGhHelper(auth);
    if (!auth.helperIsGcm) return diagnoseUnknownHelper(auth);
    return diagnoseHealthy(auth, repo.provider.label);
  },
} satisfies Command;

function ghAccountsLabel(auth: AuthState): string {
  if (!auth.ghPresent) return 'not installed';
  if (!auth.gh.ok) return 'unknown -- gh could not be queried';
  const logins = auth.gh.value.accounts.map((account) => account.login);
  return logins.length > 0 ? logins.join(', ') : 'none';
}

function diagnoseGhHelper(auth: AuthState): number {
  out.fail('helper', 'gh is the credential helper for github.com.');
  out.detail('It serves ONLY its active account and returns nothing for any');
  out.detail('other, so every repository pinned to a different account is');
  out.detail('prompted for a password -- and `gh auth switch` moves the problem');
  out.detail('rather than fixing it.');

  // On its own line, and only when known: interpolating it inline printed an
  // empty "()" whenever gh could not be queried, which reads as a bug.
  if (auth.gh.ok && auth.gh.value.active) out.detail('Active right now: ' + auth.gh.value.active);

  const files = [...new Set(auth.ghHelperOrigins.map((entry) => entry.file))];
  if (files.length > 0) {
    out.detail('');
    out.detail('Installed by `gh auth setup-git`, in:');
    for (const file of files) out.detail('  ' + file);
  }
  out.line();
  out.line('  fix: repown fix');
  out.line();
  return 1;
}

function diagnoseUnknownHelper(auth: AuthState): number {
  out.warn('helper', 'github.com is served by "' + (auth.helper ?? 'nothing') +
                     '", which repown has no opinion about.');
  out.detail('The per-repository pin (credential.<url>.username) only works if');
  out.detail('that helper honours it.');
  out.line();
  return 0;
}

function diagnoseHealthy(auth: AuthState, providerLabel: string): number {
  out.line('  Credentials come from Git Credential Manager, which stores one per');
  out.line('  account and picks per repository from credential.<url>.username. No');
  out.line('  switching is needed for git, and `gh auth switch` affects the CLI only.');
  out.line();
  if (auth.stored.ok && auth.stored.value.length === 0) {
    out.warn('store', 'no accounts stored yet -- the first push will sign in once.');
    out.line();
  }
  ssoNote(providerLabel);
  return 0;
}

// Not a check -- repown cannot see this coming (docs/DECISIONS.md, "Deliberately
// not done"). A credential that is otherwise healthy still fails the moment
// it touches an org it is not SSO-authorized for, and that failure looks
// identical to a bad token. Printed unconditionally so it is there before it
// is needed. The exact fix command is gh-specific, so it only names `gh` for
// a GitHub origin -- gh does not manage auth for any other host.
function ssoNote(providerLabel: string): void {
  out.line('  If a push or fetch still fails right after this, the credential may');
  out.line('  be valid but not yet SSO-authorized for that organisation. Re-authorize it:');
  out.line(providerLabel === 'GitHub'
    ? '  gh auth refresh -h <host>, or via the org\'s SSO settings.'
    : "  check your git host's SSO / conditional-access settings.");
  out.line();
}
