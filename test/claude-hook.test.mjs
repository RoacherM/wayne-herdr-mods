// Cleanup of the retired Claude Code UserPromptSubmit hook (host/claude-hook.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_COMMAND, editSettingsFile, removeHook, said } from '../host/claude-hook.js';

test('removeHook strips only our legacy UserPromptSubmit hook and leaves other settings untouched', () => {
  const clean = {
    model: 'x',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'rex start' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other' }] }],
    },
  };
  const withOurs = {
    model: 'x',
    hooks: {
      SessionStart: clean.hooks.SessionStart,
      UserPromptSubmit: [...clean.hooks.UserPromptSubmit, { hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
    },
  };
  assert.deepEqual(removeHook(withOurs), clean);
  assert.equal(removeHook(clean), clean);
  assert.deepEqual(removeHook({ model: 'x', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }), { model: 'x' });
});

test('removeHook preserves shared entries and unknown shapes', () => {
  const shared = { hooks: { UserPromptSubmit: [{ matcher: 'x', hooks: [{ type: 'command', command: HOOK_COMMAND }, { type: 'command', command: 'echo unrelated' }] }] } };
  assert.deepEqual(removeHook(shared), { hooks: { UserPromptSubmit: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo unrelated' }] }] } });

  for (const odd of [['keep'], null, 'text', 7, { hooks: [] }, { hooks: 'x' }, { hooks: { UserPromptSubmit: {} } }, { hooks: { UserPromptSubmit: 'x' } }]) {
    assert.equal(removeHook(odd), odd, JSON.stringify(odd));
  }
  const oddList = { hooks: { UserPromptSubmit: ['odd', { hooks: 'odd' }, { hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } };
  assert.deepEqual(removeHook(oddList), { hooks: { UserPromptSubmit: ['odd', { hooks: 'odd' }] } });
});

test('editSettingsFile replaces atomically, preserves symlinks/modes, and said is a silent no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-settings-'));
  const real = join(dir, 'managed.json');
  const link = join(dir, 'settings.json');
  writeFileSync(real, JSON.stringify({ env: { TOKEN: 'private' }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }));
  chmodSync(real, 0o600);
  symlinkSync(real, link);

  writeFileSync(`${real}.wayne-herdr-mods.tmp`, 'stale');
  chmodSync(`${real}.wayne-herdr-mods.tmp`, 0o644);
  assert.equal(editSettingsFile(link, removeHook), 'changed');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), { env: { TOKEN: 'private' } });
  assert.equal(editSettingsFile(link, removeHook), 'same');
  assert.equal(editSettingsFile(join(dir, 'missing.json'), removeHook), 'same');
  assert.deepEqual(readdirSync(dir).sort(), ['managed.json', 'settings.json']);

  writeFileSync(real, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } }));
  const before = readFileSync(real, 'utf8');
  const failingFs = {
    existsSync: () => true, readFileSync, realpathSync, statSync,
    renameSync() { throw new Error('unreachable'); },
    rmSync() {},
    writeFileSync(p) { writeFileSync(p, '{"mod'); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); },
  };
  assert.throws(() => editSettingsFile(real, removeHook, failingFs), /ENOSPC/);
  assert.equal(readFileSync(real, 'utf8'), before);

  for (const bad of ['["keep"]', 'not json', '{"hooks":{"UserPromptSubmit":{}}}']) {
    writeFileSync(real, bad);
    assert.equal(editSettingsFile(real, removeHook), 'skipped');
  }
  assert.equal(await said(), undefined);
});
