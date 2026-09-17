// Hand credential serving back to whatever was configured before
// `gh auth setup-git` took it over.
//
// It edits global -- and possibly system -- config, so it shows exactly what it
// will remove, and the undo, BEFORE asking. A change to machine-wide config
// should be reviewable rather than magic.

import { inspectAuth } from '../core/inspect.ts';
import { planRepair, repair, describeValue, type RemovalOutcome } from '../core/credential/repair.ts';
import { confirm, interactive } from '../ui/prompt.ts';
import { flagBool, gitFor, type Args } from '../cli.ts';
import * as out from '../ui/format.ts';

export default {
  summary: 'undo `gh auth setup-git` so per-repo account pins work again',
  usage: 'gid fix [--yes] [--dry-run]',

  async run(args: Args): Promise<number> {
    const git = gitFor(args);
    const planned = await planRepair(git);

    if (planned.length === 0) {
      out.pass('fix', 'nothing to undo -- gh is not installed as a credential helper.');
      return 0;
    }

    preview(planned);
    if (flagBool(args, 'dry-run')) { out.line('  (dry run -- nothing was changed)'); out.line(); return 0; }

    if (!flagBool(args, 'yes')) {
      if (!interactive()) {
        out.fail('fix', 'this changes global config, so it needs confirmation.');
        out.detail('re-run with --yes to proceed without being asked.');
        return 1;
      }
      if (!await confirm('Remove these entries?')) { out.line('  Nothing was changed.'); return 1; }
    }

    return apply(await repair(git), git);
  },
};

function preview(planned: readonly RemovalOutcome[]): void {
  out.line();
  out.line('  These entries make gh the credential helper, and will be removed:');
  out.line();
  for (const entry of planned) {
    out.line('    ' + entry.scope + ':  ' + entry.key);
    for (const value of entry.values) out.line('        = ' + describeValue(value));
  }
  out.line();
  out.line('  Nothing else in your config is touched.');
  out.line('  Undo at any time:  gh auth setup-git');
  out.line();
}

async function apply(results: readonly RemovalOutcome[], git: ReturnType<typeof gitFor>): Promise<number> {
  const failed = results.filter((entry) => !entry.removed);
  for (const entry of results.filter((candidate) => candidate.removed)) {
    out.pass('fix', 'removed  ' + entry.scope + ': ' + entry.key);
  }
  for (const entry of failed) {
    out.warn('fix', 'could NOT remove  ' + entry.scope + ': ' + entry.key);
    if (entry.scope === 'system') {
      out.detail('the system scope is machine-wide; re-run this in an ELEVATED shell.');
    }
  }

  out.line();
  const auth = await inspectAuth(git);
  out.field('helper now', auth.helper ?? 'none', 16);
  out.field('accounts', auth.stored.ok ? auth.stored.value.join(', ') || 'none' : 'unknown', 16);
  out.line();
  if (failed.length > 0) return 1;

  out.line('  Each clone now authenticates as its own pinned account. Check one:  gid');
  out.line();
  return 0;
}
