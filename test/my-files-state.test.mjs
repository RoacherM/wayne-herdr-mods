// The Files panel's own logic (herdr-app/mods/my-files/state.js): what it keeps per pane, and the
// open-files list of its full-window view. DESIGN.md「Herdr.app 里的界面」
import test from 'node:test';
import assert from 'node:assert/strict';
import * as files from '../herdr-app/mods/my-files/state.js';

const space = { id: 's1', folder: '/repo', machine: null, active: true };
const panes = [
  { pane: 'p1', tab: 'tA', terminal: 't1', cwd: '/repo' },
  { pane: 'p2', tab: 'tB', terminal: 't2', cwd: '/repo' },
  { pane: 'p3', tab: 'tA', terminal: null, mod: 'my-files', cwd: null },
  { pane: 'p4', tab: 'tA', terminal: 't4', cwd: '/repo' },
];
const focus = (tab, pane) => ({ space: 's1', tab, pane, terminal: panes.find((p) => p.pane === pane)?.terminal ?? null, cwd: null });
const key = (args) => JSON.stringify(files.locate({ space, panes, ...args }));

test('each pane (window) keeps its own panel: folders open, file shown', () => {
  assert.notEqual(key({ focus: focus('tA', 'p1') }), key({ focus: focus('tA', 'p4') }), 'two panes of one tab, one folder');
  assert.notEqual(key({ focus: focus('tA', 'p1') }), key({ focus: focus('tB', 'p2') }), 'two tabs, one folder');
});

test('a terminal block of the layout (no pane) keeps its own panel too', () => {
  const block = { space: 's1', tab: 'tA', pane: null, terminal: 't9', cwd: '/repo' };
  assert.notEqual(key({ focus: block }), key({ focus: focus('tA', 'p1') }));
});

test('with a file tab focused, the panel is the one of the window that opened it', () => {
  const opened = { file: '/repo/a.md', root: '/repo', on: null, from: 'p4' };
  assert.equal(key({ focus: focus('tA', 'p3'), opened }), key({ focus: focus('tA', 'p4') }));
  assert.equal(key({ focus: focus('tA', 'p1'), opened }), key({ focus: focus('tA', 'p1') }), 'a shell split beside the file: the panel follows the shell');
  assert.notEqual(key({ focus: focus('tA', 'p1'), opened }), key({ focus: focus('tA', 'p4') }));
});

test('a pane with its own file looks at that file\'s folder', () => {
  assert.deepEqual(files.locate({ file: '/a/b/c.md', space, panes, focus: focus('tA', 'p1') }), { pane: null, cwd: '/a/b', on: null, file: '/a/b/c.md' });
  assert.equal(files.locate({ file: '/a/b/c.md', fileOn: 'vps', space, panes, focus: null }).on, 'vps', 'a file on another machine stays there');
});

test('a file opens once: a second click finds its tab; closed tabs are forgotten', () => {
  const a = { file: '/repo/a.md', root: '/repo', on: null, from: 'p1' };
  let all = files.withFileTab({}, 'tF', a, new Set(['tA', 'tF']));
  all = files.withFileTab(all, 'tG', { ...a, file: '/repo/b.md' }, new Set(['tA', 'tF', 'tG']));
  assert.equal(files.fileTabOf(all, '/repo/a.md', new Set(['tF', 'tG'])), 'tF');
  assert.equal(files.fileTabOf(all, '/repo/a.md', new Set(['tG'])), null, 'its tab was closed: open a new one');
  assert.equal(files.fileTabOf(all, '/repo/c.md', new Set(['tF', 'tG'])), null);
  all = files.withFileTab(all, 'tH', { ...a, file: '/repo/c.md' }, new Set(['tG', 'tH']));
  assert.deepEqual(Object.keys(all).sort(), ['tG', 'tH'], 'tab tF was closed: its entry goes');
  assert.deepEqual(files.withFileTab(null, 'tA', null, new Set(['tA'])), {});
});

test('the tab tab.new made is the new id', () => {
  assert.equal(files.newTabId(new Set(['t1', 't2']), ['t1', 't2', 't3']), 't3');
  assert.equal(files.newTabId(new Set(['t1']), ['t1']), null);
});

test('a relative link in a file opened by absolute path stays absolute', () => {
  assert.equal(files.linkTarget('/repo/docs/a.md', '../README.md'), '/repo/README.md');
  assert.equal(files.linkTarget('docs/a.md', './b.md#x'), 'docs/b.md');
  assert.equal(files.linkTarget('a.md', 'https://x.dev'), null);
});
