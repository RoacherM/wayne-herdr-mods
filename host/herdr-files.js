// The repo's herdr-app/ folder: our part of ~/.config/herdr-app (DESIGN.md「Herdr.app 里的界面」).
// Read as { "mods/my-tabs/main.js": text, … }. Files Herdr.app writes itself are not ours.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP_WRITES = new Set(['gpui-kit.d.ts', 'jsconfig.json', 'herdr.d.ts']);

export function readHerdrFiles(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || APP_WRITES.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}
