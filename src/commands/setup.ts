// A guided first setup of this clone, for someone new to repown. The first question is
// how it should work: Recommended fills in the guard, upstream and a gh switch, and
// still asks when origin belongs to someone else. Step by step asks each one.
// It shows the commands its answers stand for, and runs exactly those --
// `accounts add`, `use`, `guard on`, `fix` -- so anything it
// does can be done, or scripted, without it (src/wizard/setup-run.ts).

import { providers } from '../core/hosts/index.ts';
import { interactive } from '../ui/prompt.ts';
import type { Command } from '../ui/command.ts';
import { runSetup } from '../wizard/setup-run.ts';

export default {
  summary: 'guided setup of this clone: asks, shows each step and its command, then runs them',
  positionals: { min: 0, max: 1, label: '<account>' },
  options: [
    { name: 'name', kind: 'string', help: 'commit name, for an account not yet recorded' },
    { name: 'email', kind: 'string', help: 'commit email, for an account not yet recorded' },
    { name: 'host', kind: 'string', choices: providers().map((provider) => provider.id), help: "host of an account not yet recorded (default: origin's host)" },
    { name: 'gh', kind: 'boolean', help: "also switch the GitHub CLI's active account (use --gh)" },
    { name: 'allow-owner', kind: 'string', help: "allow pushes to origin's owner: an organisation, or an account you collaborate with (repown.allowOwner)" },
    { name: 'guard', kind: 'boolean', help: 'turn the push guard on (guard on)' },
    { name: 'auto-upstream', kind: 'boolean', help: 'push new branches without -u, in this clone only (push.autoSetupRemote)' },
    { name: 'fix', kind: 'boolean', help: 'stop gh being the credential helper, where it is (fix --yes)' },
    { name: 'step-by-step', kind: 'boolean', help: 'ask every question instead of the recommended answers (not with --no-input)' },
    { name: 'no-input', kind: 'boolean', help: 'ask nothing: a question not given as a flag is No; exit 2 if the account is incomplete' },
  ],
  examples: ['repown setup', 'repown setup octocat --guard --no-input'],
  run: (args) => runSetup(args, { interactive: interactive() }),
} satisfies Command;
