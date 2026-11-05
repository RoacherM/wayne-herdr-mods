// Verify that all DESIGN.md section anchors in source files resolve and docs/issues/ stays consistent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['.git', 'node_modules', 'dist', 'relay/public', 'test/doc-lint.test.mjs']);
const CODE_EXT = new Set(['.js', '.mjs', '.ts', '.tsx']);

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = relative(root, join(dir, ent.name));
    if (SKIP.has(ent.name) || SKIP.has(rel) || ent.name.startsWith('.')) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (CODE_EXT.has(extname(ent.name))) out.push(p);
  }
  return out;
}

test('every DESIGN.md「section」 comment anchor exists in DESIGN.md', () => {
  const design = readFileSync(join(root, 'DESIGN.md'), 'utf8');
  const headings = [...design.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim());
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/DESIGN\.md「([^」]+)」/g)) {
      const target = m[1];
      assert.ok(
        headings.some((h) => h === target || h.startsWith(target)),
        `${relative(root, file)} references DESIGN.md「${target}」, which is missing in DESIGN.md`,
      );
    }
  }
});

test('docs/issues/INDEX.md references every active I-*.md card', () => {
  const issuesDir = join(root, 'docs', 'issues');
  assert.ok(existsSync(join(issuesDir, 'INDEX.md')));
  const index = readFileSync(join(issuesDir, 'INDEX.md'), 'utf8');
  for (const name of readdirSync(issuesDir)) {
    if (!name.startsWith('I-') || !name.endsWith('.md')) continue;
    assert.ok(index.includes(name), `docs/issues/${name} is not listed in docs/issues/INDEX.md`);
  }
});
