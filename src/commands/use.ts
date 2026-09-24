// Pin this clone to one account.
//
// A clone belongs to ONE account, permanently. This writes repo-local git config
// and is not run again:
//
//   user.name
//   user.email
//   user.useConfigOnly            git refuses to invent an identity from the hostname
//   credential.<host>.username    which stored credential serves this remote
//
// NOTHING IS WRITTEN TO THE REPOSITORY. All of it lands in .git/config, which git
// never tracks -- which is what keeps a name or address out of a public repo, and
// also why this is per clone: a second machine, or a re-clone, runs it again.
//
// You do not switch this afterwards, and you do not need to. Changing which
// account the GitHub CLI acts as is `gh auth switch`, which after `repown fix` has
// no effect on git at all -- `--gh` does both at once for when you want them to
// agree.

import { inspectRepo, inspectAuth, type RepoState } from '../core/inspect.ts';
import { pinIdentity } from '../core/identity.ts';
import { lookupAccount, saveAccount, type Account } from '../core/registry.ts';
import { ghSwitch } from '../core/credential/gh.ts';
import { allowedOwners, shellWord } from '../core/guard/check.ts';
import { ask, interactive } from '../ui/prompt.ts';
import { flagString, flagBool, gitFor, type Args } from '../ui/args.ts';
import type { Command } from '../ui/command.ts';
import * as out from '../ui/format.ts';

export default {
  summary: 'pin this clone to an account (repown use <account>)',
  positionals: { min: 1, max: 1, label: '<account>' },
  options: [
    { name: 'gh', kind: 'boolean', help: "also switch the GitHub CLI's active account to match" },
    { name: 'name', kind: 'string', help: 'the commit author name (skips the registry and the prompt)' },
    { name: 'email', kind: 'string', help: 'the commit author email (skips the registry and the prompt)' },
  ],
  examples: ['repown use octocat', 'repown use octocat --gh'],

  async run(args: Args): Promise<number> {
    const account = args.positional[0]!;
    const git = gitFor(args);
    const repo = await inspectRepo(git);
    if (!repo.isRepo) { out.fail('use', 'Not a git repository: ' + git.cwd); return 1; }

    const values = await resolveAccount(account, repo, args);
    if (!values) return 1;

    const outcomes = await pinIdentity(git, { ...values, account }, repo.credentialKeys);
    const failed = outcomes.filter((outcome) => !outcome.written);
    if (failed.length > 0) {
      out.fail('use', 'could not write ' + failed.length + ' of ' + outcomes.length + ' keys.');
      for (const outcome of failed) out.detail(outcome.key);
      out.detail('this clone is NOT pinned -- nothing here reports success it did not have.');
      return 1;
    }
    out.pass('identity', values.name + ' <' + values.email + '>  push-as:' + account);

    if (flagBool(args, 'gh')) await switchCli(account);
    await reportConcerns(account, repo);
    return 0;
  },
} satisfies Command;

/** Registry first, then the host, then ask. The registry is why this is usually instant. */
async function resolveAccount(
  account: string,
  repo: RepoState,
  args: Args,
): Promise<Account | null> {
  const flagged = { name: flagString(args, 'name'), email: flagString(args, 'email') };
  if (flagged.name && flagged.email) return { name: flagged.name, email: flagged.email };

  const lookup = await lookupAccount(account);
  if (!lookup.ok) { out.fail('use', lookup.error); return null; }
  const recorded = lookup.value;
  const name = flagged.name ?? recorded?.name;
  const email = flagged.email ?? recorded?.email;
  if (name && email) return { name, email };

  return askAndRecord(account, repo, { name, email });
}

async function askAndRecord(
  account: string,
  repo: RepoState,
  known: { name: string | undefined; email: string | undefined },
): Promise<Account | null> {
  const suggested = (await repo.provider.resolveProfile?.(account)) ?? {};
  if (!interactive()) {
    out.fail('use', 'no record of "' + account + '" and no terminal to ask.');
    out.detail('record it once:  repown accounts add ' + account + ' --name "..." --email "..."');
    return null;
  }
  out.line();
  out.line('  No record of "' + account + '" yet. Asking once, then never again.');

  const name = await ask('Commit name', known.name ?? suggested.name ?? account);
  if (!name.ok) { out.fail('use', name.error); return null; }
  const email = await ask('Commit email', known.email ?? suggested.email);
  if (!email.ok) { out.fail('use', email.error); return null; }

  const entry: Account = { name: name.value, email: email.value, host: repo.provider.id };
  const saved = await saveAccount(account, entry);
  if (!saved.ok) out.warn('accounts', 'pinned, but not recorded: ' + saved.error);
  out.line();
  return entry;
}

async function switchCli(account: string): Promise<void> {
  const switched = await ghSwitch(account);
  if (switched.ok) out.pass('gh', 'active account switched to ' + account);
  else out.warn('gh', 'could not switch: ' + switched.error);
}

/** Everything that is now true but not yet right. Warnings, never refusals. */
async function reportConcerns(account: string, repo: RepoState): Promise<void> {
  if (repo.credentialKeys.length === 0 && repo.url) {
    out.warn('host', repo.provider.label + ' credentials are not pinned by repown.');
    out.detail('commits are pinned and the guard still runs; only credential');
    out.detail('selection is left to whatever already serves this host.');
  }
  if (repo.owner && repo.owner.toLowerCase() !== account.toLowerCase()) {
    const allowed = await allowedOwners(repo.git, account);
    if (!allowed.includes(repo.owner.toLowerCase())) {
      out.warn('origin', 'origin belongs to "' + repo.owner + '", not "' + account + '".');
      out.detail('normal for an organisation repository. To stop the guard refusing it:');
      out.detail('  git config --local --add repown.allowOwner ' + shellWord(repo.owner));
    }
  }

  const auth = await inspectAuth(repo.git, repo.originUrl ?? undefined);
  if (auth.ghIsHelper) {
    out.warn('helper', 'gh is still the git credential helper, so this pin is not honoured.');
    out.detail('fix: repown fix');
  } else if (auth.gcmPresent && auth.stored.ok && !auth.stored.value.includes(account)) {
    out.line();
    out.line('  No stored credential for "' + account + '" yet -- the first push signs in');
    out.line('  once, then never again. Verify it afterwards: repown doctor');
  }
  if (repo.guard === 'off' && !repo.hook?.redirected) {
    out.line();
    out.line('  Next: repown guard on    (check every push before it leaves)');
  }
}
