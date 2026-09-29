// The command table. cli.ts starts the program; the start screen's Show help
// loads this same table. Importing this file does not run repown.

import type { Loader } from './ui/dispatch.ts';

export const COMMANDS: Readonly<Record<string, Loader>> = {
  status: async () => (await import('./commands/status.ts')).default,
  use: async () => (await import('./commands/use.ts')).default,
  off: async () => (await import('./commands/off.ts')).default,
  doctor: async () => (await import('./commands/doctor.ts')).default,
  fix: async () => (await import('./commands/fix.ts')).default,
  reauthor: async () => (await import('./commands/reauthor.ts')).default,
  guard: async () => (await import('./commands/guard.ts')).default,
  accounts: async () => (await import('./commands/accounts.ts')).default,
  scan: async () => (await import('./commands/scan.ts')).default,
  setup: async () => (await import('./commands/setup.ts')).default,
};
