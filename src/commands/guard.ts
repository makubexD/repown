// The pre-push guard: turning it on, off, and running the check itself.
//
// `guard check` is what the installed hook invokes, with the exact syntax baked
// into every hook already on disk (src/core/guard/hook.ts) -- `--remote` and
// `--url` on this action are a frozen contract, not just today's flags.

import { installGuard, uninstallGuard, guardState } from '../core/guard/hook.ts';
import { check, type Refusal } from '../core/guard/check.ts';
import { flagString, gitFor, type Args } from '../ui/args.ts';
import type { Command, CommandGroup } from '../ui/command.ts';
import * as out from '../ui/format.ts';

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

const onAction: Command = {
  summary: 'install the pre-push hook',
  examples: ['gid guard on'],
  run: enable,
};

const offAction: Command = {
  summary: 'remove the pre-push hook',
  examples: ['gid guard off'],
  run: disable,
};

const statusAction: Command = {
  summary: 'show whether the guard is installed',
  run: status,
};

const checkAction: Command = {
  summary: 'run the check the installed hook calls (not for direct use)',
  options: [
    { name: 'remote', kind: 'string', default: 'origin', help: 'the remote name being pushed to' },
    { name: 'url', kind: 'string', default: '', help: 'the remote URL being pushed to' },
  ],
  run: runCheck,
};

export default {
  summary: 'check every push before it leaves (gid guard on | off | status)',
  defaultAction: 'status',
  actions: { on: onAction, off: offAction, status: statusAction, check: checkAction },
  aliases: { enable: 'on', disable: 'off' },
} satisfies CommandGroup;
