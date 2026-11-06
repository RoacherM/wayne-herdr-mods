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

test('with the full-window view focused, the panel is the one of the pane that opened it', () => {
  const viewer = { root: '/repo', on: null, from: 'p4', files: [], active: null };
  assert.equal(key({ focus: focus('tA', 'p3'), viewer }), key({ focus: focus('tA', 'p4') }));
});

test('a pane with its own file looks at that file\'s folder', () => {
  assert.deepEqual(files.locate({ file: '/a/b/c.md', space, panes, focus: focus('tA', 'p1') }), { pane: null, cwd: '/a/b', on: null, file: '/a/b/c.md' });
});

test('the full-window view is per tab', () => {
  assert.equal(files.viewerPane(panes, 'tA')?.pane, 'p3');
  assert.equal(files.viewerPane(panes, 'tB'), null);
});

test('open files are kept per tab after the view closes, and dropped with their tab', () => {
  const a = { root: '/repo', on: null, from: 'p1', files: ['/repo/a.md'], active: '/repo/a.md' };
  let all = files.withViewer({}, 'tA', a, new Set(['tA', 'tB']));
  all = files.withViewer(all, 'tB', { ...a, files: [], active: null }, new Set(['tA', 'tB']));
  assert.deepEqual(Object.keys(all).sort(), ['tA', 'tB']);
  assert.deepEqual(all.tA.files, ['/repo/a.md'], 'kept: the next ⤢ shows them again');
  all = files.withViewer(all, 'tB', all.tB, new Set(['tB']));
  assert.deepEqual(Object.keys(all), ['tB'], 'tab tA was closed: its files go');
  assert.equal(files.withViewer(null, 'tA', null, new Set(['tA'])).tA, undefined);
});

test('opening a file adds a tab once and shows it; closing shows a neighbour', () => {
  let v = { root: '/repo', on: null, files: [], active: null };
  v = files.openIn(v, '/repo/a.md'); v = files.openIn(v, '/repo/b.js'); v = files.openIn(v, '/repo/a.md');
  assert.deepEqual(v.files, ['/repo/a.md', '/repo/b.js']);
  assert.equal(v.active, '/repo/a.md');
  v = files.openIn(v, '/repo/c.txt');
  v = files.closeIn(v, '/repo/c.txt');
  assert.equal(v.active, '/repo/b.js', 'the last one closed → the one before it');
  v = files.closeIn(v, '/repo/a.md');
  assert.equal(v.active, '/repo/b.js', 'closing another tab keeps the shown one');
  v = files.closeIn(v, '/repo/b.js');
  assert.deepEqual(v.files, []);
  assert.equal(v.active, null);
});

test('a relative link in a file opened by absolute path stays absolute', () => {
  assert.equal(files.linkTarget('/repo/docs/a.md', '../README.md'), '/repo/README.md');
  assert.equal(files.linkTarget('docs/a.md', './b.md#x'), 'docs/b.md');
  assert.equal(files.linkTarget('a.md', 'https://x.dev'), null);
});
