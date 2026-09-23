// Renders help from the same declarations the parser validates against, so
// help can never promise an option or a positional the parser would refuse.
//
// Side-effect free: nothing here writes output, prints go through cli.ts's own
// `out.line` calls, and nothing here is reachable except by an explicit
// `--help`/`-h`/`help` request. A command's `run()` never sees a help request --
// cli.ts intercepts it before parsing the command's own arguments.

import { GLOBAL_OPTIONS, type OptionSpec } from './args.ts';
import { isGroup, optionsOf, type Command, type CommandGroup } from './command.ts';

export function renderTopHelp(entries: ReadonlyMap<string, Command | CommandGroup>): string[] {
  return [
    ...topHeader(entries),
    ...globalOptionsHelp(),
    ...environmentHelp(),
    '  Exit codes: 0 success, 1 failure or refusal, 2 usage error.',
    '',
  ];
}

function topHeader(entries: ReadonlyMap<string, Command | CommandGroup>): string[] {
  const lines = ['', '  repown <command> [options]', ''];
  for (const [name, entry] of entries) lines.push('  ' + name.padEnd(10) + entry.summary);
  lines.push('', '  Run `repown` with no command for the state of this repository.');
  lines.push('  Run `repown help <command>` for its options.', '');
  return lines;
}

function globalOptionsHelp(): string[] {
  const lines = ['  Global options:'];
  for (const option of GLOBAL_OPTIONS) lines.push('    ' + optionHelp(option));
  lines.push('    ' + '--help, -h'.padEnd(20) + 'show help for the command');
  lines.push('    ' + '--version, -v'.padEnd(20) + 'show the installed version', '');
  return lines;
}

function environmentHelp(): string[] {
  return [
    '  Environment:',
    '    ' + 'REPOWN_CONFIG_DIR'.padEnd(20) + 'where the per-machine account registry lives',
    '    ' + 'NO_COLOR'.padEnd(20) + 'disable colored output when set to a non-empty value',
    '    ' + 'FORCE_COLOR'.padEnd(20) + 'force colored output even when not a terminal',
    '',
  ];
}

export function renderCommandHelp(path: readonly string[], command: Command): string[] {
  const lines = ['', '  ' + usageFor(path, command), ''];
  if (optionsOf(command).length > 0) lines.push(...optionsHelp(command), '');
  if (command.examples && command.examples.length > 0) lines.push(...examplesHelp(command.examples), '');
  return lines;
}

export function renderGroupHelp(path: readonly string[], group: CommandGroup): string[] {
  const lines = ['', '  repown ' + path.join(' ') + ' <action> [options]', '', '  Actions:'];
  for (const [name, action] of Object.entries(group.actions)) {
    const marker = name === group.defaultAction ? '  (default)' : '';
    lines.push('    ' + name.padEnd(10) + action.summary + marker);
  }
  lines.push('', '  Run `repown help ' + path.join(' ') + ' <action>` for its options.', '');
  return lines;
}

export function renderHelpFor(path: readonly string[], entry: Command | CommandGroup): string[] {
  return isGroup(entry) ? renderGroupHelp(path, entry) : renderCommandHelp(path, entry);
}

function usageFor(path: readonly string[], command: Command): string {
  const positionals = positionalUsage(command);
  const options = optionsOf(command).map(optionUsageToken).join(' ');
  return ['repown', ...path, positionals, options].filter((part) => part.length > 0).join(' ');
}

function positionalUsage(command: Command): string {
  const spec = command.positionals;
  if (!spec || spec.max === 0) return '';
  const label = spec.label ?? '<arg>';
  const shown = spec.max === Infinity ? label + '...' : label;
  return spec.min === 0 ? '[' + shown + ']' : shown;
}

function optionUsageToken(option: OptionSpec): string {
  const value = option.kind === 'boolean' ? '' : ' ' + (option.choices?.join('|') ?? '<value>');
  return '[--' + option.name + value + ']';
}

function optionsHelp(command: Command): string[] {
  const lines = ['  Options:'];
  for (const option of optionsOf(command)) lines.push('    ' + optionHelp(option));
  return lines;
}

function examplesHelp(examples: readonly string[]): string[] {
  return ['  Examples:', ...examples.map((example) => '    ' + example)];
}

function optionHelp(option: OptionSpec): string {
  const value = option.kind === 'boolean' ? '' : ' <value>';
  const choices = option.choices ? ' (' + option.choices.join('|') + ')' : '';
  const fallback = option.default !== undefined ? '  [default: ' + option.default + ']' : '';
  return ('--' + option.name + value).padEnd(20) + option.help + choices + fallback;
}
