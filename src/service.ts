import { userInfo } from 'node:os';
import { powerShell } from './environment.js';
import type { Command } from './process.js';
import { findOnPath } from './process.js';

export interface ServiceAction {
  command: string;
  args: string[];
}

export async function activeTaskService(exec: Command, env: NodeJS.ProcessEnv): Promise<ServiceAction | undefined> {
  const current = process.platform;
  if (current === 'darwin') {
    const launchctl = '/bin/launchctl';
    const label = 'gui/' + userInfo().uid + '/com.wangyendt.codex-task';
    const result = await exec(launchctl, ['print', label], { env });
    if (result.code === 0 && /^\s*state\s*=\s*running\s*$/m.test(result.stdout)) {
      return { command: launchctl, args: ['kickstart', '-k', label] };
    }
  } else if (current === 'linux') {
    const systemctl = findOnPath('systemctl', env)[0];
    if (!systemctl) return undefined;
    const result = await exec(systemctl, ['--user', 'is-active', '--quiet', 'codex-task.service'], { env });
    if (result.code === 0) return { command: systemctl, args: ['--user', 'restart', 'codex-task.service'] };
  } else if (current === 'win32') {
    const shell = powerShell(env);
    const fixed = ['-NoProfile', '-NonInteractive', '-Command'];
    const task = "Get-ScheduledTask -TaskName 'codex-task' -TaskPath '\\' -ErrorAction Stop";
    const result = await exec(shell, [...fixed, '(' + task + ').State'], { env });
    if (result.code === 0 && result.stdout.trim() === 'Running') {
      return { command: shell, args: [...fixed,
        "$t = " + task + "; Stop-ScheduledTask -InputObject $t -ErrorAction Stop; Start-ScheduledTask -InputObject $t -ErrorAction Stop"] };
    }
  }
  return undefined;
}
