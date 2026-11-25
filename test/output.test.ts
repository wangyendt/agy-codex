import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { colorEnabled, formatDoctor } from '../src/output.js';

test('color defaults to TTY only and honors explicit environment overrides', () => {
  assert.equal(colorEnabled(true, {}), true);
  assert.equal(colorEnabled(false, {}), false);
  assert.equal(colorEnabled(false, { FORCE_COLOR: '1' }), true);
  assert.equal(colorEnabled(true, { FORCE_COLOR: '0' }), false);
  assert.equal(colorEnabled(true, { NO_COLOR: '1', FORCE_COLOR: '1' }), false);
});

test('doctor styling preserves column alignment and distinguishes statuses, paths, labels and notes', () => {
  const report: Parameters<typeof formatDoctor>[0] = {
    ok: true,
    offline: false,
    platform: 'linux',
    components: {
      'agy-codex': { version: '0.1.0', latest: '0.1.0', status: 'current', registry: 'ok', path: '/bin/agy-codex' },
      codex: { version: '0.172.0', latest: '0.172.0', status: 'current', registry: 'ok', path: '/bin/codex' },
      desktop: { version: '0.99.0', latest: '0.172.0', status: 'outdated', registry: 'ok', path: '/desktop/codex' },
      'codex-task': { version: null, latest: null, status: 'unreadable', registry: 'offline', path: '/bin/codex-task' },
      sdk: { version: null, latest: null, status: 'missing', registry: 'unpublished', path: null },
    },
    selectedCodex: { path: '/bin/codex', version: '0.172.0' },
    auth: { status: 'valid', present: true, path: '/home/auth.json', expiresAt: '2099-01-01T00:00:00.000Z' },
    rules: {
      agents: { path: '/home/AGENTS.md', status: 'unmanaged' },
      protocol: { path: '/home/handoff.md', status: 'managed' },
    },
    proxy: { http: 'none', https: 'env', noProxy: 'none' },
    notes: ['Update the Desktop app separately.'],
  };
  const colored = formatDoctor(report, true);
  const plain = formatDoctor(report, false);
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.ok(!plain.includes('\x1b'));
  const offsets = plain.split('\n').slice(0, 6).map((row) => [...row.matchAll(/ {2,}/g)]
    .map((gap) => gap.index + gap[0].length));
  assert.equal(offsets[0]?.length, 4);
  for (const row of offsets) assert.deepEqual(row, offsets[0]);

  for (const [code, words] of [
    ['1', ['Component', 'Local', 'Latest', 'Status', 'Path']],
    ['1;32', ['current', 'valid', 'managed']],
    ['1;33', ['outdated', 'unmanaged']],
    ['1;31', ['unreadable', 'missing']],
    ['2;36', ['offline', 'unpublished']],
    ['2', ['/bin/codex', '/home/auth.json', '/home/AGENTS.md']],
    ['1;36', ['Selected Codex:', 'Auth:', 'Rule:', 'Proxy:']],
    ['33', report.notes],
  ] as const) {
    for (const word of words) assert.ok(colored.includes(`\x1b[${code}m${word}\x1b[0m`), `Expected style for ${word}`);
  }
  const broken = formatDoctor({ ...report, auth: { ...report.auth, status: 'expired' }, rules: {
    ...report.rules, agents: { ...report.rules.agents, status: 'invalid' },
  } }, true);
  assert.ok(broken.includes('\x1b[1;31mexpired\x1b[0m'));
  assert.ok(broken.includes('\x1b[1;31minvalid\x1b[0m'));
});
