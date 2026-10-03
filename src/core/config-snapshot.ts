// Config reads answered from one `git config [--scope] --list -z` per scope, read on first
// use, for code that only reads (ADR-029). A read builds the exact output git's own
// `--get`, `--get-all` or `--type=bool --get` would print, so Git's parsing of that output
// is unchanged. Every other git call passes through; a config write refuses.

import { Git, type ConfigScope } from './git.ts';
import { succeeded, type ExecResult } from './exec.ts';

interface ConfigRead {
  readonly scope: ConfigScope | undefined;
  readonly key: string;
  readonly all: boolean;
  readonly bool: boolean;
}

const SCOPE_FLAGS = new Map<string, ConfigScope>([['--local', 'local'], ['--global', 'global'], ['--system', 'system']]);

export class ConfigSnapshot extends Git {
  private readonly lists = new Map<string, Promise<ExecResult>>();

  protected override exec(args: readonly string[], input?: string): Promise<ExecResult> {
    const read = configRead(args);
    if (read) return this.answer(read);
    if (args[0] === 'config' && !args.some((arg) => PASSED_THROUGH.has(arg))) {
      return Promise.reject(new Error('a config snapshot only reads: git ' + args.join(' ')));
    }
    return this.spawnGit(args, input);
  }

  private async answer(read: ConfigRead): Promise<ExecResult> {
    const listed = await this.listOf(read.scope);
    if (!succeeded(listed)) return listed;
    const values = valuesOf(listed.stdout, canonicalKey(read.key));
    if (values.length === 0) return answered(1, '');
    if (read.all) return answered(0, values.map((value) => (value ?? '') + '\n').join(''));
    const last = values[values.length - 1]!;
    if (!read.bool) return answered(0, (last ?? '') + '\n');
    const parsed = gitBool(last);
    return parsed === null ? answered(128, '') : answered(0, parsed + '\n');
  }

  private listOf(scope: ConfigScope | undefined): Promise<ExecResult> {
    const name = scope ?? 'effective';
    if (!this.lists.has(name)) this.lists.set(name, this.spawnGit(scope ? ['config', '--' + scope, '--list', '-z'] : ['config', '--list', '-z']));
    return this.lists.get(name)!;
  }
}

/** A snapshot of `git`'s config, or `git` itself when it already is one. */
export function snapshotOf(git: Git): ConfigSnapshot {
  return git instanceof ConfigSnapshot ? git : new ConfigSnapshot(git.cwd);
}

/** Config queries a snapshot doesn't answer itself; they still go to git. */
const PASSED_THROUGH = new Set(['--get-urlmatch', '--get-regexp', '--list', '--show-origin']);

/** `config [--scope] [--type=bool] --get|--get-all <key>`, exactly the shapes Git's getters send. */
function configRead(args: readonly string[]): ConfigRead | null {
  if (args[0] !== 'config') return null;
  const rest = args.slice(1);
  const scope = SCOPE_FLAGS.get(rest[0] ?? '');
  if (scope) rest.shift();
  const bool = rest[0] === '--type=bool';
  if (bool) rest.shift();
  if (rest.length !== 2 || (rest[0] !== '--get' && rest[0] !== '--get-all')) return null;
  return { scope, key: rest[1]!, all: rest[0] === '--get-all', bool };
}

/** Section and variable name are case-insensitive, a subsection is not: `--list` prints them so. */
function canonicalKey(key: string): string {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first <= 0 || last === key.length - 1) return '\0';
  const section = key.slice(0, first).toLowerCase();
  const name = key.slice(last + 1).toLowerCase();
  return first === last ? section + '.' + name : section + '.' + key.slice(first + 1, last) + '.' + name;
}

/** Every value of `key`, in git's order; null for a key written with no `=` (git's implicit true). */
function valuesOf(listed: string, key: string): (string | null)[] {
  const values: (string | null)[] = [];
  for (const entry of listed.split('\0')) {
    const newline = entry.indexOf('\n');
    const name = newline < 0 ? entry : entry.slice(0, newline);
    if (entry !== '' && name === key) values.push(newline < 0 ? null : entry.slice(newline + 1));
  }
  return values;
}

/** git's own boolean reading: true/yes/on, false/no/off/empty, or an integer (k, m, g allowed). */
function gitBool(value: string | null): 'true' | 'false' | null {
  if (value === null) return 'true';
  const text = value.toLowerCase();
  if (['true', 'yes', 'on'].includes(text)) return 'true';
  if (['false', 'no', 'off', ''].includes(text)) return 'false';
  const integer = /^([-+]?\d+)[kmg]?$/.exec(text);
  return integer ? (Number(integer[1]) !== 0 ? 'true' : 'false') : null;
}

function answered(code: number, stdout: string): ExecResult {
  return { code, stdout, stderr: '' };
}
