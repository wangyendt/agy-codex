import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { npm, root } from './npm.mjs';

const [report] = JSON.parse(npm(['pack', '--dry-run', '--json']));
const files = report.files.map((entry) => entry.path);
for (const path of ['package.json', 'dist/cli.js', 'dist/rules.js', 'dist/run.js', 'README.md', 'README_EN.md', 'LICENSE']) {
  if (!files.includes(path)) throw new Error('npm package is missing ' + path);
}
if (files.some((path) => !path.startsWith('dist/') && !['package.json', 'README.md', 'README_EN.md', 'LICENSE'].includes(path))) {
  throw new Error('npm package contains unapproved files');
}
const cli = readFileSync(join(root, 'dist', 'cli.js'), 'utf8');
if (!cli.startsWith('#!/usr/bin/env node\n')) throw new Error('CLI is missing the Node shebang');
process.stdout.write(JSON.stringify({ ok: true, files: files.length, bytes: report.size }) + '\n');
