// The production relay serves relay/landing/ (a notice + a PWA kill switch), not the app
// (DESIGN.md「地址和域名」: 网页版已停 2026-11-09).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../relay/landing');

test('index.html: the notice page, self-contained, no external assets', () => {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.match(html, /Herdr App/);
  assert.doesNotMatch(html, /<script\s+[^>]*src=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test('sw.js: a kill switch, not a cache', () => {
  const sw = readFileSync(join(dir, 'sw.js'), 'utf8');
  assert.match(sw, /unregister/);
  assert.doesNotMatch(sw, /addEventListener\(\s*['"]fetch['"]/);
});
