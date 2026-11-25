import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, win32 } from 'node:path';

export interface Invocation {
  file: string;
  args: string[];
}

export function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findOnPath(name: string, env = process.env): string[] {
  const windows = process.platform === 'win32';
  const suffixes = windows && !extname(name) ? ['.exe', '.cmd', '.bat'] : [''];
  const paths = Object.entries(env).find(([key]) => windows ? key.toUpperCase() === 'PATH' : key === 'PATH')?.[1];
  const found = new Map<string, string>();
  for (const dir of (paths ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = resolve(dir.replace(/^"|"$/g, ''), name + suffix);
      if (executable(candidate)) try {
        const identity = realpathSync(candidate);
        const key = windows ? identity.toLowerCase() : identity;
        if (!found.has(key)) found.set(key, candidate);
      } catch { /* It may have been removed while scanning PATH. */ }
    }
  }
  return [...found.values()];
}

/** Resolve npm's standard cmd-shim format. Never feed user arguments through cmd.exe. */
export function npmShimTarget(source: string, localBin = false): string | undefined {
  // npm.cmd shipped with node.exe uses a variable rather than a generated cmd-shim.
  if (/^\s*SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli\.js"\s*$/mi.test(source)
    && /^"%NODE_EXE%" "%NPM_CLI_JS%" %\*\s*$/mi.test(source)) {
    return 'node_modules\\npm\\bin\\npm-cli.js';
  }
  const targets = [...source.matchAll(/"%(?:dp0%|~dp0)\\((?:node_modules|\.\.)\\[^"\r\n]+)"[ \t]+%\*[ \t]*\r?$/gmi)];
  const target = targets.at(-1)?.[1];
  if (!target) return undefined;
  const [root, ...segments] = target.split('\\');
  if ((root === '..' && !localBin) || segments.some((part) => !part || part === '..' || part === '.')
    || /[:%<>|/]/.test(target) || !/\.(?:c?js|mjs|exe)$/i.test(target)) return undefined;
  return win32.normalize(target);
}

export function invocation(path: string, args: string[]): Invocation {
  const ext = extname(path).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(ext)) return { file: process.execPath, args: [path, ...args] };
  if (process.platform === 'win32' && ['.cmd', '.bat'].includes(ext)) {
    const dir = dirname(path);
    const localBin = basename(dir).toLowerCase() === '.bin' && basename(dirname(dir)).toLowerCase() === 'node_modules';
    const target = npmShimTarget(readFileSync(path, 'utf8'), localBin);
    if (!target) throw new Error('Unsupported Windows batch shim: ' + path + '. Pass its .exe or Node.js entry point.');
    const entry = join(dir, target);
    if (!executable(entry)) throw new Error('Missing entry point for Windows shim: ' + path);
    return invocation(entry, args);
  }
  return { file: path, args };
}

export function launch(path: string, args: string[], opts: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  const command = invocation(path, args);
  return spawn(command.file, command.args, { ...opts, shell: false, stdio: 'pipe', windowsHide: true });
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Command = (path: string, args: string[], options?: {
  env?: NodeJS.ProcessEnv; timeout?: number; inherit?: boolean;
}) => Promise<CommandResult>;

export const command: Command = async (path, args, options = {}) => {
  try {
    const spec = invocation(path, args);
    return await new Promise<CommandResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(spec.file, spec.args, {
        env: options.env, stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        shell: false, windowsHide: true,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeout ?? 7000);
      timer.unref();
      child.stdout?.setEncoding('utf8').on('data', (part: string) => {
        if (stdout.length < 1024 * 1024) stdout += part;
      });
      child.stderr?.setEncoding('utf8').on('data', (part: string) => {
        if (stderr.length < 128 * 1024) stderr += part;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr });
      });
    });
  } catch (error) {
    return { code: 1, stdout: '', stderr: String(error) };
  }
};

export function npmExecutable(env = process.env): string | undefined {
  // npm_execpath is set when launched through npm. Prefer its directly invocable JS entry.
  const entry = env.npm_execpath;
  if (entry && isAbsolute(entry) && basename(entry) === 'npm-cli.js' && executable(entry)) return entry;
  return findOnPath('npm', env)[0];
}

export async function packageRoot(bin: string, name: string): Promise<string | undefined> {
  try {
    const actual = realpathSync(bin);
    const spec = invocation(actual, []);
    const entry = spec.file === process.execPath ? spec.args[0] ?? actual : actual;
    for (let dir = dirname(entry); ; dir = dirname(dir)) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
        if (manifest.name === name) return dir;
      } catch { /* Keep searching ancestors. */ }
      if (dirname(dir) === dir) return undefined;
    }
  } catch {
    return undefined;
  }
}
