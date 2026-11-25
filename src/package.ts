import { readFileSync } from 'node:fs';

export const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string; version: string;
};
