import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

export function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-codex test ')));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

export function put(path: string, text: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
  return path;
}
