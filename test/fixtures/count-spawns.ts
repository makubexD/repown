// Loaded with `node --import` into a repown run: appends one line per git spawn to
// $REPOWN_SPAWN_LOG, so test/spawn-budget.test.ts can count what one command starts.
// exec.ts imports child_process by name, so the replaced functions are synced into ESM.

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

type Spawner = (file: string, args?: readonly string[], ...rest: unknown[]) => unknown;

const log = process.env['REPOWN_SPAWN_LOG'];
const childProcess = createRequire(import.meta.url)('node:child_process') as Record<string, Spawner>;

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const real = childProcess[name]!;
  childProcess[name] = function counted(this: unknown, file, args, ...rest) {
    if (log && basename(String(file)).replace(/\.exe$/i, '') === 'git') {
      appendFileSync(log, JSON.stringify(args ?? []) + '\n');
    }
    return real.call(this, file, args, ...rest);
  };
}
syncBuiltinESMExports();
