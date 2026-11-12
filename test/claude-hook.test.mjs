// The Claude Code hook that records what the person said (host/claude-hook.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_COMMAND, editSettingsFile, mergeHook, removeHook, said, saidLabel } from '../host/claude-hook.js';

test('install adds one UserPromptSubmit hook and leaves the rest of the settings alone', () => {
  const mine = { model: 'x', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'rex start' }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other' }] }] } };
  const next = mergeHook(mine);
  assert.deepEqual(next.hooks.UserPromptSubmit.map((e) => e.hooks[0].command), ['other', HOOK_COMMAND]);
  assert.deepEqual([next.model, next.hooks.SessionStart], [mine.model, mine.hooks.SessionStart]);
  assert.equal(mergeHook(next), next, 'a second install changes nothing');
  assert.deepEqual(removeHook(next), mine, 'uninstall gives back what was there');
  assert.deepEqual(removeHook(mergeHook({ model: 'x' })), { model: 'x' }, 'the hooks it created go with it');
  assert.equal(removeHook(mine), mine);
  assert.equal(mergeHook({}).hooks.UserPromptSubmit.length, 1, 'no settings yet: ours is the first');
});

test('the label is the time, then the start of the prompt on one line', () => {
  assert.equal(saidLabel(JSON.stringify({ prompt: '  不希望有轮的概念，\n就是全局的观测面板。 ' }), 1794454000000), '1794454000000|不希望有轮的概念， 就是全局的观测面板。');
  const long = saidLabel(JSON.stringify({ prompt: '字'.repeat(500) }), 1);
  assert.equal(long.length, 2 + 300);
  assert.ok(long.endsWith('…'));
  assert.equal(saidLabel(JSON.stringify({ prompt: '   ' }), 1), null);
  assert.equal(saidLabel('not json', 1), null);
});

test('the hook labels the terminal it runs in, and does nothing outside Herdr', async () => {
  const calls = [];
  const run = (bin, args, _o, done) => { calls.push(args); done(new Error('hc is gone')); }; // a failing hc must not fail the prompt
  await said({ stdin: Readable.from([JSON.stringify({ prompt: '用 Carbon' })]), env: { HC_TERMINAL_ID: 't48' }, now: 7, run });
  assert.deepEqual(calls, [['label', 't48', 'wayne.said=7|用 Carbon']]);
  await said({ stdin: Readable.from(['{}']), env: {}, now: 7, run });
  assert.equal(calls.length, 1);
});

test('uninstall takes only our command out of an entry it shares with someone else', () => {
  const shared = { hooks: { UserPromptSubmit: [{ matcher: 'x', hooks: [{ type: 'command', command: HOOK_COMMAND }, { type: 'command', command: 'echo unrelated' }] }] } };
  assert.deepEqual(removeHook(shared), { hooks: { UserPromptSubmit: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo unrelated' }] }] } });
  assert.equal(mergeHook(shared), shared, 'and install sees it is already there');
});

test('settings of a shape we do not know are left exactly as they are', () => {
  for (const odd of [['keep'], null, 'text', 7, { hooks: [] }, { hooks: 'x' }, { hooks: { UserPromptSubmit: {} } }, { hooks: { UserPromptSubmit: 'x' } }]) {
    assert.equal(mergeHook(odd), odd, JSON.stringify(odd));
    assert.equal(removeHook(odd), odd, JSON.stringify(odd));
  }
  // An entry of an odd shape inside a normal list is carried along untouched.
  const list = { hooks: { UserPromptSubmit: ['odd', { hooks: 'odd' }] } };
  assert.deepEqual(mergeHook(list).hooks.UserPromptSubmit.slice(0, 2), ['odd', { hooks: 'odd' }]);
  assert.deepEqual(removeHook(mergeHook(list)), list);
});

test('the settings file is replaced whole, or not at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-settings-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, '{"model":"x"}');
  assert.equal(editSettingsFile(file, mergeHook), 'changed');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command, HOOK_COMMAND);
  assert.equal(editSettingsFile(file, mergeHook), 'same');
  assert.deepEqual(readdirSync(dir), ['settings.json'], 'no temporary file stays behind');

  // The disk fills up half-way through the write: the old settings are still there, whole.
  const before = readFileSync(file, 'utf8');
  const fs = { existsSync: () => true, readFileSync, realpathSync, statSync, renameSync() { throw new Error('unreachable'); }, rmSync() {}, writeFileSync(p) { writeFileSync(p, '{"mod'); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } };
  assert.throws(() => editSettingsFile(file, removeHook, fs), /ENOSPC/);
  assert.equal(readFileSync(file, 'utf8'), before);

  for (const text of ['["keep"]', 'not json', '{"hooks":{"UserPromptSubmit":{}}}']) {
    writeFileSync(file, text);
    assert.equal(editSettingsFile(file, mergeHook), 'skipped');
    assert.equal(readFileSync(file, 'utf8'), text);
  }
  assert.equal(editSettingsFile(join(dir, 'new.json'), mergeHook), 'changed', 'no file yet: one is made');
});

test('the replaced settings keep their permissions, and a linked settings.json stays a link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-settings-'));
  const real = join(dir, 'managed.json'), link = join(dir, 'settings.json');
  writeFileSync(real, '{"env":{"TOKEN":"private"}}');
  chmodSync(real, 0o600);
  symlinkSync(real, link);
  assert.equal(editSettingsFile(link, mergeHook), 'changed');
  assert.ok(lstatSync(link).isSymbolicLink(), 'still a link');
  assert.equal(JSON.parse(readFileSync(real, 'utf8')).hooks.UserPromptSubmit.length, 1, 'the file it points to got the hook');
  assert.equal(statSync(real).mode & 0o777, 0o600, 'still readable by its owner only');
  // A temporary file left behind by an interrupted run, readable by everyone: it is not reused.
  writeFileSync(`${real}.wayne-herdr-mods.tmp`, 'stale'); chmodSync(`${real}.wayne-herdr-mods.tmp`, 0o644);
  assert.equal(editSettingsFile(link, removeHook), 'changed');
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(real, 'utf8')).env.TOKEN, 'private');
  const fresh = join(dir, 'fresh.json');
  editSettingsFile(fresh, mergeHook);
  assert.equal(statSync(fresh).mode & 0o777, 0o600, 'a new settings file is private too');
});
