import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyFile, createFiles, MAX_SLICE_BYTES, MAX_TEXT_BYTES } from '../host/files.js';

function runFfmpeg(args) {
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` };
  return new Promise((res, rej) => {
    execFile('ffmpeg', args, { env, timeout: 20_000 }, (err) => (err ? rej(err) : res()));
  });
}

test('classifyFile categorizes common extensions', () => {
  assert.equal(classifyFile('README.md'), 'md');
  assert.equal(classifyFile('photo.HEIC'), 'image');
  assert.equal(classifyFile('demo.mp4'), 'video');
  assert.equal(classifyFile('voice.m4a'), 'audio');
  assert.equal(classifyFile('spec.pdf'), 'look');
  assert.equal(classifyFile('App.tsx'), 'text');
});

test('roots, list, path sandboxing, text/image/video open and 64KB slice streaming', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'herdr-files-'));
  const dataDir = join(baseDir, 'data');
  const workspaceDir = join(baseDir, 'workspace');
  const outsideDir = join(baseDir, 'outside');
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(workspaceDir, 'src'), { recursive: true });
  await mkdir(join(workspaceDir, '.git'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(join(workspaceDir, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
  await writeFile(join(workspaceDir, '.DS_Store'), 'junk');
  await writeFile(join(workspaceDir, 'README.md'), '# Hello Herdr\nFile preview works!\n');
  await writeFile(join(workspaceDir, 'src', 'index.ts'), 'export const x = 42;\n');
  await writeFile(join(outsideDir, 'secret.txt'), 'top-secret');
  await symlink(join(outsideDir, 'secret.txt'), join(workspaceDir, 'escape-link.txt'));

  const fakeTerminals = {
    layout: () => [{ id: 's1', name: 'herdr-relay', folder: workspaceDir, tabs: [{ id: 'tab1', terminals: ['t1'] }] }],
    list: () => [{ address: 't1', cwd: workspaceDir }],
    get: () => ({ address: 't1', cwd: workspaceDir }),
  };

  const files = createFiles({ dir: dataDir, terminals: fakeTerminals });

  try {
    // 1. Roots discovery
    const { roots } = await files.roots();
    assert.equal(roots.length, 1);
    assert.equal(roots[0].id, 's1');
    assert.equal(roots[0].name, 'herdr-relay');

    // 2. Directory listing (folders first, hides .git, .DS_Store, and outside symlinks)
    const rootList = await files.list({ rootId: 's1', path: '' });
    assert.deepEqual(
      rootList.items.map((i) => ({ name: i.name, dir: i.dir, kind: i.kind })),
      [
        { name: 'src', dir: true, kind: 'dir' },
        { name: 'README.md', dir: false, kind: 'md' },
      ],
    );

    // 3. Path traversal & .git rejection
    await assert.rejects(() => files.list({ rootId: 's1', path: '../outside' }), /不允许访问/);
    await assert.rejects(() => files.open({ rootId: 's1', path: '../outside/secret.txt' }), /不允许访问/);
    await assert.rejects(() => files.open({ rootId: 's1', path: '.git/config' }), /不允许访问/);
    await assert.rejects(() => files.open({ rootId: 's1', path: 'escape-link.txt' }), /超出工作区范围/);

    // 4. Markdown / text open + truncation
    const md = await files.open({ rootId: 's1', path: 'README.md' });
    assert.equal(md.kind, 'md');
    assert.equal(md.truncated, false);
    assert.match(md.text, /# Hello Herdr/);

    const bigText = 'A'.repeat(MAX_TEXT_BYTES + 5000);
    await writeFile(join(workspaceDir, 'big.log'), bigText);
    const openedBig = await files.open({ rootId: 's1', path: 'big.log' });
    assert.equal(openedBig.kind, 'text');
    assert.equal(openedBig.truncated, true);
    assert.equal(openedBig.text.length, MAX_TEXT_BYTES);

    // 5. Image preview + slice streaming
    const samplePng = join(process.cwd(), 'docs', 'pc-herdr-mock.png');
    await symlink(samplePng, join(workspaceDir, 'linked-outside.png')).catch(() => {});
    // Copy a real PNG inside workspace
    const { copyFile } = await import('node:fs/promises');
    await copyFile(samplePng, join(workspaceDir, 'screen.png'));
    const img = await files.open({ rootId: 's1', path: 'screen.png' });
    assert.equal(img.kind, 'image');
    assert.ok(img.previewId);
    assert.ok(img.total > 0);
    assert.ok(img.total < img.size, '1440px JPEG preview should be smaller than 2880px Retina PNG');

    // Reassemble via files.slice
    const chunks = [];
    let offset = 0;
    while (offset < img.total) {
      const part = await files.slice({ previewId: img.previewId, offset, length: MAX_SLICE_BYTES });
      const buf = Buffer.from(part.data, 'base64');
      chunks.push(buf);
      offset += part.length;
      if (part.eof) break;
    }
    const fullImg = Buffer.concat(chunks);
    assert.equal(fullImg.length, img.total);
    assert.equal(fullImg[0], 0xff);
    assert.equal(fullImg[1], 0xd8); // JPEG SOI marker

    // 6. Video preview (6-frame filmstrip + 480p@15fps MP4 + slice)
    const sampleMp4 = join(workspaceDir, 'clip.mp4');
    await runFfmpeg([
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      sampleMp4,
    ]);
    const [vid, vid2] = await Promise.all([
      files.open({ rootId: 's1', path: 'clip.mp4' }),
      files.open({ rootId: 's1', path: 'clip.mp4' }),
    ]);
    assert.equal(vid.kind, 'video');
    assert.equal(vid.previewId, vid2.previewId);
    assert.ok(vid.previewId);
    assert.ok(vid.total > 0);
    assert.equal(vid.mime, 'video/mp4');
    assert.ok(vid.strip?.startsWith('data:image/jpeg;base64,'), 'video open should return inline filmstrip JPEG');
    const firstSlice = await files.slice({ previewId: vid.previewId, offset: 0, length: 4096 });
    const mp4Header = Buffer.from(firstSlice.data, 'base64');
    assert.equal(mp4Header.subarray(4, 8).toString('ascii'), 'ftyp');

    // 7. Symlink-swap after open is blocked at slice time
    const binPath = join(workspaceDir, 'swap.bin');
    await writeFile(binPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const openedBin = await files.open({ rootId: 's1', path: 'swap.bin' });
    assert.equal(openedBin.kind, 'binary');
    await rm(binPath);
    await symlink(join(outsideDir, 'secret.txt'), binPath);
    await assert.rejects(() => files.slice({ previewId: openedBin.previewId, offset: 0, length: 64 }), /超出允许范围/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
