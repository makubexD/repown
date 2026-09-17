// What `gid` with no arguments prints: is this clone set up correctly?
//
// Three separate things decide who you are here, and they fail differently:
//
//   user.name / user.email            who AUTHORED the commit
//   credential.<host>.username        which stored credential serves the push
//   the CLI's active account          who `gh pr create` acts as
//
// All three are printed, because the one that is invisible is the one that
// catches people out. This reports; it changes nothing.

import { inspectRepo, inspectAuth, activeAccountLabel, type RepoState, type AuthState } from '../core/inspect.ts';
import { isPinned } from '../core/identity.ts';
import { gitFor, type Args } from '../cli.ts';
import * as out from '../ui/format.ts';

export default {
  summary: 'the state of this repository and this machine (the default)',
  usage: 'gid [status]',

  async run(args: Args): Promise<number> {
    const git = gitFor(args);
    const repo = await inspectRepo(git);
    if (!repo.isRepo) {
      out.fail('gid', 'Not a git repository: ' + git.cwd);
      out.detail('gid pins an identity per clone, so it needs one to work in.');
      return 1;
    }
    const auth = await inspectAuth(git, repo.originUrl ?? undefined);

    summary(repo, auth);
    const problems = collectProblems(repo, auth);
    reportWarnings(repo, auth);

    if (problems.length === 0) {
      out.pass('identity', 'this clone is pinned, and its credential mechanism honours it');
      return 0;
    }
    out.line();
    for (const problem of problems) { out.fail('identity', problem.what); out.detail('fix: ' + problem.fix); }
    return 1;
  },
};

function summary(repo: RepoState, auth: AuthState): void {
  const id = repo.identity;
  out.line();
  out.field('commits as', id.name ? id.name + ' <' + id.email + '>' : 'NOT SET LOCALLY');
  if (repo.credentialKeys.length > 0) {
    out.field('pushes as', id.account ?? 'NOT SET LOCALLY');
  }
  out.field('origin', (repo.owner ?? 'unknown') + '  ' + out.dim('(' + repo.provider.label + ')'));
  out.field('helper', repo.helper ?? 'none');
  out.field('gh active', activeAccountLabel(auth));
  out.field('push guard', repo.guard);
  out.line();
}

interface Problem { readonly what: string; readonly fix: string; }

function collectProblems(repo: RepoState, auth: AuthState): Problem[] {
  const problems: Problem[] = [];
  const id = repo.identity;

  if (!isPinned(id)) {
    problems.push({
      what: 'This clone sets no identity of its own, so it inherits the machine default (' +
            (id.inheritedEmail ?? 'nothing') + ').',
      fix: 'gid use <account>',
    });
  } else if (repo.credentialKeys.length > 0 && !id.account) {
    problems.push({
      what: 'No account is pinned, so pushes fall back to the machine default (' +
            (id.inheritedAccount ?? 'nothing') + ').',
      fix: 'gid use <account>',
    });
  }
  if (auth.ghIsHelper) {
    problems.push({
      what: 'gh is the git credential helper, so only its ACTIVE account can ' +
            'authenticate and every clone pinned elsewhere is prompted for a password.',
      fix: 'gid fix',
    });
  }
  return problems;
}

function reportWarnings(repo: RepoState, auth: AuthState): void {
  const account = repo.identity.account;

  if (repo.owner && account && repo.owner.toLowerCase() !== account.toLowerCase()) {
    out.warn('origin', 'origin belongs to "' + repo.owner + '" but this clone pushes as "' + account + '".');
  }
  guardWarning(repo);

  // The unknown case is REPORTED, never skipped. Guarding this on the active
  // account being truthy is how a failed lookup used to make the whole warning
  // disappear, leaving output that looked clean rather than uncertain.
  if (auth.ghPresent && !auth.gh.ok) {
    out.warn('gh', 'could not be queried, so who `gh pr create` would act as is UNVERIFIED.');
    out.detail('check it yourself: gh auth status');
  } else if (auth.gh.ok && auth.gh.value.active && account &&
             auth.gh.value.active.toLowerCase() !== account.toLowerCase()) {
    out.warn('gh', 'active as "' + auth.gh.value.active + '", so `gh pr create` here would act as that account.');
    out.detail('fix: gh auth switch -u ' + account);
  }
}

function guardWarning(repo: RepoState): void {
  if (repo.guard === 'on') return;
  if (repo.guard === 'off') {
    out.warn('guard', 'off -- pushes are not checked. Enable it: gid guard on');
  } else if (repo.guard === 'legacy') {
    out.warn('guard', 'a hook from the PowerShell tooling is installed; gid did not write it.');
    out.detail('upgrade it in place: gid guard on');
  } else {
    out.warn('guard', 'a pre-push hook gid did not write is installed; it was left alone.');
  }
}
