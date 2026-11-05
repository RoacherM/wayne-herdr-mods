// What a phone sees of a terminal (host/terminals.js): display facts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { iconOf, programOf, project } from '../host/terminals.js';

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
  assert.equal(p.icon, 'epi');
  assert.ok(!JSON.stringify(p).includes('secret'));
});

test('iconOf maps Herdr agent and program names to sidebar icon keys', () => {
  assert.equal(iconOf('claude-code', 'claude'), 'claude');
  assert.equal(iconOf('antigravity', 'zsh'), 'antigravity');
  assert.equal(iconOf(null, 'agy'), 'antigravity');
  assert.equal(iconOf('epi', 'node'), 'epi');
  assert.equal(iconOf(null, 'zsh'), 'shell');
  assert.equal(iconOf(null, null), 'shell');
  assert.equal(iconOf(null, 'python3'), 'python');
});

// t25 on 2026-11-05: epi exited, zsh is back in front, the report still says app=epi.
test('an agent that exited leaves a shell, not its icon', () => {
  const gone = project({ address: 't25', foreground: { name: 'zsh', argv: ['/bin/zsh', '-l'] }, status: { app: 'epi', state: 'done' } });
  assert.equal(gone.app, null);
  assert.equal(gone.icon, 'shell');
  const live = project({ address: 't1k', foreground: { name: 'agy', argv: ['agy'] }, status: { app: 'antigravity', state: 'idle' } });
  assert.equal(live.icon, 'antigravity');
});

test('project turns done into idle once herdr.seen reaches turn', () => {
  const unseen = project({
    address: 't1',
    turn: 5,
    labels: { 'herdr.seen': '4' },
    status: { app: 'claude-code', state: 'done' },
  });
  assert.equal(unseen.state, 'done');

  const seen = project({
    address: 't1',
    turn: 5,
    labels: { 'herdr.seen': '5' },
    status: { app: 'claude-code', state: 'done' },
  });
  assert.equal(seen.state, 'idle');

  const noLabel = project({
    address: 't1',
    turn: 1,
    status: { app: 'claude-code', state: 'done' },
  });
  assert.equal(noLabel.state, 'done');

  const zeroTurnSeen = project({
    address: 't1',
    labels: { 'herdr.seen': '0' },
    status: { app: 'claude-code', state: 'done' },
  });
  assert.equal(zeroTurnSeen.state, 'idle');
});
