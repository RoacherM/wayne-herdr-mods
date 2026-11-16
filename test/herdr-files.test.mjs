// Bundling herdr-app/mods/*/main.js into self-contained ESM for ~/.config/herdr-app and cleaning stale files.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as herdrMod from '../host/herdr-files.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const herdrRoot = join(repoRoot, 'herdr-app');

test('readHerdrFiles bundles every mod main.js into self-contained ESM and omits wayne-board/layout.js', () => {
  const files = herdrMod.readHerdrFiles(herdrRoot);
  assert.equal('mods/wayne-board/layout.js' in files, false, 'omits deprecated layout.js');

  const boardJs = files['mods/wayne-board/main.js'];
  assert.equal(typeof boardJs, 'string');
  assert.equal(/^\s*import\b.*shared\/board/m.test(boardJs), false, 'no unresolved ../../../shared/board.js import');
  assert.equal(/^\s*import\b.*\.\/layout/m.test(boardJs), false, 'no unresolved ./layout.js import');
  assert.match(boardJs, /from\s+["']gpui-kit["']/);
  assert.match(boardJs, /from\s+["']gpui-base["']/);
  assert.match(boardJs, /from\s+["']herdr["']/);
  assert.match(boardJs, /function layoutMetro\b/, 'inlines shared/board.js layoutMetro');

  const phonesJs = files['mods/wayne-phones/main.js'];
  assert.match(phonesJs, /from\s+["'](?:node:)?fs\/promises["']/, 'keeps Node built-ins external');
});

test('readHerdrFiles resolves ../../../shared/board.js and syncHerdrDir removes orphan layout.js', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'herdr-bundle-'));
  try {
    mkdirSync(join(tmp, 'shared'), { recursive: true });
    writeFileSync(join(tmp, 'shared', 'board.js'), readFileSync(join(repoRoot, 'shared', 'board.js'), 'utf8'));
    const modDir = join(tmp, 'herdr-app', 'mods', 'wayne-board');
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, 'main.js'), [
      'import { View, div } from "gpui-kit";',
      'import { layoutMetro, boardBadgeOf } from "../../../shared/board.js";',
      'export default class Board extends View { render() { return div().child(String(boardBadgeOf(layoutMetro(null).header?.badge).count)); } }',
    ].join('\n'));

    const files = herdrMod.readHerdrFiles(join(tmp, 'herdr-app'));
    const bundled = files['mods/wayne-board/main.js'];
    assert.equal(bundled.includes('../../../shared/board.js'), false);
    assert.match(bundled, /from\s+["']gpui-kit["']/);
    assert.match(bundled, /function boardBadgeOf\b/);

    const appDir = join(tmp, 'installed-herdr-app');
    const orphan = join(appDir, 'mods', 'wayne-board', 'layout.js');
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, '// stale layout.js');
    files['programs.json'] = JSON.stringify({ programs: { devin: { name: 'Devin', icon: 'agent-icons/devin.svg' } } });
    assert.equal(typeof herdrMod.syncHerdrDir, 'function');
    herdrMod.syncHerdrDir(appDir, files);
    herdrMod.syncHerdrDir(appDir, files); // idempotent when unchanged
    assert.equal(existsSync(orphan), false, 'stale mods/wayne-board/layout.js removed on install');
    assert.equal(existsSync(join(appDir, 'mods', 'wayne-board', 'main.js')), true);
    assert.equal(existsSync(join(appDir, 'programs.json')), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
