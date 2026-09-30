// `repown reauthor`: give this branch's unpushed commits by another address the pinned
// identity, so the guard lets them through. It fetches the push destination first, rewrites
// only commits no remote has, keeps a backup ref, and never pushes (ADR-026).

import { planReauthor, applyReauthor, type ReauthorPlan } from '../core/reauthor.ts';
import { confirm, interactive } from '../ui/prompt.ts';
import { flagBool, gitFor, type Args } from '../ui/args.ts';
import type { Command } from '../ui/command.ts';
import type { Git } from '../core/git.ts';
import * as out from '../ui/format.ts';
import { printable } from '../ui/format.ts';

export default {
  summary: 'rewrite this branch\'s unpushed commits by another address as the pinned account',
  options: [
    { name: 'yes', kind: 'boolean', help: 'rewrite without asking to confirm' },
  ],
  examples: ['repown reauthor', 'repown reauthor --yes'],

  async run(args: Args): Promise<number> {
    const git = gitFor(args);
    const email = await git.getConfig('user.email', 'local') ?? '';
    out.detail('fetching the push destination first, so only what it lacks is rewritten');
    const planned = await planReauthor(git, email, interactive());
    if (!planned.ok) { out.fail('reauthor', printable(planned.error)); return 1; }
    if (!planned.value) { out.pass('reauthor', 'nothing to re-author: every unpushed commit here is by ' + printable(email)); return 0; }
    preview(planned.value, email);
    if (!await confirmed(args)) return 1;
    return apply(git, planned.value, email);
  },
} satisfies Command;

function preview(plan: ReauthorPlan, email: string): void {
  const noun = plan.count === 1 ? '1 commit' : plan.count + ' commits';
  out.detail(noun + ' on ' + printable(plan.branch) + ' that ' + printable(plan.remote) + ' does not have will carry ' + printable(email) +
    ' (now by ' + plan.addresses.map(printable).join(', ') + ')');
  out.detail('from ' + (plan.base === '--root' ? 'the first commit' : plan.base.slice(0, 12)) + ' on; their author dates are reset, and a backup is kept');
}

async function confirmed(args: Args): Promise<boolean> {
  if (flagBool(args, 'yes')) return true;
  if (!interactive()) {
    out.fail('reauthor', 'this rewrites commits, so it needs confirmation.');
    out.detail('re-run with --yes to proceed without being asked.');
    return false;
  }
  if (await confirm('Rewrite these commits?')) return true;
  out.warn('reauthor', 'declined; nothing was changed.');
  return false;
}

async function apply(git: Git, plan: ReauthorPlan, email: string): Promise<number> {
  const done = await applyReauthor(git, plan, email);
  if (!done.ok) { out.fail('reauthor', printable(done.error)); return 1; }
  const noun = done.value.count === 1 ? '1 commit' : done.value.count + ' commits';
  out.pass('reauthor', noun + ' now by ' + printable(email));
  out.detail('undo: git reset --keep ' + printable(done.value.backup) + ' (drops commits made since)');
  out.detail('nothing was pushed: git push when you are ready');
  return 0;
}
