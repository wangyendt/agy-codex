const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const numeric = /^\d+$/;

function parse(version: string) {
  const match = semver.exec(version.replace(/^v/, ''));
  if (!match) return undefined;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some((id) => /^0\d+$/.test(id))) return undefined;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

export function readVersion(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const candidate = line.trim().split(/\s+/).at(-1);
    if (candidate && parse(candidate)) return candidate.replace(/^v/, '');
  }
  return undefined;
}

export function compareVersions(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error('Invalid semantic version');
  for (const [index, value] of a.core.entries()) {
    const other = b.core[index]!;
    if (value !== other) return value < other ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (const [index, value] of a.pre.entries()) {
    const other = b.pre[index];
    if (other === undefined) return 1;
    if (value === other) continue;
    if (numeric.test(value) && numeric.test(other)) return BigInt(value) < BigInt(other) ? -1 : 1;
    if (numeric.test(value) !== numeric.test(other)) return numeric.test(value) ? -1 : 1;
    return value < other ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

export function newest<T extends { version: string | null }>(candidates: T[]): T | undefined {
  return candidates.reduce<T | undefined>((best, next) => {
    if (!next.version) return best;
    if (!best?.version || compareVersions(next.version, best.version) > 0) return next;
    return best;
  }, undefined);
}
