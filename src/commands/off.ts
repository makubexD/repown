// Unpin this clone, leaving it exactly as it was found.
//
// Only the repo-local keys are touched. Global config is never edited here --
// this is the command you run when handing a machine back or when a clone should
// go back to inheriting the machine default, and it should be able to do that
// without being able to break anything else.

import { inspectRepo, type RepoState } from '../core/inspect.ts';
import { clearIdentity } from '../core/identity.ts';
import { gitFor, type Args } from '../ui/args.ts';
import type { Command } from '../ui/command.ts';
import * as out from '../ui/format.ts';

export default {
  summary: 'unpin this clone (leaves global config alone)',
  examples: ['repown off'],

  async run(args: Args): Promise<number> {
    const git = gitFor(args);
    const repo = await inspectRepo(git);
    if (!repo.isRepo) { out.fail('off', 'Not a git repository: ' + git.cwd); return 1; }

    const id = repo.identity;
    const had = id.name ?? id.email ?? id.owner ?? id.account;
    const failed = (await clearIdentity(git, repo.credentialKeys)).filter((outcome) => !outcome.written);
    if (failed.length > 0) {
      out.fail('off', 'could not remove ' + failed.map((outcome) => outcome.key).join(', '));
      out.detail('this clone is still (partly) pinned -- is .git/config locked by another git?');
      return 1;
    }
    if (!had) out.warn('off', 'this clone was not pinned; nothing to remove.');
    else out.pass('off', 'repo-local identity removed from ' + (repo.root ?? git.cwd));

    await reportInherited(git, repo);
    return 0;
  },
} satisfies Command;

/** Read AFTER the clear: before it, the "inherited" value is still the local one. */
async function reportInherited(git: RepoState['git'], before: RepoState): Promise<void> {
  const id = (await inspectRepo(git)).identity;
  out.line();
  out.line('  This clone now inherits the machine default:');
  out.field('commits as', describe(id.inheritedName, id.inheritedEmail));
  if (before.credentialKeys.length > 0) out.field('pushes as', id.inheritedAccount ?? 'nothing pinned');
  out.line();
  if (before.guard === 'on') {
    out.warn('guard', 'still installed, and with no identity pinned it will refuse every push.');
    out.detail('remove it too: repown guard off   (or pin again: repown use <account>)');
  }
}

function describe(name: string | null, email: string | null): string {
  if (!name && !email) return 'nothing set anywhere -- git will refuse to commit';
  return (name ?? '?') + ' <' + (email ?? '?') + '>';
}
