import { stripVTControlCharacters } from 'node:util';
import type { doctor } from './management.js';

export function colorEnabled(isTTY = Boolean(process.stdout.isTTY), env = process.env): boolean {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return !['0', 'false'].includes(env.FORCE_COLOR);
  return isTTY;
}

const labels = {
  'agy-codex': 'agy-codex',
  codex: '@openai/codex (standalone)',
  desktop: 'Codex Desktop (bundled CLI)',
  'codex-task': 'codex-task',
  sdk: '@openai/codex-sdk (in codex-task)',
} as const;

const statusStyles = new Map([
  ['current', '1;32'], ['valid', '1;32'], ['managed', '1;32'],
  ['outdated', '1;33'], ['unmanaged', '1;33'],
  ['missing', '1;31'], ['expired', '1;31'], ['invalid', '1;31'], ['unreadable', '1;31'],
  ['offline', '2;36'], ['unpublished', '2;36'], ['unavailable', '2;36'],
]);

export function formatDoctor(report: Awaited<ReturnType<typeof doctor>>, color = false): string {
  const style = (value: string, code?: string) => color && code ? `\x1b[${code}m${value}\x1b[0m` : value;
  const dim = (value: string) => style(value, '2');
  const label = (value: string) => style(value, '1;36') + ' ';
  const status = (value: string) => style(value, statusStyles.get(value));
  const header = ['Component', 'Local', 'Latest', 'Status', 'Path'].map((value) => style(value, '1'));
  const rows = [
    header,
    ...(Object.keys(labels) as (keyof typeof labels)[]).map((key) => {
      const value = report.components[key];
      const registry = value.registry === 'ok' ? '' : '; npm ' + status(value.registry);
      return [labels[key], value.version ?? '—', value.latest ?? '—', status(value.status) + registry, dim(value.path ?? '—')];
    }),
  ];
  const visibleWidth = (value: string) => stripVTControlCharacters(value).length;
  const widths = header.map((_, index) => Math.max(...rows.map((row) => visibleWidth(row[index] ?? ''))));
  const table = rows.map((row) => row.map((value, index) => index === row.length - 1
    ? value : value + ' '.repeat((widths[index] ?? 0) - visibleWidth(value))).join('  '));

  const { selectedCodex, auth, rules, proxy, platform, notes } = report;
  return [
    ...table,
    label('Selected Codex:') + (selectedCodex ? dim(selectedCodex.path) + ' (' + selectedCodex.version + ')' : 'none'),
    label('Auth:') + status(auth.status) + (auth.expiresAt ? ' (access token expires ' + auth.expiresAt + ')' : '') + ' — ' + dim(auth.path),
    ...Object.values(rules).map((rule) => label('Rule:') + status(rule.status) + ' — ' + dim(rule.path)),
    label('Proxy:') + '(' + platform + ') HTTP=' + proxy.http + ' HTTPS=' + proxy.https + ' NO_PROXY=' + proxy.noProxy,
    ...notes.map((note) => style(note, '33')),
  ].join('\n');
}
