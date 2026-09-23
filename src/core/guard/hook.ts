// The pre-push hook: writing it, recognising it, removing it.
//
// WHY THE HOOK CALLS AN INSTALLED CLI RATHER THAN A COPY OF ITSELF. A copy of
// the checker inside .git/ adds two states -- `stale` (a copy is missing, so the
// check cannot load) and `drifted` (the copy is older than the tool). Calling the
// installed entry point removes both: there is only ever one implementation, and
// it is current by construction (DECISIONS §3).
//
// The absolute path is baked in at install time AND a PATH lookup is kept as a
// fallback, so neither a PATH change nor a reinstall elsewhere can quietly
// disable the guard. If both fail it REFUSES. A hook that cannot run its check is
// not a check, and exiting 0 there is how the previous design let five of six
// branches push unguarded.
//
// Written LF-only, always: `sh` rejects a CRLF script with "bad interpreter", and
// on Windows the line endings of anything templated here depend on how the file
// was checked out.

import { readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Git } from '../git.ts';
import { ok, err, type Result } from '../result.ts';

export const MARKER = 'repown-identity-guard';

export type GuardState = 'off' | 'foreign' | 'on';

/**
 * A marker counts only where this tool writes it: line 2 (right after the shebang)
 * starts with `# <marker>:`. A hook that merely MENTIONS it, or that has this
 * tool's body pasted below lines of its own, is someone else's -- and a hook classified
 * as ours gets overwritten by `guard on` and deleted by `guard off`.
 */
function classify(body: string): GuardState {
  const header = body.split('\n')[1] ?? '';
  return header.startsWith('# ' + MARKER + ':') ? 'on' : 'foreign';
}

/** This CLI's own entry point, as the hook will invoke it. */
export function entryPoint(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), '..', '..', 'cli' + here.slice(here.lastIndexOf('.')));
}

/** The pre-push hook git will actually RUN -- through core.hooksPath if that is set. */
export async function hookPath(git: Git): Promise<string | null> {
  const hooks = await git.hooksDir();
  return hooks ? join(resolve(hooks), 'pre-push') : null;
}

/**
 * core.hooksPath pointing anywhere but this clone's own hooks directory: a
 * directory another tool manages, or one shared by every repository on the
 * machine. repown never writes there -- a hook in a shared directory would run,
 * and refuse, in clones that were never pinned.
 */
async function redirectedHooks(git: Git): Promise<string | null> {
  const [common, hooks] = await Promise.all([git.commonDir(), git.hooksDir()]);
  if (!common || !hooks) return null;
  return samePath(join(common, 'hooks'), hooks) ? null : resolve(hooks);
}

function samePath(a: string, b: string): boolean {
  const norm = (path: string): string => resolve(path).toLowerCase();
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm(a) === norm(b)
    : resolve(a) === resolve(b);
}

export async function guardState(git: Git): Promise<GuardState> {
  const path = await hookPath(git);
  if (!path || !existsSync(path)) return 'off';
  return classify(await readFile(path, 'utf8').catch(() => ''));
}

/**
 * The PATH fallback trusts a `repown` only if it SAYS it is repown. Without this, any
 * program of that name that exits 0 passes every push unchecked.
 */
const PATH_FALLBACK_CHECK = [
  'repown_on_path() {',
  '    command -v repown >/dev/null 2>&1 || return 1',
  '    case "$(repown --version 2>/dev/null)" in "repown "*) return 0 ;; *) return 1 ;; esac',
  '}',
  '',
];

export function hookBody(entry: string, nodePath: string): string {
  const q = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
  return [
    '#!/bin/sh',
    '# ' + MARKER + ': installed by `repown guard on`, removed by `repown guard off`.',
    '# Bypass one push (recorded in the reflog either way): git push --no-verify',
    '#',
    '# stdin -- the <local ref> <local sha> <remote ref> <remote sha> lines -- is',
    '# inherited by the child, and is what says WHICH COMMITS are about to be',
    '# published. That is the thing being checked, not the config as it stands now.',
    '',
    'repown_entry=' + q(entry),
    'repown_node=' + q(nodePath),
    '',
    ...PATH_FALLBACK_CHECK,
    'if [ -f "$repown_entry" ] && [ -x "$repown_node" ]; then',
    '    "$repown_node" "$repown_entry" guard check --remote "$1" --url "$2"',
    'elif repown_on_path; then',
    '    repown guard check --remote "$1" --url "$2"',
    'else',
    '    echo "" >&2',
    '    echo "repown: the identity guard is installed but repown cannot be found," >&2',
    '    echo "so this push CANNOT be checked. Refusing rather than passing silently." >&2',
    '    echo "  expected: $repown_entry" >&2',
    '    echo "  fix:      reinstall repown, then run: repown guard on" >&2',
    '    exit 1',
    'fi',
    '',
    'status=$?',
    'if [ $status -ne 0 ]; then',
    '    echo "" >&2',
    '    echo "Push stopped by the repown identity guard (above)." >&2',
    '    echo "Override this one push with: git push --no-verify" >&2',
    'fi',
    'exit $status',
    '',
  ].join('\n');
}

export interface InstallOutcome {
  readonly path: string;
}

export async function installGuard(git: Git): Promise<Result<InstallOutcome>> {
  const path = await hookPath(git);
  if (!path) return err('could not locate the git directory for this repository');
  const refusal = await whyNotInstall(git, path);
  if (refusal) return err(refusal);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, hookBody(entryPoint(), process.execPath), 'utf8');
  await chmod(path, 0o755).catch(() => { /* Windows filesystems carry no mode */ });
  return ok({ path });
}

async function whyNotInstall(git: Git, path: string): Promise<string | null> {
  const redirected = await redirectedHooks(git);
  if (redirected) {
    return 'core.hooksPath makes git run hooks from ' + redirected + ', a directory repown ' +
           'does not own -- leaving it alone. Unset core.hooksPath, or have that tool\'s ' +
           'pre-push hook run: repown guard check --remote "$1" --url "$2"';
  }
  if (await guardState(git) === 'foreign') {
    return 'a pre-push hook this tool did not write already exists at ' + path + ' -- leaving it alone';
  }
  return null;
}

export async function uninstallGuard(git: Git): Promise<Result<boolean>> {
  const path = await hookPath(git);
  if (!path) return err('could not locate the git directory for this repository');
  const state = await guardState(git);

  if (state === 'off') return ok(false);
  if (state === 'foreign') {
    return err('the pre-push hook at ' + path + ' was not written by this tool -- leaving it alone');
  }
  await rm(path, { force: true });
  return ok(true);
}
