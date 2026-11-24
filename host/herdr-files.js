// The repo's herdr-app/ folder: our part of ~/.config/herdr-app (DESIGN.md「Herdr.app 里的界面」).
// Read as { "mods/my-tabs/main.js": text, … }. Files Herdr.app writes itself are not ours.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const APP_WRITES = new Set(['gpui-kit.d.ts', 'jsconfig.json', 'herdr.d.ts']);
const MOD_ENTRY_RE = /^mods\/[^/]+\/main\.js$/;
const MOD_HELPER_JS_RE = /^mods\/[^/]+\/.+\.js$/;
export const STALE_HERDR_FILES = Object.freeze([
  'mods/wayne-board',
  'data/my-files',
  'mods/my-files/state.js',
  'mods/my-files/preview.js',
  'mods/my-files/chevron-down.svg',
  'mods/my-files/chevron-right.svg',
  'mods/my-files/file.svg',
  'mods/my-files/folder.svg',
  'mods/my-pane/close.svg',
  'mods/my-pane/split-down.svg',
  'mods/my-pane/split-right.svg',
  'mods/my-pane/zoom.svg',
  'mods/my-pane/unzoom.svg',
  'mods/my-tabs/win-min.svg',
  'mods/my-tabs/win-max.svg',
  'mods/my-tabs/win-restore.svg',
  'mods/my-tabs/win-close.svg',
]);
const MOD_EXTERNALS = [
  'gpui-kit',
  'gpui-base',
  'herdr',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

function bundleModMain(filePath) {
  const { buildSync } = nodeRequire('esbuild');
  const res = buildSync({
    entryPoints: [filePath],
    bundle: true,
    format: 'esm',
    write: false,
    external: MOD_EXTERNALS,
    legalComments: 'none',
  });
  return res.outputFiles[0].text;
}

export function readHerdrFiles(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || APP_WRITES.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const rel = relative(root, p).replace(/\\/g, '/');
      if (MOD_ENTRY_RE.test(rel)) out[rel] = bundleModMain(p);
      else if (!MOD_HELPER_JS_RE.test(rel)) out[rel] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

function syncProgramsFile(appDir, rawOurs, onBadJson) {
  const p = join(appDir, 'programs.json');
  const current = existsSync(p) ? readFileSync(p, 'utf8') : null;
  const merged = mergePrograms(current, JSON.parse(rawOurs));
  if (merged !== null) { writeFileSync(p, merged); return; }
  if (current !== null) {
    try { JSON.parse(current); } catch { onBadJson(p); }
  }
}

export function syncHerdrDir(appDir, files, onBadJson = () => {}) {
  for (const [rel, text] of Object.entries(files)) {
    if (rel === 'programs.json') continue;
    const p = join(appDir, rel);
    if (existsSync(p) && readFileSync(p, 'utf8') === text) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  for (const rel of STALE_HERDR_FILES) rmSync(join(appDir, rel), { recursive: true, force: true });
  if (files['programs.json']) syncProgramsFile(appDir, files['programs.json'], onBadJson);
}

// Merge our programs.json entries into the user's: ours own their keys, the rest is untouched
// (DESIGN.md「图标跟着 Herdr.app」). Returns the new file text, or null when nothing should be
// written — no file handled by the caller, invalid JSON (never clobber), or no change.
export function mergePrograms(currentText, ours) {
  if (currentText == null) return `${JSON.stringify({ programs: ours.programs }, null, 2)}\n`;
  let current;
  try { current = JSON.parse(currentText); } catch { return null; }
  const merged = { ...current, programs: { ...current.programs, ...ours.programs } };
  if (JSON.stringify(merged) === JSON.stringify(current)) return null;
  return `${JSON.stringify(merged, null, 2)}\n`;
}
