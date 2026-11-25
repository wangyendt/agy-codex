import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readOptional } from './fs.js';
import { manifest } from './package.js';
import { command, executable, findOnPath, npmExecutable, packageRoot } from './process.js';
import type { Command } from './process.js';
import { compareVersions, newest, readVersion } from './semver.js';

export interface ToolOptions {
  prefix?: string;
  registry?: string;
}

export const macDesktop = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

export const packageNames = {
  'agy-c': 'agy-c',
  codex: '@openai/codex',
  'codex-task': 'codex-task',
} as const;
export type Component = keyof typeof packageNames;

export interface Binary {
  path: string;
  version: string | null;
}

export interface ProxyValues {
  http?: string;
  https?: string;
  noProxy?: string;
}

function proxyUrl(value: string, port?: string): string | undefined {
  if (!value) return undefined;
  const host = port && value.includes(':') && !value.includes('://') && !value.startsWith('[')
    ? '[' + value + ']' : value;
  try {
    const url = new URL((host.includes('://') ? '' : 'http://') + host + (port ? ':' + port : ''));
    if (url.hostname && ['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
      return url.origin === 'null' ? url.href : url.href.replace(/\/$/, '');
    }
  } catch { /* Ignore invalid OS proxy values. */ }
  return undefined;
}

export function parseMacProxy(output: string): ProxyValues {
  const value = (key: string) => new RegExp('^\\s*' + key + '\\s*:\\s*([^\\r\\n]+)', 'm').exec(output)?.[1]?.trim();
  const enabledProxy = (scheme: string) => {
    const host = value(scheme + 'Proxy');
    const port = value(scheme + 'Port');
    return value(scheme + 'Enable') === '1' && host && port ? proxyUrl(host, port) : undefined;
  };
  const http = enabledProxy('HTTP');
  const https = enabledProxy('HTTPS') ?? http;
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]+)}/.exec(output)?.[1];
  const noProxy = [...(exceptions ?? '').matchAll(/^\s*\d+\s*:\s*(\S+)/gm)].map((item) => item[1]).join(',');
  return { ...(http && { http }), ...(https && { https }), ...(noProxy && { noProxy }) };
}

export function parseWindowsProxy(output: string): ProxyValues {
  const value = (name: string) => new RegExp('^\\s*' + name + '\\s+REG_\\w+\\s+([^\\r\\n]+)', 'mi').exec(output)?.[1]?.trim();
  if (Number(value('ProxyEnable')) !== 1) return {};
  const server = value('ProxyServer');
  if (!server) return {};
  const entries = new Map(server.split(';').filter((entry) => entry.includes('=')).map((entry) => {
    const i = entry.indexOf('=');
    return [entry.slice(0, i).trim().toLowerCase(), entry.slice(i + 1).trim()];
  }));
  const http = proxyUrl(entries.size ? entries.get('http') ?? '' : server);
  const https = proxyUrl(entries.size ? entries.get('https') ?? '' : server) ?? http;
  const noProxy = value('ProxyOverride')?.split(';').map((entry) => entry.trim())
    .filter((entry) => entry && entry.toLowerCase() !== '<local>').join(',');
  return { ...(http && { http }), ...(https && { https }), ...(noProxy && { noProxy }) };
}

export function proxyEnvironment(env: NodeJS.ProcessEnv, detected: ProxyValues, os: NodeJS.Platform) {
  const merged = { ...env };
  const sources = { http: 'none', https: 'none', noProxy: 'none' };
  for (const [key, name] of [['http', 'HTTP_PROXY'], ['https', 'HTTPS_PROXY'], ['noProxy', 'NO_PROXY']] as const) {
    const matching = Object.entries(env).filter(([variable, value]) =>
      variable.toUpperCase() === name && value);
    const explicit = env[name.toLowerCase()] || env[name] || matching[0]?.[1];
    const fallback = key !== 'noProxy'
      ? env.all_proxy || env.ALL_PROXY || Object.entries(env).find(([key, value]) => key.toUpperCase() === 'ALL_PROXY' && value)?.[1]
      : undefined;
    const value = explicit || (!fallback ? detected[key] : undefined);
    if (value || fallback) sources[key] = explicit || fallback ? 'env' : os;
    if (!value) continue;
    if (os === 'win32') {
      // Windows process environments are case-insensitive; avoid colliding keys in spawn.
      if (!explicit) {
        for (const existing of Object.keys(merged)) if (existing.toUpperCase() === name) delete merged[existing];
        merged[name] = value;
      }
    } else {
      merged[name] ||= value;
      merged[name.toLowerCase()] ||= value;
    }
  }
  return { env: merged, sources };
}

export async function detectProxy(exec: Command = command, env = process.env, os = process.platform) {
  let detected: ProxyValues = {};
  if (os === 'darwin') {
    const query = await exec('/usr/sbin/scutil', ['--proxy'], { env });
    if (query.code === 0) detected = parseMacProxy(query.stdout);
  } else if (os === 'win32') {
    const reg = join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'reg.exe');
    const query = await exec(reg, ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { env });
    if (query.code === 0) detected = parseWindowsProxy(query.stdout);
  }
  return proxyEnvironment(env, detected, os);
}

export function powerShell(env = process.env): string {
  return join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export async function probe(path: string, exec: Command = command, env = process.env): Promise<Binary> {
  const result = await exec(path, ['--version'], { env });
  return { path, version: result.code === 0 ? readVersion(result.stdout) ?? readVersion(result.stderr) ?? null : null };
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    try {
      if (!executable(path)) return false;
      const real = realpathSync(path);
      const key = process.platform === 'win32' ? real.toLowerCase() : real;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    } catch {
      return false;
    }
  });
}

export function prefixedBins(name: string, prefix?: string): string[] {
  if (!prefix) return [];
  return process.platform === 'win32'
    ? [join(prefix, name + '.exe'), join(prefix, name + '.cmd')]
    : [join(prefix, 'bin', name)];
}

async function desktopPaths(exec: Command, env: NodeJS.ProcessEnv): Promise<string[]> {
  if (process.platform === 'darwin') {
    return [macDesktop, join(homedir(), macDesktop.replace(/^\//, ''))];
  }
  if (process.platform !== 'win32') return [];
  const install = await exec(powerShell(env), ['-NoProfile', '-NonInteractive', '-Command',
    "Get-AppxPackage | Where-Object { $_.Name -match '^OpenAI\\.(ChatGPT|Codex)$' } | Select-Object -ExpandProperty InstallLocation"], { env });
  const locations = install.code === 0 ? install.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  const local = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles;
  const roots = [
    ...locations,
    ...(local ? [join(local, 'Programs', 'ChatGPT'), join(local, 'Programs', 'Codex')] : []),
    ...(programFiles ? [join(programFiles, 'OpenAI', 'ChatGPT'), join(programFiles, 'OpenAI', 'Codex')] : []),
  ];
  return roots.flatMap((root) => [
    join(root, 'app', 'resources', 'codex.exe'), join(root, 'resources', 'codex.exe'),
    join(root, 'resources', 'codex-cli', 'codex.exe'), join(root, 'app', 'resources', 'codex-cli', 'codex.exe'),
    join(root, 'codex.exe'),
  ]);
}

export function selectCodex(standalone?: Binary, desktop?: Binary): Binary | undefined {
  return newest([standalone, desktop].filter((bin): bin is Binary => bin !== undefined));
}

export async function findCodex(options: ToolOptions = {}, exec: Command = command, env = process.env) {
  const candidates = uniquePaths([...prefixedBins('codex', options.prefix), ...findOnPath('codex', env)]);
  const [standaloneBins, desktopBins] = await Promise.all([
    Promise.all(candidates.map((path) => probe(path, exec, env))),
    desktopPaths(exec, env).then((paths) => Promise.all(uniquePaths(paths).map((path) => probe(path, exec, env)))),
  ]);
  const standalone = newest(standaloneBins) ?? standaloneBins[0];
  const desktop = newest(desktopBins) ?? desktopBins[0];
  return { standalone, desktop, selected: selectCodex(standalone, desktop) };
}

export async function findTask(options: ToolOptions = {}, exec: Command = command, env = process.env) {
  const candidates = uniquePaths([...prefixedBins('codex-task', options.prefix), ...findOnPath('codex-task', env)]);
  const bins = await Promise.all(candidates.map((path) => probe(path, exec, env)));
  return newest(bins) ?? bins[0];
}

export function npmFlags(options: ToolOptions): string[] {
  return [...(options.prefix ? ['--prefix=' + resolve(options.prefix)] : []),
    ...(options.registry ? ['--registry=' + options.registry] : [])];
}

export type RegistryVersion = { version: string | null; status: 'ok' | 'offline' | 'unpublished' | 'unavailable' };

export async function latest(name: string, options: ToolOptions, offline: boolean, exec: Command, env: NodeJS.ProcessEnv): Promise<RegistryVersion> {
  if (offline) return { version: null, status: 'offline' };
  const npm = npmExecutable(env);
  if (!npm) return { version: null, status: 'unavailable' };
  // npm still prunes its log directory when logs-max is zero; leave retention to the user.
  const result = await exec(npm, ['view', name + '@latest', 'version', '--json', '--fetch-retries=0',
    '--fetch-timeout=8000', '--loglevel=silent', ...npmFlags(options)], { env, timeout: 10000 });
  try {
    const data: unknown = JSON.parse(result.stdout);
    if (result.code === 0 && typeof data === 'string' && readVersion(data) === data) return { version: data, status: 'ok' };
    if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object'
      && 'code' in data.error && data.error.code === 'E404') return { version: null, status: 'unpublished' };
  } catch { /* Never expose registry stderr or configuration. */ }
  return { version: null, status: 'unavailable' };
}

export async function sdkInfo(task?: Binary) {
  if (!task) return undefined;
  const root = await packageRoot(task.path, 'codex-task');
  if (!root) return undefined;
  // Follow npm's nested-or-hoisted node_modules layout without relying on SDK export maps.
  for (let dir = root; ; dir = dirname(dir)) {
    if (!dir.endsWith('/node_modules') && !dir.endsWith('\\node_modules')) {
      const path = join(dir, 'node_modules', '@openai', 'codex-sdk', 'package.json');
      try {
        const text = readOptional(path);
        if (text) {
          const { version } = JSON.parse(text) as { version?: string };
          return { version: typeof version === 'string' && readVersion(version) === version ? version : null, path };
        }
      } catch { return { version: null, path }; }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function expiry(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(value)) {
    const number = Number(value);
    return number > 0 && Number.isFinite(number) ? number * (number < 1e12 ? 1000 : 1) : undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function jwtExpiry(token: unknown): number | undefined {
  if (typeof token !== 'string') return undefined;
  const payload = token.split('.')[1];
  if (!payload || !/^[\w-]+$/.test(payload)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? expiry(claims.exp) : undefined;
  } catch { return undefined; }
}

export function authStatus(home: string, now = Date.now()) {
  const path = join(home, 'auth.json');
  try {
    const content = readOptional(path);
    if (content === undefined) return { path, present: false, status: 'missing', expiresAt: null };
    const parsed = JSON.parse(content) as {
      tokens?: { access_token?: unknown; expires_at?: unknown };
      access_token?: unknown; expires_at?: unknown; OPENAI_API_KEY?: unknown;
    };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid auth data');
    const token = parsed.tokens?.access_token ?? parsed.access_token;
    const expires = expiry(parsed.tokens?.expires_at ?? parsed.expires_at) ?? jwtExpiry(token);
    const time = expires === undefined ? null : new Date(expires);
    const expiresAt = time && Number.isFinite(time.getTime()) ? time.toISOString() : null;
    const status = expiresAt && expires !== undefined ? (expires <= now ? 'expired' : 'valid')
      : token || parsed.tokens ? 'expiry-unknown' : parsed.OPENAI_API_KEY ? 'api-key' : 'unknown';
    return { path, present: true, status, expiresAt };
  } catch {
    return { path, present: existsSync(path), status: 'unreadable', expiresAt: null };
  }
}

export async function versions(options: ToolOptions, offline: boolean, exec: Command, env: NodeJS.ProcessEnv) {
  const [codex, task, agyLatest, codexLatest, taskLatest, sdkLatest] = await Promise.all([
    findCodex(options, exec, env), findTask(options, exec, env),
    latest(packageNames['agy-c'], options, offline, exec, env),
    latest(packageNames.codex, options, offline, exec, env),
    latest(packageNames['codex-task'], options, offline, exec, env),
    latest('@openai/codex-sdk', options, offline, exec, env),
  ]);
  const sdk = await sdkInfo(task);
  return {
    'agy-c': component({ path: process.argv[1] ?? '', version: manifest.version }, agyLatest),
    codex: component(codex.standalone, codexLatest),
    desktop: component(codex.desktop, codexLatest),
    'codex-task': component(task, taskLatest),
    sdk: component(sdk, sdkLatest),
    selectedCodex: codex.selected ?? null,
  };
}

function component(local: Binary | undefined, remote: RegistryVersion) {
  const version = local?.version ?? null;
  const status = !local ? 'missing' : !version ? 'unreadable' : !remote.version ? 'installed'
    : compareVersions(version, remote.version) < 0 ? 'outdated' : 'current';
  return { version, path: local?.path ?? null, latest: remote.version, registry: remote.status, status };
}
