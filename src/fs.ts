import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

export function managedFile(path: string) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error('Not a regular file; refusing to replace: ' + path);
    return { text: readFileSync(path, 'utf8'), mode: stat.mode & 0o777 };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

export function writeAtomic(path: string, text: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, '.' + basename(path) + '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temp, text, { flag: 'wx', mode });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
