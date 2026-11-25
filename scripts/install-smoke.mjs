import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { npm } from './npm.mjs';

const temp = mkdtempSync(join(tmpdir(), 'agy-codex-install-'));
try {
  const [{ filename }] = JSON.parse(npm(['pack', '--json', '--pack-destination', temp]));
  writeFileSync(join(temp, 'package.json'), '{"private":true}');
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', join(temp, filename)], {
    cwd: temp, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const installed = join(temp, 'node_modules', 'agy-codex');
  const run = (...args) => execFileSync(process.execPath, [join(installed, 'dist', 'cli.js'), ...args], { cwd: temp, encoding: 'utf8' });
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  if (run('--version').trim() !== manifest.version) throw new Error('CLI version does not match installed package.json');
  const bin = join(temp, 'node_modules', '.bin', 'agy-codex');
  if (process.platform === 'win32') {
    readFileSync(bin + '.cmd', 'utf8');
    // Verify npm's generated shim too; the command consists exclusively of fixed tokens.
    const machine = process.env.ComSpec ?? 'cmd.exe';
    const throughShim = execFileSync(machine, ['/d', '/s', '/c', 'node_modules\\.bin\\agy-codex.cmd --version'], {
      cwd: temp, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    if (throughShim.trim() !== manifest.version) throw new Error('Invalid Windows CLI shim');
  } else if (execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim() !== manifest.version) {
    throw new Error('Invalid CLI executable');
  }
  for (const name of ['setup', 'doctor', 'upgrade', 'run', 'uninstall']) {
    if (!run(name, '--help').includes('agy-codex ' + name)) throw new Error('Missing help for ' + name);
  }
  const home = join(temp, 'gemini');
  const setup = JSON.parse(run('setup', '--gemini-home', home, '--no-install-deps', '--no-sync-skill', '--json'));
  if (!setup.ok || setup.files.length !== 2) throw new Error('Installed CLI did not write both expected rules');
  const report = JSON.parse(run('doctor', '--gemini-home', home, '--codex-home', temp, '--offline', '--json'));
  if (!report.ok || report.rules.agents.status !== 'managed') throw new Error('Installed CLI cannot inspect managed rules');
  process.stdout.write(JSON.stringify({ ok: true }) + '\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
