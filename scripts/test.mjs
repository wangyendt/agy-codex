import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const files = readdirSync(new URL('../test/', import.meta.url))
  .filter((file) => file.endsWith('.test.ts'))
  .sort()
  .map((file) => fileURLToPath(new URL('../test/' + file, import.meta.url)));
if (!files.length) throw new Error('No test files were found');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
