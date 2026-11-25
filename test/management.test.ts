import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { askInstall, doctor, parseOnly, setup, upgrade } from '../src/management.js';
import type { ManagementDeps } from '../src/management.js';
import type { Command } from '../src/process.js';
import { paths } from '../src/rules.js';
import { activeTaskService } from '../src/service.js';
import { fixture } from './fixture.js';

function fake(options: { interactive?: boolean; answer?: boolean; lookup?: string } = {}) {
  const calls: string[][] = [];
  const questions: string[] = [];
  const exec: Command = async (_path, args) => {
    calls.push(args);
    if (args[0] === 'view') return options.lookup
      ? { code: 0, stdout: JSON.stringify(options.lookup), stderr: '' }
      : { code: 1, stdout: '{"error":{"code":"E404"}}', stderr: '' };
    if (args[0] === 'install') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name];
  const deps: ManagementDeps = {
    exec, env, interactive: options.interactive ?? false,
    ask: async (question) => { questions.push(question); return options.answer ?? false; },
  };
  return { calls, questions, deps };
}

test('setup prompts once with [Y/n] for missing packages when interactive', async (t) => {
  const f = fake({ interactive: true, answer: true });
  const report = await setup({ geminiHome: fixture(t), syncSkill: false, json: true }, f.deps);
  assert.match(f.questions[0] ?? '', /@openai\/codex, codex-task\? \[Y\/n\]/);
  assert.equal(f.questions.length, 1);
  assert.deepEqual(f.calls.filter(([first]) => first === 'install'), [['install', '-g', '@openai/codex', 'codex-task', '--prefer-online']]);
  assert.equal(report.ok, true);
  assert.equal(report.commands[0]?.status, 'executed');
  assert.equal(report.files.length, 2);
});

test('default yes, negative response, and EOF are handled by the actual prompt reader', async () => {
  for (const [input, wanted] of [['\n', true], ['YEs\n', true], ['n\n', false], ['', false]] as const) {
    let captured = '';
    const output = new Writable({ write: (chunk: Buffer, _encoding, cb) => { captured += chunk.toString(); cb(); } });
    assert.equal(await askInstall('Install? [Y/n] ', Readable.from(input ? [input] : []), output), wanted);
    assert.equal(captured, 'Install? [Y/n] ');
  }
});

test('setup --yes or --install-deps auto-installs and delegates prefix/registry as separate arguments', async (t) => {
  const geminiHome = fixture(t);
  const prefix = join(geminiHome, 'prefix with spaces');
  for (const automatic of [{ yes: true }, { installDeps: true }]) {
    const f = fake();
    const registry = 'https://registry.example.test/';
    const report = await setup({ ...automatic, geminiHome, prefix, registry, syncSkill: false, json: true }, f.deps);
    assert.equal(report.ok, true);
    assert.equal(f.questions.length, 0);
    assert.deepEqual(f.calls.filter(([first]) => first === 'install'), [
      ['install', '-g', '@openai/codex', 'codex-task', '--prefer-online', '--prefix=' + resolve(prefix), '--registry=' + registry],
    ]);
  }
});

test('setup never silently installs for non-TTY, declined, or --no-install-deps', async (t) => {
  const geminiHome = fixture(t);
  for (const [interactive, disabled, askCount] of [[false, false, 0], [true, false, 1], [true, true, 0]] as const) {
    const f = fake({ interactive });
    const report = await setup({ geminiHome, ...(disabled && { yes: true, installDeps: false }), syncSkill: false }, f.deps);
    assert.equal(f.questions.length, askCount);
    assert.equal(f.calls.some(([first]) => first === 'install'), false);
    assert.equal(report.commands[0]?.status, 'skipped');
    assert.deepEqual(report.hints, ['npm install -g @openai/codex codex-task --prefer-online']);
    assert.equal(existsSync(paths(geminiHome).protocol), true);
  }
});

test('setup --dry-run previews rule writes and dependency installation without changing disk', async (t) => {
  const geminiHome = join(fixture(t), 'unused');
  const f = fake({ interactive: true, answer: true });
  const result = await setup({ geminiHome, dryRun: true, yes: true, syncGeminiCli: true }, f.deps);
  assert.equal(result.files.length, 3);
  assert.equal(result.commands[0]?.status, 'planned');
  assert.equal(existsSync(geminiHome), false);
  assert.equal(f.questions.length, 0);
  assert.equal(f.calls.some(([first]) => first === 'install'), false);
});

test('doctor offline reports all five components without invoking npm', async (t) => {
  const root = fixture(t);
  const f = fake();
  const report = await doctor({ offline: true, geminiHome: root, codexHome: root }, f.deps);
  assert.deepEqual(Object.keys(report.components), ['agy-codex', 'codex', 'desktop', 'codex-task', 'sdk']);
  assert.ok(Object.values(report.components).every((component) => component.registry === 'offline' && component.latest === null));
  assert.equal(report.rules.agents.status, 'missing');
  assert.equal(report.auth.present, false);
  assert.ok(!f.calls.some(([first]) => first === 'view'));
});

test('upgrade honors --only, --no-rules, --no-restart-service, and dry-run', async (t) => {
  const geminiHome = join(fixture(t), 'unused');
  assert.deepEqual(parseOnly('codex, agy-codex,codex'), ['codex', 'agy-codex']);
  assert.throws(() => parseOnly('codex,sdk'), /--only expects/);
  const f = fake({ lookup: '9.5.2' });
  const dry = await upgrade({ geminiHome, only: 'codex-task', yes: true, rules: false, restartService: false, dryRun: true }, f.deps);
  assert.deepEqual(dry.commands, [{ command: 'npm', args: ['install', '-g', 'codex-task@latest', '--prefer-online'], status: 'planned' }]);
  assert.equal(f.calls.some(([first]) => first === 'install'), false);
  const actual = await upgrade({ geminiHome, only: 'codex', yes: true, rules: false, restartService: false, json: true }, f.deps);
  const install = ['install', '-g', '@openai/codex@latest', '--prefer-online'];
  assert.deepEqual(actual.commands, [{ command: 'npm', args: install, status: 'executed' }]);
  assert.deepEqual(f.calls.filter(([first]) => first === 'install'), [install]);
  assert.equal(existsSync(geminiHome), false);
});

test('platform service probe proposes a restart only for the running user service', async () => {
  const active: Command = async () => ({
    code: 0,
    stdout: process.platform === 'darwin' ? '    state = running\n' : 'Running\n',
    stderr: '',
  });
  const action = await activeTaskService(active, process.env);
  if (process.platform === 'darwin') assert.match(action?.args.join(' ') ?? '', /kickstart -k gui\/\d+\/com\.wangyendt\.codex-task/);
  if (process.platform === 'win32') assert.match(action?.args.join(' ') ?? '', /Stop-ScheduledTask.*Start-ScheduledTask/);
  if (process.platform === 'linux' && action) assert.deepEqual(action.args, ['--user', 'restart', 'codex-task.service']);
  assert.equal(await activeTaskService(async () => ({ code: 1, stdout: '', stderr: '' }), process.env), undefined);
});
