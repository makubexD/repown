// Argument parsing: turning argv into structured, validated Args.
//
// Kept out of cli.ts so a command can import it without dragging in
// the dispatcher -- importing cli.ts used to run `main()` -- and so the parser
// itself is unit-testable.
//
// A command declares its OWN options and how many positionals it takes; this
// module never guesses. A boolean option never consumes the next token (an
// earlier bug: `repown use --gh octocat` read "octocat" as --gh's value and left
// no account), an unknown option is refused rather than silently dropped, and
// so is an extra positional.

import { Git } from '../core/git.ts';
import { ok, err, type Result } from '../core/result.ts';
import { suggest } from './suggest.ts';

export interface Args {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
}

export interface OptionSpec {
  readonly name: string;
  readonly kind: 'boolean' | 'string';
  readonly default?: string | boolean;
  readonly choices?: readonly string[];
  readonly help: string;
}

export interface PositionalSpec {
  readonly min: number;
  readonly max: number;
  /** Shown in usage, e.g. "<account>" or "<dir>...". */
  readonly label?: string;
  /** A bare `-` is a positional (read stdin) only when this is set; elsewhere it is an unknown option. */
  readonly stdin?: boolean;
}

export interface Spec {
  readonly options: readonly OptionSpec[];
  readonly positionals: PositionalSpec;
}

export const NO_POSITIONALS: PositionalSpec = { min: 0, max: 0 };

/** For commands whose payload a script may read. Only `json` is a stable contract (ADR-014). */
export const FORMAT_OPTION: OptionSpec = {
  name: 'format', kind: 'string', default: 'text', choices: ['text', 'json'],
  help: 'text for people, json for scripts',
};

export function wantsJson(args: Args): boolean {
  return flagString(args, 'format') === 'json';
}

/** Accepted on every command, in addition to whatever it declares itself. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: 'cwd', kind: 'string', help: 'run as if started in this directory' },
];

/**
 * `--name value`, `--name=value` and `--flag` are all accepted; everything else
 * is positional. A token that is exactly `--` ends option parsing, so a branch
 * or path beginning with a dash can still be passed. Before it, a `-x` is an
 * unknown option, never a value: `repown use -x` pinned an account named "-x".
 */
export function parseArgs(tokens: readonly string[], spec: Spec): Result<Args> {
  const options = [...GLOBAL_OPTIONS, ...spec.options];
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let optionsEnded = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const stdinDash = token === '-' && spec.positionals.stdin === true;
    if (optionsEnded || stdinDash || !token.startsWith('-')) { positional.push(token); continue; }
    if (token === '--') { optionsEnded = true; continue; }
    if (!token.startsWith('--')) return err(`unknown option ${token}`);

    const consumed = readOption(token, tokens[index + 1], options, flags);
    if (!consumed.ok) return err(consumed.error);
    if (consumed.value) index += 1;
  }

  const range = checkPositionalCount(positional, spec.positionals);
  if (!range.ok) return err(range.error);
  applyDefaults(options, flags);
  return ok({ positional, flags });
}

function applyDefaults(options: readonly OptionSpec[], flags: Map<string, string | boolean>): void {
  for (const option of options) {
    if (option.default !== undefined && !flags.has(option.name)) flags.set(option.name, option.default);
  }
}

/** Parses one `--name`/`--name=value` token. Returns whether it also consumed `next`. */
function readOption(
  token: string,
  next: string | undefined,
  options: readonly OptionSpec[],
  flags: Map<string, string | boolean>,
): Result<boolean> {
  const [name, inline] = splitFlag(token);
  const option = options.find((candidate) => candidate.name === name);
  if (!option) return err(unknownOptionMessage(name, options));

  if (option.kind === 'boolean') {
    if (inline !== null) return err(`--${name} does not take a value`);
    flags.set(name, true);
    return ok(false);
  }

  const value = inline ?? next;
  if (value === undefined || value.startsWith('--')) return err(`--${name} needs a value`);
  if (option.choices && !option.choices.includes(value)) {
    return err(`--${name} must be one of: ${option.choices.join(', ')} (got '${value}')`);
  }
  flags.set(name, value);
  return ok(inline === null);
}

function checkPositionalCount(positional: readonly string[], spec: PositionalSpec): Result<void> {
  if (positional.length < spec.min) {
    return err(`expects ${describeCount(spec)}${spec.label ? ' ' + spec.label : ''}`);
  }
  if (positional.length > spec.max) {
    const extra = positional.slice(spec.max).map((value) => `'${value}'`).join(', ');
    return err(`unexpected argument${positional.length - spec.max > 1 ? 's' : ''}: ${extra}`);
  }
  return ok(undefined);
}

function describeCount(spec: PositionalSpec): string {
  if (spec.min === spec.max) return `exactly ${spec.min} argument${spec.min === 1 ? '' : 's'}`;
  return `at least ${spec.min} argument${spec.min === 1 ? '' : 's'}`;
}

function unknownOptionMessage(name: string, options: readonly OptionSpec[]): string {
  const hint = suggest(name, options.map((option) => option.name));
  return hint ? `unknown option --${name} (did you mean --${hint}?)` : `unknown option --${name}`;
}

function splitFlag(token: string): [string, string | null] {
  const body = token.slice(2);
  const equals = body.indexOf('=');
  return equals === -1 ? [body, null] : [body.slice(0, equals), body.slice(equals + 1)];
}

/**
 * True when `--help`/`-h` appears before any `--` end-of-options marker -- and
 * is not the VALUE of a string option. Every installed hook calls
 * `guard check --remote "$1" --url "$2"`, and a remote may be named `-h`: read as
 * help, the check printed usage and exited 0, and git pushed.
 */
export function hasHelpFlag(tokens: readonly string[], options: readonly OptionSpec[] = []): boolean {
  const takesValue = (token: string): boolean => {
    const [name, inline] = splitFlag(token);
    return inline === null && [...GLOBAL_OPTIONS, ...options].some((o) => o.name === name && o.kind === 'string');
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === '--') return false;
    if (token === '--help' || token === '-h') return true;
    if (token.startsWith('--') && takesValue(token)) index += 1;
  }
  return false;
}

export function flagString(args: Args, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : null;
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags.get(name) === true;
}

export function gitFor(args: Args): Git {
  return new Git(flagString(args, 'cwd') ?? process.cwd());
}
