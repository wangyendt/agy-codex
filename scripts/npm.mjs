import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

export const root = fileURLToPath(new URL('..', import.meta.url));

export function npm(args, options = {}) {
  const shipped = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const entry = process.env.npm_execpath || (process.platform === 'win32' && existsSync(shipped) ? shipped : undefined);
  return entry
    ? execFileSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', ...options })
    : execFileSync('npm', args, { cwd: root, encoding: 'utf8', ...options });
}
