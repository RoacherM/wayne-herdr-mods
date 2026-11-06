// What a phone sees of a terminal (host/terminals.js): display facts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { iconOf, programOf, project, readHerdrPrograms } from '../host/terminals.js';

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

// What Herdr.app shares (~/.config/herdr-app/shared.json): its own answer per terminal, written by
// our my-tabs, and its agent table, cached by its new-menu. The phone shows what Herdr shows, for
// any agent Herdr knows now or later, with nothing to add by hand here.
const shared = {
  'wayne-herdr-mods.programs': { t9: { key: 'qwen', icon: 'icons/qwen.svg', tint: true }, t25: { key: 'epi', icon: 'icons/epi.svg', tint: false } },
  'new-menu.agents': { '': [{ key: 'newbot', icon: 'icons/newbot.svg', tint: false, run: ['newbot-cli'] }, { key: 'kiro', icon: 'icons/kiro.svg', tint: false, run: ['kiro-cli'] }] },
};

test('the phone takes the icon Herdr.app gives a terminal', () => {
  const herdr = readHerdrPrograms(shared);
  const p = project({ address: 't9', foreground: { name: 'qwen', argv: ['qwen'] }, status: { app: 'qwen-code', state: 'working' } }, herdr);
  assert.equal(p.icon, 'qwen');
  assert.deepEqual(herdr.byKey.qwen, { icon: 'icons/qwen.svg', tint: true });
});

test('a shell in front still wins over what Herdr.app last said', () => {
  const herdr = readHerdrPrograms(shared);
  assert.equal(project({ address: 't25', foreground: { name: 'zsh', argv: ['zsh'] }, status: { app: 'epi', state: 'done' } }, herdr).icon, 'shell');
});

test("without Herdr.app's answer, its agent table names a new agent's command", () => {
  const herdr = readHerdrPrograms(shared);
  assert.equal(iconOf(null, 'newbot-cli', herdr), 'newbot');
  assert.equal(project({ address: 't3', foreground: { name: 'newbot-cli', argv: ['newbot-cli'] } }, herdr).icon, 'newbot');
  assert.equal(herdr.byKey.newbot.tint, false);
});

test('a shared.json that cannot be read gives nothing, not an error', () => {
  for (const bad of [null, {}, { 'wayne-herdr-mods.programs': 'x', 'new-menu.agents': { '': 'y' } }]) {
    const herdr = readHerdrPrograms(bad);
    assert.deepEqual(herdr.byAddress, {});
    assert.equal(project({ address: 't1', foreground: { name: 'claude', argv: ['claude'] } }, herdr).icon, 'claude');
  }
});
