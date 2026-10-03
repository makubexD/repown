// Config reads answered from one `git config [--scope] --list -z` per scope, read on first
// use, for code that only reads (ADR-029). A plain `--get` or `--get-all` is answered with
// the output git itself would print for it, so Git's parsing of that output is unchanged.
// Other config queries (`--type=bool`, `--get-urlmatch`, `--show-origin --get-regexp`) and
// every non-config call go to git. A config write refuses.

import { Git, type ConfigScope } from './git.ts';
import { succeeded, type ExecResult } from './exec.ts';

interface ConfigRead {
  readonly scope: ConfigScope | undefined;
  readonly key: string;
  readonly all: boolean;
}

const SCOPE_FLAGS = new Map<string, ConfigScope>([['--local', 'local'], ['--global', 'global'], ['--system', 'system']]);

/** The first argument after `config` and its scope: the query git is asked, never a value. */
const PASSED_THROUGH = new Set(['--type=bool', '--get-urlmatch', '--show-origin', '--get-regexp', '--list']);

export class ConfigSnapshot extends Git {
  private readonly lists = new Map<string, Promise<ExecResult>>();

  protected override exec(args: readonly string[], input?: string): Promise<ExecResult> {
    if (args[0] !== 'config') return this.spawnGit(args, input);
    const read = configRead(args);
    if (read) return this.answer(read);
    if (PASSED_THROUGH.has(actionOf(args) ?? '')) return this.spawnGit(args, input);
    return Promise.reject(new Error('a config snapshot only reads: git ' + args.join(' ')));
  }

  private async answer(read: ConfigRead): Promise<ExecResult> {
    const listed = await this.listOf(read.scope);
    if (!succeeded(listed)) return listed;
    const values = valuesOf(listed.stdout, canonicalKey(read.key));
    if (values.length === 0) return answered(1, '');
    if (read.all) return answered(0, values.map((value) => (value ?? '') + '\n').join(''));
    return answered(0, (values[values.length - 1] ?? '') + '\n');
  }

  /**
   * One list per scope, shared by every read of this snapshot (a failure too). A scope with
   * no file at all is empty: `--list` fails there where `--get` says "not set".
   */
  private listOf(scope: ConfigScope | undefined): Promise<ExecResult> {
    const name = scope ?? 'effective';
    if (!this.lists.has(name)) this.lists.set(name, this.spawnGit(listArgs(scope)).then(missingFileIsEmpty));
    return this.lists.get(name)!;
  }
}

/**
 * A snapshot of a plain `git`, or `git` itself when it already is one. A subclass is refused:
 * the snapshot keeps only the cwd, so whatever the subclass overrides would be dropped.
 */
export function snapshotOf(git: Git): ConfigSnapshot {
  if (git instanceof ConfigSnapshot) return git;
  if (Object.getPrototypeOf(git) !== Git.prototype) throw new Error('snapshotOf takes a plain Git, not ' + git.constructor.name);
  return new ConfigSnapshot(git.cwd);
}

function listArgs(scope: ConfigScope | undefined): string[] {
  return scope ? ['config', '--' + scope, '--list', '-z'] : ['config', '--list', '-z'];
}

function missingFileIsEmpty(listed: ExecResult): ExecResult {
  return !succeeded(listed) && /unable to read config file/.test(listed.stderr) ? answered(0, '') : listed;
}

/** The query after `config` and an optional scope flag. */
function actionOf(args: readonly string[]): string | undefined {
  return SCOPE_FLAGS.has(args[1] ?? '') ? args[2] : args[1];
}

/** `config [--scope] --get|--get-all <key>`, exactly the shapes Git's plain getters send. */
function configRead(args: readonly string[]): ConfigRead | null {
  const scoped = SCOPE_FLAGS.get(args[1] ?? '');
  const rest = args.slice(scoped ? 2 : 1);
  if (rest.length !== 2 || (rest[0] !== '--get' && rest[0] !== '--get-all')) return null;
  return { scope: scoped, key: rest[1]!, all: rest[0] === '--get-all' };
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

function answered(code: number, stdout: string): ExecResult {
  return { code, stdout, stderr: '' };
}
