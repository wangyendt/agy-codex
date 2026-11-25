import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { authStatus, detectProxy, latest, parseMacProxy, parseWindowsProxy, proxyEnvironment, sdkInfo, selectCodex } from '../src/environment.js';
import { npmShimTarget } from '../src/process.js';
import type { Command } from '../src/process.js';
import { compareVersions, readVersion } from '../src/semver.js';
import { fixture, put } from './fixture.js';

test('semantic version precedence handles numeric and mixed prereleases, not lexical order', () => {
  const sorted = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.10', '1.1.0'];
  for (let i = 1; i < sorted.length; i++) assert.ok(compareVersions(sorted[i - 1]!, sorted[i]!) < 0);
  assert.equal(compareVersions('v1.0.0+desktop', '1.0.0+standalone'), 0);
  assert.equal(readVersion('warning line\ncodex-cli 0.172.0'), '0.172.0');
  assert.equal(readVersion('codex-cli 0.172.0-01'), undefined);
  assert.equal(readVersion('codex-cli 0.172.0-01a'), '0.172.0-01a');
  assert.throws(() => compareVersions('oops', '1.0.0'));
});

test('selects newest usable Codex; prefers standalone on ties', () => {
  const cli = { path: 'cli', version: '0.172.0' };
  const desktop = { path: 'desktop', version: '0.172.0-rc.2' };
  assert.equal(selectCodex(cli, desktop), cli);
  assert.equal(selectCodex(cli, { ...desktop, version: '0.172.0+different' }), cli);
  assert.equal(selectCodex({ ...cli, version: '0.100.0' }, desktop), desktop);
  assert.equal(selectCodex({ ...cli, version: null }, desktop), desktop);
  assert.equal(selectCodex({ ...cli, version: null }), undefined);
});

test('parses macOS scutil proxy fields independently and handles IPv6', () => {
  assert.deepEqual(parseMacProxy(
    '<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 8080\n HTTPSEnable : 1\n HTTPSProxy : ::1\n HTTPSPort : 8443\n ExceptionsList : <array> {\n  0 : localhost\n  1 : .example.test\n }\n}'),
  { http: 'http://127.0.0.1:8080', https: 'http://[::1]:8443', noProxy: 'localhost,.example.test' });
  assert.deepEqual(parseMacProxy('HTTPEnable : 0\nHTTPProxy : stale\nHTTPPort : 8080'), {});
  assert.deepEqual(parseMacProxy('HTTPEnable : 1\nHTTPProxy : proxy\nHTTPPort : 8080'),
    { http: 'http://proxy:8080', https: 'http://proxy:8080' });
});

test('Windows WinINET parses enabled per-scheme and shared proxies', () => {
  assert.deepEqual(parseWindowsProxy(
    '  ProxyEnable    REG_DWORD    0x1\r\n  ProxyServer    REG_SZ    http=proxy:8080;https=other:8443\r\n  ProxyOverride    REG_SZ    localhost;<local>;*.example.test\r\n'),
  { http: 'http://proxy:8080', https: 'http://other:8443', noProxy: 'localhost,*.example.test' });
  assert.deepEqual(parseWindowsProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ proxy:8000'),
    { http: 'http://proxy:8000', https: 'http://proxy:8000' });
  assert.deepEqual(parseWindowsProxy('ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ stale:8080'), {});
});

test('Linux proxy uses environment without OS probes and fills case aliases', async () => {
  const never: Command = async () => assert.fail('must not query an OS proxy on Linux');
  const given = { http_proxy: 'http://already', ALL_PROXY: 'socks5://other', NO_PROXY: 'localhost' };
  const report = await detectProxy(never, given, 'linux');
  assert.deepEqual(report.sources, { http: 'env', https: 'env', noProxy: 'env' });
  assert.equal(report.env.HTTP_PROXY, given.http_proxy);
  assert.equal(report.env.no_proxy, given.NO_PROXY);
  assert.equal(report.env.HTTPS_PROXY, undefined);
});

test('explicit proxy configuration wins and Windows env contains no duplicate case aliases', () => {
  const report = proxyEnvironment({ https_proxy: 'custom', No_Proxy: 'a' }, { http: 'system', https: 'alternate', noProxy: 'b' }, 'win32');
  assert.deepEqual(report.sources, { http: 'win32', https: 'env', noProxy: 'env' });
  assert.deepEqual(report.env, { HTTP_PROXY: 'system', https_proxy: 'custom', No_Proxy: 'a' });
});

test('auth reports only status and expiry for JWT, explicit expiry, missing, and invalid JSON', (t) => {
  const root = fixture(t);
  const path = join(root, 'auth.json');
  assert.equal(authStatus(root).status, 'missing');
  const secret = 'not-to-print';
  const epoch = 1970000000;
  put(path, JSON.stringify({ tokens: { refresh_token: secret, access_token: 'header.' + Buffer.from(JSON.stringify({ exp: epoch })).toString('base64url') + '.signature' } }));
  const info = authStatus(root, (epoch - 60) * 1000);
  assert.equal(info.status, 'valid');
  assert.equal(info.expiresAt, new Date(epoch * 1000).toISOString());
  assert.ok(!JSON.stringify(info).includes(secret));
  assert.equal(authStatus(root, (epoch + 1) * 1000).status, 'expired');
  put(path, '{"expires_at":"2025-07-10T12:00:00Z","access_token":"opaque"}');
  assert.equal(authStatus(root).expiresAt, '2025-07-10T12:00:00.000Z');
  put(path, '{"OPENAI_API_KEY":"private"}');
  assert.equal(authStatus(root).status, 'api-key');
  put(path, '{invalid');
  assert.equal(authStatus(root).status, 'unreadable');
});

test('reads nested and hoisted SDK metadata, independent of the codex-task version', async (t) => {
  const root = fixture(t);
  const modules = join(root, 'node_modules');
  const task = join(modules, 'codex-task');
  const bin = put(join(task, 'dist', 'cli.js'), '');
  put(join(task, 'package.json'), '{"name":"codex-task","version":"0.2.18"}');
  const hoisted = put(join(modules, '@openai', 'codex-sdk', 'package.json'), '{"version":"0.170.0"}');
  assert.deepEqual(await sdkInfo({ path: bin, version: '0.2.18' }), { path: hoisted, version: '0.170.0' });
  const nested = put(join(task, 'node_modules', '@openai', 'codex-sdk', 'package.json'), '{"version":"0.171.0"}');
  assert.deepEqual(await sdkInfo({ path: bin, version: '0.2.18' }), { path: nested, version: '0.171.0' });
});

test('Windows settles npm batch shims to fixed Node/.exe paths without shell evaluation', () => {
  const header = '@ECHO off\r\nSET "_prog=node"\r\n';
  assert.equal(npmShimTarget(header + 'endLocal & "%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'),
    'node_modules\\@openai\\codex\\bin\\codex.js');
  assert.equal(npmShimTarget('"%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n'),
    'node_modules\\npm\\bin\\npm-cli.js');
  assert.equal(npmShimTarget('SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n'),
    'node_modules\\npm\\bin\\npm-cli.js');
  assert.equal(npmShimTarget('"%_prog%" "%dp0%\\..\\codex-task\\dist\\cli.js" %*', true), '..\\codex-task\\dist\\cli.js');
  assert.equal(npmShimTarget('"%_prog%" "%dp0%\\..\\codex-task\\dist\\cli.js" %*'), undefined);
  assert.equal(npmShimTarget('"%dp0%\\node_modules\\..\\arbitrary.exe" %*'), undefined);
  assert.equal(npmShimTarget('echo unsafe & codex %*'), undefined);
});

test('registry lookup separates offline, unpublished, failure, and verified versions', async () => {
  const env = process.env;
  const never: Command = async () => assert.fail('offline doctor called the registry');
  assert.deepEqual(await latest('agy-codex', {}, true, never, env), { version: null, status: 'offline' });
  const fixed = (code: number, stdout: string): Command => async (_file, args) => {
    assert.ok(!args.some((arg) => arg.startsWith('--logs-max')));
    return { code, stdout, stderr: 'private' };
  };
  assert.deepEqual(await latest('agy-codex', {}, false, fixed(1, '{"error":{"code":"E404"}}'), env), { version: null, status: 'unpublished' });
  assert.deepEqual(await latest('agy-codex', {}, false, fixed(1, ''), env), { version: null, status: 'unavailable' });
  assert.deepEqual(await latest('agy-codex', {}, false, fixed(0, '"0.1.1"'), env), { version: '0.1.1', status: 'ok' });
});
