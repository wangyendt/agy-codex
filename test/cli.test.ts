import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { manifest } from '../src/package.js';
import { paths, start } from '../src/rules.js';
import type { RunReport } from '../src/run.js';
import { codexArgs } from '../src/run.js';
import { fixture, put } from './fixture.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const mock = fileURLToPath(new URL('./fixtures/mock-codex.mjs', import.meta.url));

function invoke(args: string[], input = '', env = process.env) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', input, env, timeout: 30000 });
  if (result.error) throw result.error;
  return result;
}

test('CLI setup and uninstall round-trip managed blocks; offline doctor emits clean JSON', (t) => {
  const root = fixture(t);
  const home = join(root, 'gemini');
  const p = paths(home);
  put(p.agents, 'My personal note\n');
  const setup = invoke(['setup', '--gemini-home', home, '--sync-gemini-cli', '--no-install-deps', '--no-sync-skill', '--json']);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).files.length, 3);
  assert.equal(readFileSync(p.agents, 'utf8').split(start).length, 2);
  assert.equal(existsSync(p.gemini), true);

  const local = join(root, 'codex');
  put(join(local, 'auth.json'), '{"OPENAI_API_KEY":"super-secret"}');
  const doctor = invoke(['doctor', '--offline', '--json', '--gemini-home', home, '--codex-home', local], '',
    { ...process.env, NO_COLOR: undefined, FORCE_COLOR: '1' });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.ok(!doctor.stdout.includes('\x1b') && !doctor.stderr.includes('\x1b'));
  assert.ok(!doctor.stdout.includes('super-secret'));
  const health = JSON.parse(doctor.stdout);
  assert.equal(health.offline, true);
  assert.equal(health.rules.agents.status, 'managed');
  assert.equal(health.rules.protocol.status, 'managed');
  assert.equal(health.auth.status, 'api-key');

  const uninstall = invoke(['uninstall', '--gemini-home', home, '--sync-gemini-cli', '--json']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(readFileSync(p.agents, 'utf8'), 'My personal note\n');
  assert.equal(existsSync(p.protocol), false);
});

test('piped doctor is plain by default, honors FORCE_COLOR, and lets NO_COLOR opt out', (t) => {
  const home = fixture(t);
  const args = ['doctor', '--offline', '--gemini-home', home, '--codex-home', home];
  const env = { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined };
  const plain = invoke(args, '', env);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(!plain.stdout.includes('\x1b'));
  const colored = invoke(args, '', { ...env, FORCE_COLOR: '1' });
  assert.equal(colored.status, 0, colored.stderr);
  assert.ok(colored.stdout.startsWith('\x1b[1mComponent\x1b[0m'));
  const disabled = invoke(args, '', { ...env, FORCE_COLOR: '1', NO_COLOR: '1' });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout, plain.stdout);
});

test('upgrade lists verified current packages in human output and keeps JSON clean', (t) => {
  const root = fixture(t);
  const npm = put(join(root, 'npm-cli.js'), `
    if (process.argv[2] !== 'view') throw new Error('Unexpected npm command');
    if (process.argv[3] === 'agy-codex@latest') console.log(JSON.stringify(${JSON.stringify(manifest.version)}));
    else {
      console.log('{"error":{"code":"E404"}}');
      process.exitCode = 1;
    }
  `, 0o755);
  const args = ['upgrade', '--only', 'agy-codex', '--no-rules', '--gemini-home', root];
  const env = { ...process.env, npm_execpath: npm, FORCE_COLOR: '1' };
  const message = `All checked npm packages are up to date (agy-codex ${manifest.version}).`;
  const human = invoke(args, '', env);
  assert.equal(human.status, 0, human.stderr);
  assert.ok(human.stdout.split('\n').includes(message));

  const json = invoke([...args, '--json'], '', env);
  assert.equal(json.status, 0, json.stderr);
  assert.ok(!json.stdout.includes('\x1b'));
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.commands, []);
  assert.ok(report.observations.includes(message));

  const unpublished = invoke([...args, '--only', 'agy-codex,codex-task'], '', env);
  assert.equal(unpublished.status, 0, unpublished.stderr);
  assert.match(unpublished.stdout, /codex-task is not published/);
  assert.doesNotMatch(unpublished.stdout, /All checked npm packages are up to date/);
});

test('CLI --no-install-deps overrides both opt-in aliases regardless of order', (t) => {
  const root = fixture(t);
  const npm = put(join(root, 'npm-cli.js'), 'throw new Error("must not run npm")');
  const env: NodeJS.ProcessEnv = { ...process.env, npm_execpath: npm };
  for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name];
  const setup = invoke(['setup', '--gemini-home', root, '--no-install-deps', '--yes', '--install-deps', '--json'], '', env);
  assert.equal(setup.status, 0, setup.stderr + setup.stdout);
  assert.equal(JSON.parse(setup.stdout).commands[0].status, 'skipped');
});

test('run combines brief, arbitrary prompt and stdin; saves final message, raw stream, and workspace thread', (t) => {
  const root = fixture(t);
  const state = join(root, 'state', 'workspace threads.json');
  const output = join(root, 'output', 'final.md');
  const events = join(root, 'output', 'events.jsonl');
  const brief = put(join(root, 'brief notes.md'), 'Task handoff 中文\n');
  const image = put(join(root, 'a & b.png'), '');
  let bin = mock;
  if (process.platform === 'win32') {
    put(join(root, 'node_modules', 'mock-codex', 'bin.mjs'), readFileSync(mock, 'utf8'));
    bin = put(join(root, 'codex mock.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\mock-codex\\bin.mjs" %*\r\n');
  }
  const initial = invoke(['run', '-C', root, '--codex-bin', bin, '--thread-state', state, '-f', brief,
    '-i', image, '-i', image, '--model', 'model with spaces', '--reasoning', 'high', '--thread-source', 'workspace',
    '-o', output, '--events-log', events, '--json', '--', '- review "quoted"; $HOME & %USERPROFILE% !'], 'stdin content\n');
  assert.equal(initial.status, 0, initial.stderr);
  const result = JSON.parse(initial.stdout) as RunReport;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.threadId, 'thread-mock');
  assert.equal(result.resumed, false);
  assert.equal(result.codexVersion, '0.172.0');
  assert.equal(result.outputPath, output);
  assert.equal(readFileSync(output, 'utf8'), result.text);
  const text = JSON.parse(result.text);
  assert.equal(text.stdin, 'Task handoff 中文\n\n\n- review "quoted"; $HOME & %USERPROFILE% !\n\nstdin content\n');
  assert.equal(realpathSync(text.cwd), realpathSync(root));
  assert.deepEqual(text.argv.slice(0, 5), ['exec', '-C', realpathSync(root), '-s', 'workspace-write']);
  assert.ok(text.argv.includes('--skip-git-repo-check'));
  assert.ok(text.argv.includes('model_reasoning_effort="high"'));
  assert.ok(text.argv.includes('--model=model with spaces'));
  assert.ok(text.argv.includes('--thread-source=workspace'));
  assert.equal(text.argv.filter((arg: string) => arg === '--image=' + image).length, 2);
  const eventLog = readFileSync(events, 'utf8');
  assert.match(eventLog, /not-json\n/);
  assert.ok(eventLog.endsWith('{"type":"turn.completed"}'));
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), { [realpathSync(root)]: 'thread-mock' });
});

test('run resumes saved workspace threads, --new replaces the mapping, and --fork records a new ID', (t) => {
  const root = fixture(t);
  const state = put(join(root, 'state.json'), JSON.stringify({ [realpathSync(root)]: 'existing', other: 'preserve' }));
  const args = ['run', '--cwd', root, '--codex-bin', mock, '--thread-state', state, '--json'];
  const resumed = invoke([...args, 'delta only']);
  assert.equal(resumed.status, 0, resumed.stderr);
  const result = JSON.parse(resumed.stdout) as RunReport;
  assert.equal(result.resumed, true);
  assert.equal(result.threadId, 'existing');
  assert.deepEqual(JSON.parse(result.text).argv.slice(-3), ['--', 'existing', '-']);

  const fresh = invoke([...args, '--new', 'fresh']);
  assert.equal(fresh.status, 0, fresh.stderr);
  const freshResult = JSON.parse(fresh.stdout) as RunReport;
  assert.equal(freshResult.resumed, false);
  assert.ok(JSON.parse(freshResult.text).argv.includes('--thread-source=agy-codex'));
  assert.equal(JSON.parse(readFileSync(state, 'utf8'))[realpathSync(root)], 'thread-fresh');

  const fork = invoke([...args, '--fork', 'thread-fresh', 'fork delta']);
  assert.equal(fork.status, 0, fork.stderr);
  assert.equal(JSON.parse(fork.stdout).threadId, 'thread-fork');
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), { [realpathSync(root)]: 'thread-fork', other: 'preserve' });
});

test('run leaves thread-state intact for reviews and failed turns and propagates exit code', (t) => {
  const root = fixture(t);
  const original = JSON.stringify({ [realpathSync(root)]: 'do-not-change' });
  const state = put(join(root, 'state.json'), original);
  const args = ['run', '--cwd', root, '--codex-bin', mock, '--thread-state', state, '--json'];
  const review = invoke([...args, '--review', '--uncommitted']);
  assert.equal(review.status, 0, review.stderr);
  const { argv } = JSON.parse(JSON.parse(review.stdout).text);
  assert.ok(argv.includes('review') && argv.includes('--uncommitted') && !argv.includes('resume'));
  assert.equal(readFileSync(state, 'utf8'), original);
  const fail = invoke([...args, '--new', 'fresh'], '', { ...process.env, MOCK_FAIL: 'true' });
  assert.equal(fail.status, 7, fail.stderr);
  assert.equal(JSON.parse(fail.stdout).ok, false);
  assert.equal(readFileSync(state, 'utf8'), original);
});

test('run refuses overlapping artifacts and malformed state without overwriting them', (t) => {
  const root = fixture(t);
  const file = put(join(root, 'input.txt'), 'preserve me');
  const args = ['run', '--cwd', root, '--codex-bin', mock, '--json'];
  const overlap = invoke([...args, '--brief', file, '-o', file]);
  assert.equal(overlap.status, 1);
  assert.match(overlap.stderr, /must not overlap/);
  assert.equal(JSON.parse(overlap.stdout).status, 'failed');
  const state = invoke([...args, '--thread-state', file, 'prompt']);
  assert.equal(state.status, 1);
  assert.match(state.stderr, /Invalid thread-state/);
  assert.equal(readFileSync(file, 'utf8'), 'preserve me');
});

test('Git worktrees are recognized and dangerous bypass must be explicitly selected', (t) => {
  const root = fixture(t);
  put(join(root, '.git'), 'gitdir: /some/elsewhere\n');
  const subdir = join(root, 'subdir');
  const args = codexArgs({ sandbox: 'workspace-write' }, subdir, 'new', undefined, true);
  assert.ok(!args.includes('--skip-git-repo-check'));
  assert.ok(args.includes('-s'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const explicit = codexArgs({ sandbox: 'workspace-write', dangerouslyBypassApprovalsAndSandbox: true }, subdir, 'new', undefined, true);
  assert.ok(!explicit.includes('-s'));
  assert.ok(explicit.includes('--dangerously-bypass-approvals-and-sandbox'));
});
