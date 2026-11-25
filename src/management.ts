import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { authStatus, detectProxy, findCodex, findTask, npmFlags, packageNames, prefixedBins, sdkInfo, versions } from './environment.js';
import type { Component, ToolOptions } from './environment.js';
import { command, executable, npmExecutable, packageRoot } from './process.js';
import type { Command } from './process.js';
import { apply, planSetup, planUninstall, rulesStatus } from './rules.js';
import { compareVersions } from './semver.js';
import { activeTaskService } from './service.js';

export interface ManagementOpts extends ToolOptions {
  geminiHome?: string;
  yes?: boolean;
  installDeps?: boolean;
  dryRun?: boolean;
  json?: boolean;
  syncGeminiCli?: boolean;
  syncSkill?: boolean;
}

export interface UpgradeOpts extends ManagementOpts {
  only?: string;
  rules?: boolean;
  restartService?: boolean;
}

type Action = { command: string; args: string[]; status: 'planned' | 'skipped' | 'executed' | 'failed' };
type ChangedFiles = ReturnType<typeof apply>;

interface Report extends ChangedFiles {
  ok: boolean;
  dryRun: boolean;
  commands: Action[];
  hints: string[];
  observations: string[];
}

export function geminiHome(override?: string): string {
  return resolve(override ?? process.env.GEMINI_HOME ?? join(homedir(), '.gemini'));
}

export function askInstall(question: string, input: Readable, output: Writable): Promise<boolean> {
  return new Promise((resolve) => {
    const terminal = createInterface({ input, output, terminal: false });
    terminal.once('close', () => resolve(false));
    terminal.question(question, (answer) => {
      resolve(answer.trim() === '' || /^y(?:es)?$/i.test(answer.trim()));
      terminal.close();
    });
  });
}

export interface ManagementDeps {
  exec: Command;
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  env: NodeJS.ProcessEnv;
}

const deps = (): ManagementDeps => ({
  exec: command,
  interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  ask: (question) => askInstall(question, process.stdin, process.stderr),
  env: process.env,
});

function reportFor(options: ManagementOpts): Report {
  return { ok: true, dryRun: Boolean(options.dryRun), files: [], commands: [], hints: [], warnings: [], observations: [] };
}

export function shellCommand(file: string, args: string[]): string {
  const quote = (value: string) => {
    if (/^[\w.@/:=+-]+$/.test(value)) return value;
    if (process.platform !== 'win32') return "'" + value.replace(/'/g, "'\\''") + "'";
    return "'" + value.replace(/'/g, "''") + "'";
  };
  return (process.platform === 'win32' && !/^[\w.@/:=+-]+$/.test(file) ? '& ' : '')
    + [file, ...args].map(quote).join(' ');
}

async function install(packages: string[], options: ManagementOpts, deps: ManagementDeps, report: Report, env: NodeJS.ProcessEnv) {
  if (!packages.length) return false;
  const args = ['install', '-g', ...packages, ...npmFlags(options)];
  const action: Action = { command: 'npm', args, status: 'skipped' };
  report.commands.push(action);
  if (options.dryRun) {
    if (options.installDeps !== false) action.status = 'planned';
    report.hints.push(shellCommand('npm', args));
    return false;
  }
  const approved = options.installDeps !== false && (
    options.yes || options.installDeps || (deps.interactive && await deps.ask('Install globally: ' + packages.join(', ') + '? [Y/n] ')));
  if (!approved) {
    report.hints.push(shellCommand('npm', args));
    return false;
  }
  const npm = npmExecutable(env);
  const result = npm ? await deps.exec(npm, args, { env, timeout: 180000, inherit: !options.json }) : undefined;
  action.status = result && result.code === 0 ? 'executed' : 'failed';
  if (action.status === 'failed') {
    report.ok = false;
    report.warnings.push(npm ? 'npm install failed (exit ' + result?.code + ').' : 'npm is not on PATH.');
    report.hints.push(shellCommand('npm', args));
  }
  return action.status === 'executed';
}

async function configure(options: ManagementOpts, deps: ManagementDeps, env: NodeJS.ProcessEnv, dryRun: boolean) {
  const task = options.syncSkill === false ? undefined : await findTask(options, deps.exec, env);
  const root = task ? await packageRoot(task.path, 'codex-task') : undefined;
  const skill = root ? join(root, 'skills', 'codex-task', 'SKILL.md') : undefined;
  return apply(planSetup({ ...options, geminiHome: geminiHome(options.geminiHome) }, skill), dryRun);
}

function combine(report: Report, config: ChangedFiles) {
  report.files.push(...config.files);
  report.warnings.push(...config.warnings);
  return report;
}

export async function setup(options: ManagementOpts, services = deps()): Promise<Report> {
  // Reject malformed marker pairs before any installation or user-config writes.
  planSetup({ ...options, geminiHome: geminiHome(options.geminiHome) });
  const { env } = await detectProxy(services.exec, services.env);
  const [codex, task] = await Promise.all([findCodex(options, services.exec, env), findTask(options, services.exec, env)]);
  const missing = [...(!codex.standalone?.version ? [packageNames.codex] : []), ...(!task?.version ? [packageNames['codex-task']] : [])];
  const report = reportFor(options);
  const installed = await install(missing, options, services, report, env);
  if (options.dryRun && options.syncSkill !== false && missing.includes('codex-task')) {
    report.observations.push('The codex-task skill can be synced after codex-task is installed.');
  }
  if (installed) report.observations.push('Open a new shell if the global npm bin directory is not on PATH.');
  return combine(report, await configure(options, services, env, Boolean(options.dryRun)));
}

export async function doctor(options: ManagementOpts & { offline?: boolean; codexHome?: string }, services = deps()) {
  const proxy = await detectProxy(services.exec, services.env);
  const info = await versions(options, Boolean(options.offline), services.exec, proxy.env);
  const { desktop, codex, sdk } = info;
  const notes: string[] = [];
  if (desktop.version && codex.version && compareVersions(desktop.version, codex.version) < 0) {
    notes.push('Codex Desktop lags behind the standalone CLI; update the Desktop app separately.');
  } else if (desktop.status === 'outdated') {
    notes.push('Codex Desktop’s bundled CLI is behind the standalone release on npm.');
  }
  if (sdk.status === 'outdated') {
    notes.push('The bundled SDK is behind npm independently of the codex-task CLI; update codex-task when it ships a newer SDK.');
  }
  return {
    ok: true,
    offline: Boolean(options.offline),
    platform: process.platform,
    components: { 'agy-c': info['agy-c'], codex, desktop, 'codex-task': info['codex-task'], sdk },
    selectedCodex: info.selectedCodex,
    auth: authStatus(resolve(options.codexHome ?? services.env.CODEX_HOME ?? join(homedir(), '.codex'))),
    rules: rulesStatus(geminiHome(options.geminiHome)),
    proxy: proxy.sources,
    notes,
  };
}

const keys = Object.keys(packageNames) as Component[];

export function parseOnly(only?: string): Component[] {
  if (only === undefined) return keys;
  const items = only.split(',').map((item) => item.trim());
  if (items.some((item) => !keys.includes(item as Component))) {
    throw new Error('--only expects a comma-separated subset of agy-c, codex, codex-task.');
  }
  return [...new Set(items)] as Component[];
}

export async function upgrade(options: UpgradeOpts, services = deps()): Promise<Report> {
  const components = parseOnly(options.only);
  if (options.rules !== false) planSetup({ ...options, geminiHome: geminiHome(options.geminiHome) });
  const { env } = await detectProxy(services.exec, services.env);
  const before = await versions(options, false, services.exec, env);
  const report = reportFor(options);
  const packages = components.filter((name) => {
    const item = before[name];
    if (item.registry === 'unpublished') {
      report.observations.push(packageNames[name] + ' is not published on the configured registry.');
      return false;
    }
    if (item.registry === 'unavailable') report.warnings.push('Could not check the latest version of ' + packageNames[name] + '.');
    return ['missing', 'unreadable', 'outdated'].includes(item.status);
  });
  const installed = await install(packages.map((name) => packageNames[name] + '@latest'), options, services, report, env);
  if (options.rules !== false) {
    let config: ChangedFiles | undefined;
    if (installed && packages.includes('agy-c')) {
      // The current process still has the old templates in memory, even after a self-upgrade.
      const npm = npmExecutable(env);
      const globalPrefix = options.prefix ? resolve(options.prefix)
        : npm ? await services.exec(npm, ['prefix', '-g'], { env }).then((value) => value.code === 0 ? value.stdout.trim() : '') : '';
      const updated = globalPrefix && prefixedBins('agy-c', globalPrefix).find(executable);
      if (updated) {
        const args = ['setup', '--no-install-deps', '--json',
          '--gemini-home', geminiHome(options.geminiHome), ...npmFlags(options),
          ...(options.syncGeminiCli ? ['--sync-gemini-cli'] : []),
          ...(options.syncSkill === false ? ['--no-sync-skill'] : [])];
        const result = await services.exec(updated, args, { env, timeout: 30000 });
        if (result.code === 0) {
          try {
            const value = JSON.parse(result.stdout) as Report;
            if (value.ok && Array.isArray(value.files) && Array.isArray(value.warnings)) config = value;
          } catch { /* The upgraded command did not return the expected report. */ }
        }
        report.commands.push({ command: updated, args, status: config ? 'executed' : 'failed' });
      }
      if (!config) {
        report.ok = false;
        report.warnings.push('Could not refresh with the newly installed agy-c. Run agy-c setup to sync its templates.');
      }
    } else {
      config = await configure(options, services, env, Boolean(options.dryRun));
    }
    if (config) combine(report, config);
  }
  if (options.restartService !== false && packages.includes('codex-task') && (installed || (options.dryRun && options.installDeps !== false))) {
    const action = await activeTaskService(services.exec, env);
    if (action) {
      const status = options.dryRun ? 'planned'
        : (await services.exec(action.command, action.args, { env, timeout: 30000 })).code === 0 ? 'executed' : 'failed';
      report.commands.push({ ...action, status });
      if (status === 'failed') {
        report.ok = false;
        report.warnings.push('Could not restart the active codex-task background service.');
      }
    }
  }
  const task = installed ? await findTask(options, services.exec, env) : undefined;
  const sdk = installed ? await sdkInfo(task) : before.sdk;
  if (before.desktop.version && before.desktop.latest && compareVersions(before.desktop.version, before.desktop.latest) < 0) {
    report.observations.push('Codex Desktop is behind the standalone npm release; update the Desktop app separately.');
  }
  if (sdk?.version && before.sdk.latest && compareVersions(sdk.version, before.sdk.latest) < 0) {
    report.observations.push('Bundled codex-task SDK ' + sdk.version + ' is behind npm ' + before.sdk.latest + '; not upgraded independently.');
  }
  return report;
}

export function uninstall(options: ManagementOpts): Report {
  return combine(reportFor(options), apply(planUninstall({ ...options, geminiHome: geminiHome(options.geminiHome) }), Boolean(options.dryRun)));
}
