// The shape every command and command-group declares itself in.
//
// Declaring options and positionals here -- rather than each command reading
// flags ad hoc -- is what lets one parser (ui/args.ts) validate every command
// the same way, and one renderer (ui/help.ts) generate help for all of them
// from the same declarations, so help can never drift from what the parser
// actually accepts.

import type { Args, OptionSpec, PositionalSpec, Spec } from './args.ts';
import { NO_POSITIONALS } from './args.ts';

export interface Command {
  readonly summary: string;
  readonly options?: readonly OptionSpec[];
  readonly positionals?: PositionalSpec;
  readonly examples?: readonly string[];
  run(args: Args): Promise<number>;
}

export interface CommandGroup {
  readonly summary: string;
  readonly defaultAction: string;
  readonly actions: Readonly<Record<string, Command>>;
  /** Hidden alias action name -> canonical action name. Works exactly like the target; never advertised in help. */
  readonly aliases?: Readonly<Record<string, string>>;
}

export function isGroup(entry: Command | CommandGroup): entry is CommandGroup {
  return 'actions' in entry;
}

export function optionsOf(command: Command): readonly OptionSpec[] {
  return command.options ?? [];
}

export function positionalsOf(command: Command): PositionalSpec {
  return command.positionals ?? NO_POSITIONALS;
}

/** The parser input for one command: its own declared options and positionals. */
export function specFor(command: Command): Spec {
  return { options: optionsOf(command), positionals: positionalsOf(command) };
}

/** Resolves a hidden alias to its canonical action name; passes any other name through unchanged. */
export function resolveAlias(group: CommandGroup, action: string): string {
  return group.aliases?.[action] ?? action;
}
