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

test('readHerdrFiles bundles every mod main.js into self-contained ESM and omits helper modules', () => {
  const files = herdrMod.readHerdrFiles(herdrRoot);
  assert.equal('mods/wayne-board/main.js' in files, false, 'retired wayne-board is absent');
  assert.equal('mods/my-files/state.js' in files, false, 'inlined helper state.js is omitted');
  assert.equal('mods/my-files/preview.js' in files, false, 'inlined helper preview.js is omitted');

  const filesJs = files['mods/my-files/main.js'];
  assert.equal(typeof filesJs, 'string');
  assert.equal(/^\s*import\b.*\.\/state\.js/m.test(filesJs), false, 'no unresolved ./state.js import');
  assert.equal(/^\s*import\b.*\.\/preview\.js/m.test(filesJs), false, 'no unresolved ./preview.js import');
  assert.match(filesJs, /from\s+["']gpui-kit["']/);
  assert.match(filesJs, /from\s+["']gpui-base["']/);
  assert.match(filesJs, /from\s+["']herdr["']/);
  assert.match(filesJs, /\bFilePreview\b/, 'inlines ./preview.js');

  const phonesJs = files['mods/wayne-phones/main.js'];
  assert.match(phonesJs, /from\s+["'](?:node:)?fs\/promises["']/, 'keeps Node built-ins external');
});

test('syncHerdrDir removes retired wayne-board dir and stale duplicate SVGs idempotently', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'herdr-bundle-'));
  try {
    const appDir = join(tmp, 'installed-herdr-app');
    const stalePaths = [
      join(appDir, 'mods', 'wayne-board', 'main.js'),
      join(appDir, 'mods', 'wayne-board', 'board.svg'),
      join(appDir, 'mods', 'my-files', 'state.js'),
      join(appDir, 'mods', 'my-files', 'file.svg'),
      join(appDir, 'mods', 'my-pane', 'close.svg'),
      join(appDir, 'mods', 'my-tabs', 'win-min.svg'),
    ];
    for (const p of stalePaths) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'stale');
    }

    const files = herdrMod.readHerdrFiles(herdrRoot);
    herdrMod.syncHerdrDir(appDir, files);
    herdrMod.syncHerdrDir(appDir, files); // idempotent when unchanged

    assert.equal(existsSync(join(appDir, 'mods', 'wayne-board')), false, 'retired wayne-board dir removed');
    for (const p of stalePaths) assert.equal(existsSync(p), false, `stale path removed: ${p}`);
    assert.equal(existsSync(join(appDir, 'mods', 'my-files', 'main.js')), true);
    assert.equal(existsSync(join(appDir, 'mods', 'my-tabs', 'main.js')), true);
    assert.equal(existsSync(join(appDir, 'mods', 'my-pane', 'main.js')), true);
    assert.equal(existsSync(join(appDir, 'mods', 'wayne-phones', 'main.js')), true);
    assert.equal(existsSync(join(appDir, 'programs.json')), true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(appDir, 'layouts', 'main-preview.json'), 'utf8')).children[1].children[1].children[1].content,
      { mod: 'my-files' },
      'panel is a direct my-files block without stack wrapper',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
