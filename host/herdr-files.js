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

// Merge our programs.json entries into the user's: ours own their keys, the rest is untouched
// (DESIGN.md「图标跟着 Herdr.app」). Returns the new file text, or null when nothing should be
// written — no file handled by the caller, invalid JSON (never clobber), or no change.
export function mergePrograms(currentText, ours) {
  if (currentText == null) return `${JSON.stringify({ programs: ours.programs }, null, 2)}\n`;
  let current;
  try { current = JSON.parse(currentText); } catch { return null; }
  const merged = { ...current, programs: { ...(current.programs ?? {}), ...ours.programs } };
  if (JSON.stringify(merged) === JSON.stringify(current)) return null;
  return `${JSON.stringify(merged, null, 2)}\n`;
}
