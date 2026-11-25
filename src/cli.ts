#!/usr/bin/env node
import { Command, Option } from 'commander';
import { doctor, setup, shellCommand, uninstall, upgrade } from './management.js';
import type { ManagementOpts } from './management.js';
import { colorEnabled, formatDoctor } from './output.js';
import { manifest } from './package.js';
import { defaultThreadSource, run, sandboxes } from './run.js';
import type { RunOpts } from './run.js';

const cli = new Command()
  .name('agy-codex')
  .description('Connect Antigravity to Codex for repeatable engineering handoffs.')
  .version(manifest.version)
  .showHelpAfterError();

const json = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const line = (value: string) => process.stdout.write(value + '\n');

function files(command: Command) {
  return command
    .option('--gemini-home <path>', 'Gemini home (default: GEMINI_HOME or ~/.gemini)')
    .option('--sync-gemini-cli', 'also manage the block in GEMINI.md')
    .option('--dry-run', 'preview file and command changes')
    .option('--json', 'write a structured summary to stdout');
}

function packages(command: Command) {
  return command
    .option('-y, --yes', 'install missing npm packages without prompting')
    .option('--no-install-deps', 'never install dependencies')
    .option('--prefix <path>', 'global npm prefix')
    .option('--registry <url>', 'npm registry URL')
    .option('--no-sync-skill', 'leave the codex-task skill untouched');
}

function showManagement(report: ReturnType<typeof uninstall>, options: ManagementOpts) {
  if (options.json) json(report);
  else {
    for (const file of report.files) line((report.dryRun ? 'Would ' : '') + file.action + ' ' + file.path + (file.migrated ? ' (legacy migration)' : ''));
    if (!report.files.length) line('No managed files changed.');
    for (const action of report.commands) {
      line(action.status + ': ' + shellCommand(action.command, action.args));
    }
    for (const warning of report.warnings) process.stderr.write('Warning: ' + warning + '\n');
    for (const observation of report.observations) line(observation);
    for (const hint of report.hints) line('Run manually: ' + hint);
  }
  if (!report.ok) process.exitCode = 1;
}

async function manage(options: ManagementOpts, action: () => ReturnType<typeof uninstall> | Promise<ReturnType<typeof uninstall>>) {
  try {
    showManagement(await action(), options);
  } catch (error) {
    if (!options.json) throw error;
    showManagement({
      ok: false, dryRun: Boolean(options.dryRun), files: [], commands: [], hints: [],
      observations: [], warnings: [error instanceof Error ? error.message : String(error)],
    }, options);
  }
}

let neverInstall = false;
packages(files(cli.command('setup').description('Install or refresh the Antigravity managed rules')))
  .option('--install-deps', 'install missing npm packages without prompting')
  .on('option:no-install-deps', () => { neverInstall = true; })
  .action((options: ManagementOpts) => manage(options, () => setup(neverInstall ? { ...options, installDeps: false } : options)));

cli.command('doctor').description('Check tool versions, auth expiry, rules, and proxy configuration')
  .option('--offline', 'skip npm registry queries')
  .option('--json', 'write a structured report to stdout')
  .option('--gemini-home <path>', 'Gemini home (default: GEMINI_HOME or ~/.gemini)')
  .option('--codex-home <path>', 'Codex home (default: CODEX_HOME or ~/.codex)')
  .action(async (options) => {
    const report = await doctor(options);
    if (options.json) { json(report); return; }
    line(formatDoctor(report, colorEnabled()));
  });

packages(files(cli.command('upgrade').description('Check npm versions, upgrade tools, and refresh rules')))
  .option('--only <list>', 'comma-separated list: agy-codex, codex, codex-task')
  .option('--no-rules', 'skip refreshing rules and skills')
  .option('--no-restart-service', 'leave any active codex-task service running')
  .action((options) => manage(options, () => upgrade(options)));

files(cli.command('uninstall').description('Remove agy-codex managed rule blocks without deleting personal content'))
  .action((options: ManagementOpts) => manage(options, () => uninstall(options)));

cli.command('run').description('Run Codex non-interactively and capture the final result')
  .argument('[prompt]', 'task prompt; can be combined with --brief and stdin')
  .option('-C, --cwd <dir>', 'workspace directory')
  .option('-f, --brief <file>', 'UTF-8 handoff brief')
  .option('--resume <threadId>', 'resume a specific thread')
  .option('--fork <threadId>', 'fork a specific thread')
  .option('--review', 'run codex exec review instead of a new or saved thread')
  .option('--uncommitted', 'review working tree changes')
  .option('--base <branch>', 'review changes versus a base branch')
  .option('--commit <sha>', 'review changes in a commit')
  .option('--thread-state <file>', 'JSON workspace-to-thread-ID mapping')
  .option('--new', 'ignore any previously saved thread ID')
  .addOption(new Option('-s, --sandbox <mode>', 'Codex sandbox policy').choices(sandboxes).default('workspace-write'))
  .option('--dangerously-bypass-approvals-and-sandbox', 'explicitly disable sandboxing and approvals for this run')
  .option('--skip-git-repo-check', 'allow a non-Git workspace (automatically enabled outside Git)')
  .option('-m, --model <model>', 'Codex model override')
  .option('--reasoning <effort>', 'Codex model reasoning effort')
  .option('--thread-source <source>', 'Codex thread source classification', defaultThreadSource)
  .option('-i, --image <path>', 'attach an image (repeatable)', (value: string, existing: string[]) => [...existing, value], [])
  .option('-o, --output <file>', 'write the final agent message to a UTF-8 file')
  .option('--events-log <file>', 'save raw Codex JSONL events')
  .option('--codex-bin <path>', 'override the newest automatically selected Codex binary')
  .option('--json', 'write only a compact JSON summary to stdout')
  .action(async (prompt: string | undefined, options: RunOpts) => {
    const result = await run(options, prompt);
    if (options.json) json(result);
    else if (result.text) line(result.text);
    if (!result.ok) process.exitCode = result.exitCode;
  });

try {
  await cli.parseAsync(process.argv);
} catch (error) {
  process.stderr.write('agy-codex: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
