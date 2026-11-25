import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { managedFile, readOptional, writeAtomic } from './fs.js';
import { agents, protocol, protocolHeader } from './templates.js';

export const start = '<!-- agy-codex:start -->';
export const end = '<!-- agy-codex:end -->';

export interface RuleOptions {
  geminiHome: string;
  syncGeminiCli?: boolean;
  syncSkill?: boolean;
}
interface Span { from: number; to: number }
interface Change { path: string; action: 'write' | 'remove'; text?: string; mode?: number; migrated?: boolean }
interface RulePlan { changes: Change[]; warnings: string[] }

export function block(text: string): (Span & { legacyMarkers: boolean }) | undefined {
  // Recognize the previous package's markers so setup replaces the block in place.
  const markers = [...text.matchAll(/^[ \t]*<!--[ \t]*(agy-codex|agy-c):(start|end)[ \t]*-->[ \t]*(?:\r?\n|$)/gm)];
  if (!markers.length) return undefined;
  const [first, last] = markers;
  if (markers.length !== 2 || first?.[2] !== 'start' || last?.[2] !== 'end' || first[1] !== last[1]) {
    throw new Error('Invalid agy-codex markers (expected one ordered pair).');
  }
  return { from: first.index, to: last.index + last[0].length, legacyMarkers: first[1] === 'agy-c' };
}

const normalize = (value: string) => value.replace(/\r\n/g, '\n');
const digest = (value: string) => createHash('sha256').update(normalize(value).trimEnd()).digest('hex');
const headerPattern = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/m;

// Match only byte-equivalent legacy sections (ignoring line endings/trailing whitespace).
// This is intentionally not a broad heading-based deletion; a customized rule stays user-owned.
export const legacy = {
  agents: { heading: '# Global Model Routing & Codex Delegation Policy', lines: 35, digest: '30521a78f04ae93aeb11dcb379df0eefce521ec994f1e1b4e98d1b346ec590a9' },
  protocol: { heading: '# Codex Delegation Protocol', lines: 149, digest: 'bcf17ef8a0009ffb25ff9701b373d217ef3fb3b0c2d1dc34ce7e021ec4a0964c' },
  header: '73f576a97eb188490383a36470c5c142f307fa150af1d2a0b7d47af4dba9b849',
} as const;

export function legacySpan(text: string, signature: { heading: string; lines: number; digest: string }): Span | undefined {
  const lines = [...text.matchAll(/^[^\r\n]*(?:\r?\n|(?![\s\S]))/gm)];
  const candidates: Span[] = [];
  for (const [index, line] of lines.entries()) {
    if (line[0].trimEnd() !== signature.heading) continue;
    const last = lines[index + signature.lines - 1];
    if (!last) continue;
    const to = last.index + last[0].length;
    if (digest(text.slice(line.index, to)) === signature.digest) candidates.push({ from: line.index, to });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function stripBlock(text: string, span: Span) {
  return text.slice(0, span.from) + text.slice(span.to);
}

function wrap(text: string, body: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return [start, body.replace(/\n/g, eol), end, ''].join(eol);
}

function ruleFile(path: string, body: string, asProtocol: boolean, plan: RulePlan) {
  let file;
  let range;
  try {
    file = managedFile(path);
    range = block(file?.text ?? '');
  } catch (error) {
    throw new Error(path + ': ' + (error as Error).message);
  }
  const text = file?.text ?? '';
  const rendered = wrap(text, body);
  let next: string;
  let migrated = false;
  if (range) {
    const header = headerPattern.exec(text);
    if (asProtocol && (!header || header.index !== 0 || header[0].length > range.from)) {
      throw new Error(path + ': expected YAML frontmatter before the agy-codex block.');
    }
    next = text.slice(0, range.from) + rendered + text.slice(range.to);
    migrated = range.legacyMarkers;
  } else {
    const legacyRange = legacySpan(text, asProtocol ? legacy.protocol : legacy.agents);
    if (legacyRange && (!asProtocol || digest(text.slice(0, legacyRange.from)) === legacy.header)) {
      const before = asProtocol ? protocolHeader.replace(/\n/g, text.includes('\r\n') ? '\r\n' : '\n')
        + (text.includes('\r\n') ? '\r\n\r\n' : '\n\n') : text.slice(0, legacyRange.from);
      next = before + rendered + text.slice(legacyRange.to);
      migrated = true;
    } else if (asProtocol && text.trim()) {
      plan.warnings.push('Kept unmarked rule: ' + path + '. Back it up and move it aside to install the managed version.');
      return;
    } else if (!asProtocol && text.split(/\r?\n/).some((line) => line.trim() === legacy.agents.heading)) {
      plan.warnings.push('Kept customized legacy policy: ' + path + '. Move its routing section aside before setup to avoid duplicates.');
      return;
    } else if (asProtocol) {
      next = protocolHeader + '\n\n' + rendered;
    } else {
      next = text + (text && !text.endsWith('\n') ? (text.includes('\r\n') ? '\r\n' : '\n') : '') + rendered;
    }
  }
  if (text !== next) plan.changes.push({ path, action: 'write', text: next, mode: file?.mode ?? 0o600, migrated });
}

export function paths(home: string) {
  return {
    agents: join(home, 'config', 'AGENTS.md'),
    protocol: join(home, 'config', 'rules', 'codex-delegation-protocol.md'),
    gemini: join(home, 'GEMINI.md'),
    skill: join(home, 'config', 'skills', 'codex-task', 'SKILL.md'),
  };
}

export function planSetup(options: RuleOptions, skillPath?: string): RulePlan {
  const files = paths(options.geminiHome);
  const plan: RulePlan = { changes: [], warnings: [] };
  ruleFile(files.agents, agents, false, plan);
  ruleFile(files.protocol, protocol, true, plan);
  if (options.syncGeminiCli) ruleFile(files.gemini, agents, false, plan);
  if (options.syncSkill !== false && skillPath) {
    const incoming = readOptional(skillPath);
    if (incoming !== undefined) {
      const file = managedFile(files.skill);
      if (normalize(file?.text ?? '') !== normalize(incoming)) {
        plan.changes.push({ path: files.skill, action: 'write', text: incoming, mode: file?.mode ?? 0o600 });
      }
    }
  }
  return plan;
}

export function planUninstall(options: RuleOptions): RulePlan {
  const plan: RulePlan = { changes: [], warnings: [] };
  const files = paths(options.geminiHome);
  for (const path of [files.agents, files.protocol, ...(options.syncGeminiCli ? [files.gemini] : [])]) {
    try {
      const file = managedFile(path);
      if (!file) continue;
      const range = block(file.text);
      if (!range) continue;
      const text = stripBlock(file.text, range);
      if (path === files.protocol && normalize(text).trim() === protocolHeader) {
        plan.changes.push({ path, action: 'remove' });
      } else {
        plan.changes.push({ path, action: 'write', text, mode: file.mode });
      }
    } catch (error) {
      throw new Error(path + ': ' + (error as Error).message);
    }
  }
  return plan;
}

export function apply(plan: RulePlan, dryRun: boolean) {
  if (!dryRun) {
    for (const change of plan.changes) {
      if (change.action === 'remove') rmSync(change.path);
      else writeAtomic(change.path, change.text!, change.mode);
    }
  }
  return {
    files: plan.changes.map(({ path, action, migrated }) => ({ path, action, ...(migrated && { migrated }) })),
    warnings: plan.warnings,
  };
}

export function rulesStatus(home: string) {
  const result = (path: string) => {
    try {
      const file = managedFile(path);
      return { path, status: !file ? 'missing' : block(file.text) ? 'managed' : 'unmanaged' };
    } catch {
      return { path, status: 'invalid' };
    }
  };
  const files = paths(home);
  return { agents: result(files.agents), protocol: result(files.protocol) };
}
