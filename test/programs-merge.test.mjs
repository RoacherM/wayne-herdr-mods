// install merges our herdr-app/programs.json keys into the user's file (DESIGN.md「图标跟着 Herdr.app」):
// their programs and other top-level fields stay, our keys are ours, an unreadable file is never touched.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergePrograms } from '../host/herdr-files.js';

const here = dirname(fileURLToPath(import.meta.url));
const OURS = JSON.parse(readFileSync(join(here, '../herdr-app/programs.json'), 'utf8'));

test('no current file: writes our programs only', () => {
  const out = JSON.parse(mergePrograms(null, OURS));
  assert.deepEqual(out, { programs: OURS.programs });
});

test('the user’s programs and other top-level fields stay; ours are added', () => {
  const current = JSON.stringify({ shells: ['xonsh'], programs: { epi: { name: 'Epi', icon: 'icons/epi.svg', tint: false, match: ['epi'], run: ['epi'] } } });
  const out = JSON.parse(mergePrograms(current, OURS));
  assert.deepEqual(out.shells, ['xonsh']);
  assert.equal(out.programs.epi.name, 'Epi');
  for (const key of Object.keys(OURS.programs)) assert.deepEqual(out.programs[key], OURS.programs[key]);
});

test('an old entry under one of our keys is replaced by ours', () => {
  const current = JSON.stringify({ programs: { devin: { name: 'Devin', icon: 'icons/old.svg' } } });
  const out = JSON.parse(mergePrograms(current, OURS));
  assert.deepEqual(out.programs.devin, OURS.programs.devin);
});

test('already merged: null, nothing to write', () => {
  const merged = mergePrograms(null, OURS);
  assert.equal(mergePrograms(merged, OURS), null);
});

test('invalid JSON: null, the file is left alone', () => {
  assert.equal(mergePrograms('{oops', OURS), null);
});

test('every entry points at a real svg under herdr-app/, tintable ones use currentColor, none has <script', () => {
  for (const [key, p] of Object.entries(OURS.programs)) {
    const iconPath = join(here, '../herdr-app', p.icon);
    assert.ok(existsSync(iconPath), `${key}: ${p.icon} missing`);
    const svg = readFileSync(iconPath, 'utf8');
    if (p.tint) assert.ok(svg.includes('currentColor'), `${key}: tinted icon without currentColor`);
    assert.ok(!svg.includes('<script'), `${key}: svg contains <script`);
  }
});
