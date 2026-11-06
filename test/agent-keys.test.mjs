// The phone's agent shortcuts and key combos (app/src/agent-keys.js). DESIGN.md「每个 agent 的快捷键」
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentKeys, combo, keyOfChar, AGENT_KEYS } from '../app/src/agent-keys.js';
import { KEY_RE } from '../host/phones.js';


test('each agent gets its own shortcuts, by icon or by program name', () => {
  assert.equal(agentKeys({ icon: 'claude' }), AGENT_KEYS.claude);
  assert.equal(agentKeys({ icon: null, app: 'claude-code' }), AGENT_KEYS.claude);
  assert.equal(agentKeys({ icon: 'antigravity' }).find(([l]) => l === '⌥M')[1][0], 'alt+m');
  assert.equal(agentKeys({ app: 'agy' }), AGENT_KEYS.antigravity);
  assert.deepEqual(agentKeys({ icon: 'shell', program: 'zsh' }), [], 'a shell: none');
  assert.deepEqual(agentKeys(null), []);
});

test('every shortcut is a key name the Mac lets through (host/phones.js KEY_RE)', () => {
  for (const [agent, list] of Object.entries(AGENT_KEYS)) for (const [label, keys] of list) for (const k of keys) assert.match(k, KEY_RE, `${agent} ${label}`);
});

test('a combo names the held modifiers in one order; typed characters become key names', () => {
  assert.equal(combo(new Set(['shift', 'ctrl']), 'enter'), 'ctrl+shift+enter');
  assert.equal(combo(new Set(['alt']), keyOfChar('M')), 'alt+m');
  assert.equal(combo(new Set(), 'tab'), 'tab');
  assert.equal(keyOfChar(' '), 'space');
  assert.equal(keyOfChar('/'), '/');
  assert.equal(keyOfChar('中'), null);
  for (const c of 'aZ09-=[]\;\',./`') assert.match(combo(new Set(['ctrl']), keyOfChar(c)), KEY_RE);
});
