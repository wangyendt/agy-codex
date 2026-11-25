import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { detectProxy, findCodex, probe } from './environment.js';
import { managedFile, readOptional, writeAtomic } from './fs.js';
import { launch } from './process.js';

export const sandboxes = ['read-only', 'workspace-write', 'danger-full-access'] as const;
type Sandbox = (typeof sandboxes)[number];

export interface RunOpts {
  cwd?: string;
  brief?: string;
  resume?: string;
  fork?: string;
  review?: boolean;
  uncommitted?: boolean;
  base?: string;
  commit?: string;
  threadState?: string;
  new?: boolean;
  sandbox: Sandbox;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  skipGitRepoCheck?: boolean;
  model?: string;
  reasoning?: string;
  threadSource?: string;
  image?: string[];
  output?: string;
  eventsLog?: string;
  codexBin?: string;
  json?: boolean;
}

export interface RunReport {
  ok: boolean;
  status: 'completed' | 'failed';
  threadId: string | null;
  resumed: boolean;
  codexBin: string | null;
  codexVersion: string | null;
  exitCode: number;
  outputPath: string | null;
  text: string;
}

const abs = (path?: string) => path === undefined ? undefined : resolve(path);
type State = Record<string, string>;

function loadState(file: string) {
  const current = managedFile(file);
  if (!current) return { data: {} as State, mode: 0o600 };
  try {
    const value: unknown = JSON.parse(current.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some((item) => typeof item !== 'string' || !item.trim())) throw new Error('Invalid map');
    return { data: value as State, mode: current.mode };
  } catch {
    throw new Error('Invalid thread-state file (expected a JSON object mapping workspace paths to thread IDs): ' + file);
  }
}

export function isGitWorkspace(workspace: string): boolean {
  for (let dir = workspace; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

function pathIdentity(path: string): string {
  let identity;
  try { identity = realpathSync(path); } catch {
    try { identity = resolve(realpathSync(dirname(path)), basename(path)); }
    catch { identity = path; }
  }
  return ['win32', 'darwin'].includes(process.platform) ? identity.toLowerCase() : identity;
}

function checkDistinct(outputs: Array<string | undefined>, inputs: Array<string | undefined>) {
  const used = new Set(outputs.filter((path): path is string => path !== undefined).map(pathIdentity));
  if (used.size !== outputs.filter((path) => path !== undefined).length || inputs.some((path) => path && used.has(pathIdentity(path)))) {
    throw new Error('Thread state, final output, and events log must not overlap each other or an input file.');
  }
  for (const path of outputs) if (path) managedFile(path);
}

async function stdinText(): Promise<string> {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

type RunMode = 'new' | 'resume' | 'fork' | 'review';

export function codexArgs(options: RunOpts, cwd: string, mode: RunMode, thread: string | undefined, hasPrompt: boolean): string[] {
  // Sandbox and --cd are parent-only options for the exec subcommands.
  const args = ['exec', '-C', cwd];
  if (!options.dangerouslyBypassApprovalsAndSandbox) args.push('-s', options.sandbox);
  if (mode !== 'new') args.push(mode);
  args.push('--json');
  if (options.dangerouslyBypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (options.skipGitRepoCheck || !isGitWorkspace(cwd)) args.push('--skip-git-repo-check');
  if (options.model) args.push('--model=' + options.model);
  if (options.reasoning) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(options.reasoning));
  if (options.threadSource) args.push('--thread-source=' + options.threadSource);
  for (const image of options.image ?? []) args.push('--image=' + resolve(image));
  if (options.uncommitted) args.push('--uncommitted');
  if (options.base) args.push('--base=' + options.base);
  if (options.commit) args.push('--commit=' + options.commit);
  if (thread) args.push('--', thread);
  if (hasPrompt) args.push('-');
  return args;
}

interface Events {
  threadId: string | null;
  text: string;
  failed: boolean;
}

export function acceptEvent(line: string, events: Events): void {
  let data: unknown;
  try { data = JSON.parse(line); } catch { return; }
  if (!data || typeof data !== 'object' || !('type' in data)) return;
  if (data.type === 'thread.started' && 'thread_id' in data && typeof data.thread_id === 'string' && data.thread_id.trim()) {
    events.threadId = data.thread_id;
  } else if (data.type === 'item.completed' && 'item' in data && data.item && typeof data.item === 'object'
    && 'type' in data.item && data.item.type === 'agent_message' && 'text' in data.item && typeof data.item.text === 'string') {
    events.text = data.item.text;
  } else if (data.type === 'turn.failed') {
    events.failed = true;
  }
}

async function execute(bin: string, args: string[], cwd: string, prompt: string, env: NodeJS.ProcessEnv, events: Events, eventsLog?: string) {
  if (eventsLog) await mkdir(dirname(eventsLog), { recursive: true });
  const log = eventsLog ? await open(eventsLog, 'w', 0o600) : undefined;
  try {
    const child = launch(bin, args, { cwd, env });
    let startError: Error | undefined;
    const finished = new Promise<number>((resolve) => {
      child.on('error', (error) => { startError = error; });
      child.on('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
    child.stderr.pipe(process.stderr, { end: false });
    child.stdin.on('error', () => { /* An early Codex exit is reported by the process status. */ });
    child.stdin.end(prompt);
    const decoder = new StringDecoder('utf8');
    let tail = '';
    try {
      for await (const chunk of child.stdout) {
        if (log) await log.writeFile(chunk as Buffer);
        const lines = (tail + decoder.write(chunk as Buffer)).split('\n');
        tail = lines.pop() ?? '';
        for (const line of lines) acceptEvent(line, events);
      }
      acceptEvent(tail + decoder.end(), events);
    } catch (error) {
      child.kill();
      await finished;
      throw error;
    }
    const code = await finished;
    if (startError) throw startError;
    return code === 0 && events.failed ? 1 : code;
  } finally {
    await log?.close();
  }
}

export async function run(options: RunOpts, positional?: string): Promise<RunReport> {
  const report: RunReport = {
    ok: false, status: 'failed', threadId: null, resumed: false, codexBin: null,
    codexVersion: null, exitCode: 1, outputPath: null, text: '',
  };
  try {
    const cwd = realpathSync(resolve(options.cwd ?? process.cwd()));
    if (!statSync(cwd).isDirectory()) throw new Error('--cwd is not a directory: ' + cwd);
    const output = abs(options.output);
    const stateFile = abs(options.threadState);
    const eventsLog = abs(options.eventsLog);
    const briefFile = abs(options.brief);
    const reviewTargets = [options.uncommitted, options.base !== undefined, options.commit !== undefined].filter(Boolean).length;
    if ((!options.review && reviewTargets) || reviewTargets > 1) throw new Error('Choose at most one of --uncommitted, --base or --commit with --review.');
    if ([options.review, options.fork !== undefined, options.resume !== undefined].filter(Boolean).length > 1
      || (options.new && (options.resume || options.fork))) throw new Error('--review, --resume and --fork are mutually exclusive; --new is for a fresh run.');
    if (options.resume?.trim() === '' || options.fork?.trim() === '') throw new Error('Thread ID must not be empty.');
    if (options.review && options.image?.length) throw new Error('Codex review does not accept image attachments.');
    const override = abs(options.codexBin);
    checkDistinct([output, stateFile, eventsLog], [briefFile, override, ...(options.image ?? []).map((path) => resolve(path))]);
    const state = stateFile && !options.review ? loadState(stateFile).data : undefined;
    const saved = state && Object.hasOwn(state, cwd) ? state[cwd] : undefined;
    const thread = options.fork ?? options.resume ?? (options.new || options.review ? undefined : saved);
    const mode = options.review ? 'review' : options.fork ? 'fork' : thread ? 'resume' : 'new';
    const brief = briefFile ? readOptional(briefFile) : undefined;
    if (briefFile && brief === undefined) throw new Error('Brief not found: ' + briefFile);
    const piped = await stdinText();
    const prompt = [brief, positional, piped].filter((part) => part?.trim()).join('\n\n');
    if (!prompt && (mode === 'new' || mode === 'resume')) throw new Error('Supply a prompt, --brief file, or piped stdin.');
    if (prompt && reviewTargets) throw new Error('Codex review accepts a review target or a custom prompt, not both.');
    const { env } = await detectProxy();
    const bin = override ? await probe(override, undefined, env) : (await findCodex({}, undefined, env)).selected;
    if (!bin) throw new Error('No usable Codex binary found. Run agy-c doctor or agy-c setup.');
    report.codexBin = bin.path;
    report.codexVersion = bin.version;
    if (!bin.version) throw new Error('Could not read the version of ' + bin.path);
    checkDistinct([output, stateFile, eventsLog], [bin.path]);
    report.resumed = mode === 'resume';
    report.outputPath = output ?? null;
    const events: Events = { threadId: mode === 'resume' ? thread ?? null : null, text: '', failed: false };
    report.exitCode = await execute(bin.path, codexArgs(options, cwd, mode, thread, Boolean(prompt)), cwd, prompt, env, events, eventsLog);
    report.threadId = events.threadId;
    report.text = events.text;
    if (output && (events.text || report.exitCode === 0)) writeAtomic(output, events.text, managedFile(output)?.mode);
    if (stateFile && !options.review && report.exitCode === 0 && events.threadId) {
      const latest = loadState(stateFile);
      writeAtomic(stateFile, JSON.stringify({ ...latest.data, [cwd]: events.threadId }, null, 2) + '\n', latest.mode);
    }
    report.ok = report.exitCode === 0;
    report.status = report.ok ? 'completed' : 'failed';
  } catch (error) {
    report.exitCode ||= 1;
    process.stderr.write('agy-c: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  }
  return report;
}
