// A guided first setup of this clone, for someone new to repown: which account it
// belongs to (recorded once if new), pushes to an organisation, the guard, and gh
// as the credential helper. It asks, shows the commands its answers stand for, and
// runs exactly those -- `accounts add`, `use`, `guard on`, `fix` -- so anything it
// does can be done, or scripted, without it (src/wizard/setup-run.ts).

import { providers } from '../core/hosts/index.ts';
import { interactive } from '../ui/prompt.ts';
import type { Command } from '../ui/command.ts';
import { runSetup } from '../wizard/setup-run.ts';

export default {
  summary: 'guided setup of this clone: asks, shows the commands, then runs them',
  positionals: { min: 0, max: 1, label: '<account>' },
  options: [
    { name: 'name', kind: 'string', help: 'commit name, for an account not yet recorded' },
    { name: 'email', kind: 'string', help: 'commit email, for an account not yet recorded' },
    { name: 'host', kind: 'string', choices: providers().map((provider) => provider.id), help: 'host of an account not yet recorded' },
    { name: 'gh', kind: 'boolean', help: "also switch the GitHub CLI's active account (use --gh)" },
    { name: 'allow-owner', kind: 'string', help: "allow pushes to origin's owner, an organisation (repown.allowOwner)" },
    { name: 'guard', kind: 'boolean', help: 'turn the push guard on (guard on)' },
    { name: 'fix', kind: 'boolean', help: 'stop gh being the credential helper (fix --yes)' },
    { name: 'no-input', kind: 'boolean', help: 'ask nothing: run with the flags given, or exit 2 naming what is missing' },
  ],
  examples: ['repown setup', 'repown setup octocat --guard --no-input'],
  run: (args) => runSetup(args, { interactive: interactive() }),
} satisfies Command;
