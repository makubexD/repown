// The pre-push hook: writing it, recognising it, removing it.
//
// WHY THE HOOK CALLS AN INSTALLED CLI RATHER THAN A COPY OF ITSELF. The
// PowerShell implementation copied five modules into .git/fork-guard/ at install
// time, which bought branch-independence at the cost of two extra states --
// `stale` (a copy is missing, so the check cannot load) and `drifted` (the copies
// are older than the tool). Calling the installed entry point removes both: there
// is only ever one implementation, and it is current by construction.
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
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Git } from '../git.ts';
import { ok, err, type Result } from '../result.ts';

export const MARKER = 'repown-identity-guard';
/** This tool before it was renamed from gid. Recognised so `guard on` can replace it. */
const GID_MARKER = 'gid-identity-guard';
/** The PowerShell tooling this replaced. Recognised so `guard on` can upgrade it. */
const POWERSHELL_MARKER = 'fork-identity-guard';

export type GuardState = 'off' | 'foreign' | 'legacy' | 'on';

/**
 * A marker counts only as the header comment this tool writes -- `# <marker>:` -- so a
 * hook that merely MENTIONS one (a chained hook's comment, say) stays foreign and is
 * never overwritten or deleted. The PowerShell format predates that header.
 */
function hasHeader(body: string, marker: string): boolean {
  return body.split('\n').some((line) => line.startsWith('# ' + marker + ':'));
}

function classify(body: string): GuardState {
  if (hasHeader(body, MARKER)) return 'on';
  if (hasHeader(body, GID_MARKER) || body.includes(POWERSHELL_MARKER)) return 'legacy';
  return 'foreign';
}

/** This CLI's own entry point, as the hook will invoke it. */
export function entryPoint(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), '..', '..', 'cli' + here.slice(here.lastIndexOf('.')));
}

function absoluteCommonDir(common: string, cwd: string): string {
  return isAbsolute(common) ? common : join(cwd, common);
}

export async function hookPath(git: Git): Promise<string | null> {
  const common = await git.commonDir();
  if (!common) return null;
  return join(absoluteCommonDir(common, git.cwd), 'hooks', 'pre-push');
}

export async function guardState(git: Git): Promise<GuardState> {
  const path = await hookPath(git);
  if (!path || !existsSync(path)) return 'off';
  return classify(await readFile(path, 'utf8').catch(() => ''));
}

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
    'if [ -f "$repown_entry" ] && [ -x "$repown_node" ]; then',
    '    "$repown_node" "$repown_entry" guard check --remote "$1" --url "$2"',
    'elif command -v repown >/dev/null 2>&1; then',
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
  /** What was there before -- `legacy` means a PowerShell-era hook was upgraded. */
  readonly replaced: GuardState;
}

export async function installGuard(git: Git): Promise<Result<InstallOutcome>> {
  const path = await hookPath(git);
  if (!path) return err('could not locate the git directory for this repository');

  const existing = await guardState(git);
  if (existing === 'foreign') {
    return err('a pre-push hook this tool did not write already exists at ' + path +
               ' -- leaving it alone');
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, hookBody(entryPoint(), process.execPath), 'utf8');
  await chmod(path, 0o755).catch(() => { /* Windows filesystems carry no mode */ });
  await removeLegacyPayload(git);
  return ok({ path, replaced: existing });
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
  await removeLegacyPayload(git);
  return ok(true);
}

/** The PowerShell guard's module copies. Left behind, they look like live configuration. */
async function removeLegacyPayload(git: Git): Promise<void> {
  const common = await git.commonDir();
  if (!common) return;
  const directory = join(absoluteCommonDir(common, git.cwd), 'fork-guard');
  await rm(directory, { recursive: true, force: true }).catch(() => { /* best effort */ });
}
