import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, block, end, legacySpan, paths, planSetup, planUninstall, rulesStatus, start } from '../src/rules.js';
import { fixture, put } from './fixture.js';

const read = (file: string) => readFileSync(file, 'utf8');

test('managed blocks update idempotently and uninstall preserves surrounding CRLF text', (t) => {
  const geminiHome = fixture(t);
  const { agents, protocol, gemini } = paths(geminiHome);
  const before = 'Public note\r\n\r\n';
  const after = '\r\nA separate custom section.\r\n';
  put(agents, before + start + '\r\nstale routing\r\n' + end + '\r\n' + after);
  put(gemini, 'Gemini CLI only\r\n');
  const options = { geminiHome, syncGeminiCli: true };
  assert.equal(apply(planSetup(options), false).files.length, 3);
  assert.equal(apply(planSetup(options), false).files.length, 0);
  assert.ok(read(agents).startsWith(before + start + '\r\n'));
  assert.ok(read(agents).endsWith(end + '\r\n' + after));
  assert.ok(!read(agents).includes('stale routing'));
  assert.match(read(protocol), /^---\ntrigger: model_decision\n/);
  assert.equal(rulesStatus(geminiHome).agents.status, 'managed');
  assert.equal(rulesStatus(geminiHome).protocol.status, 'managed');
  assert.equal(apply(planUninstall(options), false).files.length, 3);
  assert.equal(read(agents), before + after);
  assert.equal(read(gemini), 'Gemini CLI only\r\n');
  assert.equal(existsSync(protocol), false);
  assert.equal(planUninstall(options).changes.length, 0);
});

test('protocol uninstall removes the block but keeps user content and frontmatter edits', (t) => {
  const geminiHome = fixture(t);
  const path = paths(geminiHome).protocol;
  apply(planSetup({ geminiHome }), false);
  const after = read(path).replace('trigger: model_decision', 'trigger: always_on') + '\nCustom policy remains.\n';
  writeFileSync(path, after);
  apply(planSetup({ geminiHome }), false);
  assert.equal(read(path), after);
  apply(planUninstall({ geminiHome }), false);
  assert.match(read(path), /trigger: always_on/);
  assert.match(read(path), /Custom policy remains/);
  assert.equal(block(read(path)), undefined);
});

test('keeps unmarked third-party rules and customized legacy-looking AGENTS content', (t) => {
  const geminiHome = fixture(t);
  const p = paths(geminiHome);
  const agents = '# Global Model Routing & Codex Delegation Policy\n\nPersonal policy\n';
  const protocol = '# My manually authored protocol\n\nKeep this\n';
  put(p.agents, agents);
  put(p.protocol, protocol);
  assert.equal(apply(planSetup({ geminiHome }), false).warnings.length, 2);
  assert.equal(planUninstall({ geminiHome }).changes.length, 0);
  assert.equal(read(p.agents), agents);
  assert.equal(read(p.protocol), protocol);
});

test('legacy migration is bounded to one exact normalized fingerprint', () => {
  const text = 'prefix\r\n# Sample heading\r\n\r\nBody\r\n\r\nsuffix\r\n';
  const signature = { heading: '# Sample heading', lines: 3, digest: createHash('sha256').update('# Sample heading\n\nBody').digest('hex') };
  const match = legacySpan(text, signature);
  assert.ok(match);
  assert.equal(text.slice(match.from, match.to), '# Sample heading\r\n\r\nBody\r\n');
  assert.equal(legacySpan(text.replace('Body', 'User changed this'), signature), undefined);
  assert.equal(legacySpan(text + text, signature), undefined);
});

test('refuses malformed or duplicate marker pairs instead of overwriting', (t) => {
  const geminiHome = fixture(t);
  const p = paths(geminiHome);
  put(p.agents, 'My note\n' + end + '\n');
  assert.throws(() => planSetup({ geminiHome }), /expected one ordered pair/);
  assert.throws(() => planUninstall({ geminiHome }), /expected one ordered pair/);
  assert.equal(rulesStatus(geminiHome).agents.status, 'invalid');
  assert.throws(() => block([start, end, start, end].join('\n')), /Invalid/);
  assert.equal(existsSync(p.protocol), false);
});

test('managed files are never written through symlinks', { skip: process.platform === 'win32' }, (t) => {
  const geminiHome = fixture(t);
  const path = paths(geminiHome).agents;
  put(path, '');
  const other = put(join(geminiHome, 'external.txt'), 'untouched');
  const target = join(geminiHome, 'GEMINI.md');
  symlinkSync(other, target);
  assert.throws(() => planSetup({ geminiHome, syncGeminiCli: true }), /Not a regular file/);
  assert.equal(read(other), 'untouched');
});

test('skill is synced only if different, and can be skipped', (t) => {
  const geminiHome = fixture(t);
  const { skill } = paths(geminiHome);
  const source = put(join(geminiHome, 'package', 'SKILL.md'), '# New skill\n');
  put(skill, '# Old skill\n');
  const plan = planSetup({ geminiHome }, source);
  assert.deepEqual(apply(plan, true).files.map(({ path }) => path).includes(skill), true);
  assert.equal(read(skill), '# Old skill\n');
  apply(planSetup({ geminiHome, syncSkill: false }, source), false);
  assert.equal(read(skill), '# Old skill\n');
  apply(planSetup({ geminiHome }, source), false);
  assert.equal(read(skill), '# New skill\n');
  assert.equal(planSetup({ geminiHome }, source).changes.length, 0);
});
