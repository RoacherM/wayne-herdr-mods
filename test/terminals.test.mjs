// What a phone sees of a terminal (host/terminals.js): display facts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { programOf, project } from '../host/terminals.js';

test('a script run by an interpreter is named after the script', () => {
  assert.equal(programOf({ name: 'node', argv: ['node', '/opt/homebrew/bin/epi'] }), 'epi');
  assert.equal(programOf({ name: 'python3', argv: ['python3', '-u', 'tools/agent.py', '--x'] }), 'agent');
  assert.equal(programOf({ name: 'bun', argv: ['bun', 'run', 'dev'] }), 'bun', 'a subcommand is not a script');
  assert.equal(programOf({ name: 'claude', argv: ['claude', '--dangerously-skip-permissions'] }), 'claude');
  assert.equal(programOf({ name: 'zsh', argv: ['/bin/zsh', '-l'] }), 'zsh');
  assert.equal(programOf(null), null);
});

test('the phone never gets argv', () => {
  const p = project({ address: 't1', foreground: { name: 'node', argv: ['node', '/x/epi', '--key', 'secret'], cwd: '/w' } });
  assert.equal(p.program, 'epi');
  assert.ok(!JSON.stringify(p).includes('secret'));
});
