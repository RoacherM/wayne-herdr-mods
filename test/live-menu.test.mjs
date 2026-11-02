// A menu in the live part of the conversation view (app/src/live-menu.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { keysTo, menuOf } from '../app/src/live-menu.js';

test('options line up with the selected one; descriptions and other text are not options', () => {
  const lines = ['要运行 npm test 吗？', ' ❯ 1. 是', '   2. 是，以后都允许', '      (只在这个项目)', '   3. 否', '', 'Esc 取消'];
  const m = menuOf(lines);
  assert.deepEqual(m, { sel: 1, options: [1, 2, 4] });
  assert.equal(keysTo(m, 4), '\x1b[B\x1b[B');
  assert.equal(keysTo(m, 1), '\r');
  assert.equal(keysTo(m, 0), '');
  // The pointer further down: up arrows.
  const n = menuOf(['  a', '  b', '❯ c']);
  assert.deepEqual(n, { sel: 2, options: [0, 1, 2] });
  assert.equal(keysTo(n, 0), '\x1b[A\x1b[A');
  // In a box.
  assert.deepEqual(menuOf(['│ ❯ Yes   │', '│   No    │']), { sel: 0, options: [0, 1] });
});

test('no menu: no pointer, or a pointer alone (a prompt)', () => {
  assert.equal(menuOf(['⏺ writing', '· Thinking… (3s)']), null);
  assert.equal(menuOf(['❯ fix the bug', '', 'other']), null);
});
