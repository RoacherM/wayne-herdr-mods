// Bundling herdr-app/mods/*/main.js into self-contained ESM for ~/.config/herdr-app and cleaning stale paths.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as herdrMod from '../host/herdr-files.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const herdrRoot = join(repoRoot, 'herdr-app');

test('readHerdrFiles bundles relay-only wayne-phones mod and omits retired UI mods/layouts', () => {
  const files = herdrMod.readHerdrFiles(herdrRoot);
  for (const retired of [
    'mods/wayne-board/main.js',
    'mods/my-files/main.js',
    'mods/my-pane/main.js',
    'mods/my-tabs/main.js',
    'layouts/main-preview.json',
    'layouts/main-preview.svg',
  ]) {
    assert.equal(retired in files, false, `retired file absent: ${retired}`);
  }

  const phonesJs = files['mods/wayne-phones/main.js'];
  assert.equal(typeof phonesJs, 'string');
  assert.match(phonesJs, /from\s+["']gpui-kit["']/);
  assert.match(phonesJs, /from\s+["']gpui-base["']/);
  assert.match(phonesJs, /from\s+["']herdr["']/);
  assert.match(phonesJs, /from\s+["'](?:node:)?fs\/promises["']/, 'keeps Node built-ins external');

  const manifest = JSON.parse(files['mods/wayne-phones/mod.json']);
  assert.equal(manifest.place, 'none');
  assert.ok(Array.isArray(manifest.palette) && manifest.palette.length > 0, 'registered in command palette');
  assert.equal(manifest.palette[0].command, 'mod.open');
  assert.deepEqual(manifest.palette[0].args, { name: 'wayne-phones' });
});

test('syncHerdrDir installs relay-only mods and cleans retired UI mods/layouts idempotently', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'herdr-bundle-'));
  try {
    const appDir = join(tmp, 'installed-herdr-app');
    const stalePaths = [
      join(appDir, 'mods', 'wayne-board', 'main.js'),
      join(appDir, 'mods', 'my-files', 'main.js'),
      join(appDir, 'mods', 'my-pane', 'main.js'),
      join(appDir, 'mods', 'my-tabs', 'main.js'),
      join(appDir, 'data', 'my-files', 'cache.json'),
      join(appDir, 'layouts', 'main-preview.json'),
      join(appDir, 'layouts', 'main-preview.svg'),
    ];
    for (const p of stalePaths) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'stale');
    }

    const files = herdrMod.readHerdrFiles(herdrRoot);
    herdrMod.syncHerdrDir(appDir, files);
    herdrMod.syncHerdrDir(appDir, files); // idempotent when unchanged

    for (const p of [
      join(appDir, 'mods', 'wayne-board'),
      join(appDir, 'mods', 'my-files'),
      join(appDir, 'mods', 'my-pane'),
      join(appDir, 'mods', 'my-tabs'),
      join(appDir, 'data', 'my-files'),
      join(appDir, 'layouts', 'main-preview.json'),
      join(appDir, 'layouts', 'main-preview.svg'),
    ]) {
      assert.equal(existsSync(p), false, `retired path removed: ${p}`);
    }
    assert.equal(existsSync(join(appDir, 'mods', 'wayne-phones', 'main.js')), true);
    assert.equal(existsSync(join(appDir, 'mods', 'wayne-phones', 'mod.json')), true);
    assert.equal(existsSync(join(appDir, 'programs.json')), true);
    const progs = JSON.parse(readFileSync(join(appDir, 'programs.json'), 'utf8'));
    assert.ok(progs.programs.droid, 'programs.json merged');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
