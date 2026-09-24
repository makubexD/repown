// Dispatch for a program built from Command/CommandGroup declarations: resolving
// a command (and, for a group, an action), handling `--help`/`-h`/`help` before a
// command's own `run()` ever sees the arguments, and reporting a usage error
// with an exit code of 2.
//
// Kept apart from src/cli.ts so a second program (the release tool in scripts/)
// gets the same grammar without importing cli.ts, which runs repown.

import { parseArgs, hasHelpFlag } from './args.ts';
import { isGroup, resolveAlias, specFor, type Command, type CommandGroup } from './command.ts';
import { renderHelpFor } from './help.ts';
import { suggest } from './suggest.ts';
import { ok, err, type Result } from '../core/result.ts';
import * as out from './format.ts';

export type Entry = Command | CommandGroup;
export type Loader = () => Promise<Entry>;

export interface Program {
  readonly name: string;
  readonly commands: Readonly<Record<string, Loader>>;
  /** Runs when no command is typed; without one, the top help is printed. */
  readonly defaultCommand?: string;
  readonly topHelp: (entries: ReadonlyMap<string, Entry>) => string[];
  readonly version?: () => string;
}

async function loadAll(program: Program): Promise<Map<string, Entry>> {
  const names = Object.keys(program.commands);
  const entries = await Promise.all(names.map((name) => program.commands[name]!()));
  return new Map(names.map((name, index) => [name, entries[index]!]));
}

function reportUsageError(tag: string, message: string): void {
  const [first, ...rest] = message.split('\n');
  out.fail(tag, first ?? message);
  for (const line of rest) out.detail(line);
}

/** `implicit`: no command was typed, so a usage error is the program's, not the default command's. */
interface Resolved {
  readonly name: string;
  readonly entry: Entry;
  readonly rest: readonly string[];
  readonly implicit: boolean;
}

async function resolveTop(program: Program, argv: readonly string[]): Promise<Result<Resolved>> {
  const first = argv[0];
  const fallback = program.defaultCommand;
  if (fallback !== undefined && (first === undefined || first.startsWith('-'))) {
    return ok({ name: fallback, entry: await program.commands[fallback]!(), rest: argv, implicit: true });
  }
  const loader = first === undefined ? undefined : program.commands[first];
  if (!loader) return err(unknown('command', first ?? '', Object.keys(program.commands)));
  return ok({ name: first!, entry: await loader(), rest: argv.slice(1), implicit: false });
}

/** One correction wherever a name is looked up: `<program> x`, `<program> help x`, a group's action. */
function unknown(kind: 'command' | 'action', name: string, known: readonly string[]): string {
  const hint = suggest(name, known);
  const guess = hint ? ` (did you mean '${hint}'?)` : '';
  return 'Unknown ' + kind + ': ' + name + guess + '\nknown: ' + known.join(', ');
}

function helpPointer(program: Program, path: readonly string[]): string {
  return '\nrun `' + [program.name, 'help', ...path].join(' ') + '` for usage';
}

interface PickedAction {
  readonly command: Command;
  readonly action: string;
  readonly remaining: readonly string[];
  readonly explicit: boolean;
}

function resolveAction(group: CommandGroup, rest: readonly string[]): Result<PickedAction> {
  const first = rest[0];
  if (first === undefined || first.startsWith('-')) {
    return ok({ command: group.actions[group.defaultAction]!, action: group.defaultAction, remaining: rest, explicit: false });
  }
  const canonical = resolveAlias(group, first);
  const command = group.actions[canonical];
  if (!command) return err(unknown('action', first, Object.keys(group.actions)));
  return ok({ command, action: canonical, remaining: rest.slice(1), explicit: true });
}

interface Leaf {
  readonly path: readonly string[];
  readonly command: Command;
  readonly rest: readonly string[];
  readonly tag: string;
}

async function runLeaf(program: Program, leaf: Leaf): Promise<number> {
  const spec = specFor(leaf.command);
  if (hasHelpFlag(leaf.rest, spec.options)) { printHelp(program, leaf.path, leaf.command); return 0; }
  const parsed = parseArgs(leaf.rest, spec);
  if (!parsed.ok) { reportUsageError(leaf.tag, parsed.error + helpPointer(program, leaf.path)); return 2; }
  return leaf.command.run(parsed.value);
}

async function dispatch(program: Program, top: Resolved): Promise<number> {
  const { name, entry, rest } = top;
  if (!isGroup(entry)) return runLeaf(program, { path: [name], command: entry, rest, tag: top.implicit ? program.name : name });

  const picked = resolveAction(entry, rest);
  if (!picked.ok) { reportUsageError(name, picked.error); return 2; }
  const { command, action, remaining, explicit } = picked.value;

  if (!explicit && hasHelpFlag(remaining)) { printHelp(program, [name], entry); return 0; }
  return runLeaf(program, { path: [name, action], command, rest: remaining, tag: name + ' ' + action });
}

function printHelp(program: Program, path: readonly string[], entry: Entry): void {
  for (const line of renderHelpFor(path, entry, program.name)) out.line(line);
}

async function runHelp(program: Program, path: readonly string[]): Promise<number> {
  if (path.length === 0) {
    for (const line of program.topHelp(await loadAll(program))) out.line(line);
    return 0;
  }
  const loader = program.commands[path[0]!];
  if (!loader) { reportUsageError('help', unknown('command', path[0]!, Object.keys(program.commands))); return 2; }

  const top = await loader();
  if (!isGroup(top) || path.length === 1) { printHelp(program, [path[0]!], top); return 0; }

  const canonical = resolveAlias(top, path[1]!);
  const command = top.actions[canonical];
  if (!command) { reportUsageError('help', unknown('action', path[1]!, Object.keys(top.actions))); return 2; }
  printHelp(program, [path[0]!, canonical], command);
  return 0;
}

export async function runProgram(program: Program, argv: readonly string[]): Promise<number> {
  const version = program.version;
  if (version && (argv[0] === '--version' || argv[0] === '-v')) { out.line(program.name + ' ' + version()); return 0; }
  if (argv[0] === '--help' || argv[0] === '-h') return runHelp(program, []);
  if (argv[0] === 'help') return runHelp(program, argv.slice(1));
  if (argv.length === 0 && program.defaultCommand === undefined) return runHelp(program, []);

  const top = await resolveTop(program, argv);
  if (!top.ok) { reportUsageError(program.name, top.error); return 2; }
  return dispatch(program, top.value);
}

/** The whole life of the process: run, set the exit code, and report a crash as a failure. */
export function start(program: Program): void {
  out.ignoreBrokenPipe();
  runProgram(program, process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      out.fail(program.name, error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
