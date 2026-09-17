// Unpin this clone, leaving it exactly as it was found.
//
// Only the repo-local keys are touched. Global config is never edited here --
// this is the command you run when handing a machine back or when a clone should
// go back to inheriting the machine default, and it should be able to do that
// without being able to break anything else.

import { inspectRepo } from '../core/inspect.ts';
import { clearIdentity } from '../core/identity.ts';
import { gitFor, type Args } from '../cli.ts';
import * as out from '../ui/format.ts';

export default {
  summary: 'unpin this clone (leaves global config alone)',
  usage: 'gid off',

  async run(args: Args): Promise<number> {
    const git = gitFor(args);
    const repo = await inspectRepo(git);
    if (!repo.isRepo) { out.fail('off', 'Not a git repository: ' + git.cwd); return 1; }

    const had = repo.identity.name ?? repo.identity.email ?? repo.identity.account;
    await clearIdentity(git, repo.credentialKeys);

    if (!had) { out.warn('off', 'this clone was not pinned; nothing to remove.'); }
    else { out.pass('off', 'repo-local identity removed from ' + (repo.root ?? git.cwd)); }

    out.line();
    out.line('  This clone now inherits the machine default:');
    out.field('commits as', describe(repo.identity.inheritedName, repo.identity.inheritedEmail));
    if (repo.credentialKeys.length > 0) {
      out.field('pushes as', repo.identity.inheritedAccount ?? 'nothing pinned');
    }
    out.line();
    if (repo.guard !== 'off') {
      out.warn('guard', 'still installed. It now checks against the INHERITED identity.');
      out.detail('remove it too: gid guard off');
    }
    return 0;
  },
};

function describe(name: string | null, email: string | null): string {
  if (!name && !email) return 'nothing set anywhere -- git will refuse to commit';
  return (name ?? '?') + ' <' + (email ?? '?') + '>';
}
