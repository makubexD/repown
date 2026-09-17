// The pre-push guard: turning it on, off, and running the check itself.
//
// `guard check` is what the hook invokes. It reads the pushed ref lines from
// stdin and exits non-zero to stop the push.

import { installGuard, uninstallGuard, guardState } from '../core/guard/hook.ts';
import { check, type Refusal } from '../core/guard/check.ts';
import { flagString, gitFor, type Args } from '../cli.ts';
import * as out from '../ui/format.ts';

export default {
  summary: 'check every push before it leaves (gid guard on | off | check)',
  usage: 'gid guard on | off | status | check',

  async run(args: Args): Promise<number> {
    const action = args.positional[0] ?? 'status';
    if (action === 'on' || action === 'enable') return enable(args);
    if (action === 'off' || action === 'disable') return disable(args);
    if (action === 'check') return runCheck(args);
    if (action === 'status') return status(args);

    out.fail('guard', 'Unknown action: ' + action);
    out.detail('known: on, off, status, check');
    return 2;
  },
};

async function status(args: Args): Promise<number> {
  out.field('push guard', await guardState(gitFor(args)));
  return 0;
}

async function enable(args: Args): Promise<number> {
  const installed = await installGuard(gitFor(args));
  if (!installed.ok) { out.fail('guard', installed.error); return 1; }

  if (installed.value.replaced === 'legacy') {
    out.pass('guard', 'upgraded the PowerShell-era hook, and removed its copies under .git/fork-guard');
  } else {
    out.pass('guard', 'on -- every push is checked before it leaves');
  }
  out.line(out.dim('  ' + installed.value.path));
  return 0;
}

async function disable(args: Args): Promise<number> {
  const removed = await uninstallGuard(gitFor(args));
  if (!removed.ok) { out.fail('guard', removed.error); return 1; }
  if (!removed.value) { out.warn('guard', 'was not installed; nothing to remove.'); return 0; }

  out.pass('guard', 'off -- pushes are no longer checked');
  return 0;
}

async function runCheck(args: Args): Promise<number> {
  const refusals = await check({
    git: gitFor(args),
    remote: flagString(args, 'remote') ?? 'origin',
    url: flagString(args, 'url') ?? '',
    stdin: await readStdin(),
  });

  if (refusals.length === 0) {
    out.pass('guard', 'every commit in this push carries this clone’s identity');
    return 0;
  }
  report(refusals);
  return 1;
}

function report(refusals: readonly Refusal[]): void {
  out.line();
  for (const refusal of refusals) {
    out.fail('guard', refusal.reason);
    for (const line of refusal.detail) out.detail(line);
    out.line();
  }
}

/** Empty when nothing is piped in, so `gid guard check` by hand is not a hang. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
