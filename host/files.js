/**
 * Workspace file browser and low-bandwidth preview generator for phones.
 *
 * Security boundaries (DESIGN.md「安全」「手机端文件与低带宽视频预览」):
 * - Phone never passes arbitrary filesystem paths: every call names a `rootId` derived from live
 *   herdr-core workspaces (`space.folder`) or terminal working directories (`t.cwd`).
 * - Both root and target are resolved through `realpath`, and the target must stay strictly inside
 *   the root's realpath (checked at both `open` and `slice`). `.git` internals are never listed or opened.
 * - All external tools (`sips`, `qlmanage`, `ffmpeg`, `ffprobe`) are invoked via `execFile` without a
 *   shell, write to temporary paths and `rename` atomically only on exit 0, and deduplicate in-flight
 *   jobs per content hash.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open as fsOpen, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

export const MAX_SLICE_BYTES = 64 * 1024;
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_RAW_DOC_BYTES = 15 * 1024 * 1024;
const MAX_DIR_ITEMS = 250;
const MAX_DIR_SCAN = 400;
const MAX_PREVIEW_ENTRIES = 120;

const MD_EXT = new Set(['md', 'markdown', 'mdx']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'heic', 'avif', 'tiff', 'tif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac']);
const LOOK_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'rtf', 'html', 'htm']);

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  heic: 'image/heic', avif: 'image/avif', tiff: 'image/tiff', tif: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers', key: 'application/vnd.apple.keynote',
  rtf: 'application/rtf', html: 'text/html', htm: 'text/html',
};

const EXEC_ENV = {
  ...process.env,
  PATH: `${join(homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`,
};
const HERDR_APP_HOME = process.env.HERDR_APP_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr-app');

function runBin(bin, args, timeout = 30_000) {
  return new Promise((res, rej) => {
    execFile(bin, args, { env: EXEC_ENV, timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || bin).trim().split('\n').pop();
        rej(new Error(msg || `${bin} 执行失败`));
      } else {
        res({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    });
  });
}

export function classifyFile(name) {
  const ext = extname(String(name ?? '')).slice(1).toLowerCase();
  if (MD_EXT.has(ext)) return 'md';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (LOOK_EXT.has(ext)) return 'look';
  return 'text';
}

function hasForbiddenSegment(rel) {
  const parts = String(rel ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.some((p) => p === '.git' || p === '..');
}

function isInsideRoot(target, root) {
  if (root === sep) return target.startsWith(sep);
  return target === root || target.startsWith(root + sep);
}

export function createFiles({ dir, terminals, extraRoots = [], syncApp = false, log = () => {} }) {
  const cacheDir = join(dir, 'cache', 'previews');
  const previews = new Map(); // previewId -> { filePath, rootReal, mime, name, total, createdAt }
  const inFlight = new Map(); // key -> Promise

  function dedup(key, fn) {
    if (inFlight.has(key)) return inFlight.get(key);
    const p = Promise.resolve().then(fn).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  function registerPreview(previewId, info) {
    if (previews.has(previewId)) previews.delete(previewId);
    else if (previews.size >= MAX_PREVIEW_ENTRIES) {
      const oldest = previews.keys().next().value;
      if (oldest) previews.delete(oldest);
    }
    previews.set(previewId, { ...info, createdAt: Date.now() });
    return previewId;
  }

  function touchPreview(previewId) {
    const entry = previews.get(previewId);
    if (!entry) return null;
    previews.delete(previewId);
    previews.set(previewId, entry);
    return entry;
  }

  function collectRoots() {
    const out = [];
    const list = terminals?.list?.() ?? [];
    const layout = terminals?.layout?.() ?? [];
    const byAddr = new Map(list.map((t) => [t.address, t]));

    for (const space of layout) {
      const spaceAddrs = (space.tabs ?? []).flatMap((tab) => tab.terminals ?? []);
      const first = spaceAddrs.map((a) => terminals?.get?.(a) ?? byAddr.get(a)).find(Boolean);
      const firstProj = spaceAddrs.map((a) => byAddr.get(a)).find(Boolean);
      const folder = first?.foreground?.cwd ?? first?.cwd ?? space.folder;
      if (!folder) continue;
      const whereLabel = firstProj?.where ? String(firstProj.where).replace(/ \/ \d+$/, '') : '';
      const name = space.name || whereLabel || basename(folder) || space.id || '工作区';
      out.push({ id: String(space.id), name, folder });
    }

    for (const t of list) {
      const rawT = terminals?.get?.(t.address) ?? t;
      const spaceForT = layout.find((sp) => (sp.tabs ?? []).some((tab) => (tab.terminals ?? []).includes(t.address)));
      const folder = rawT.foreground?.cwd || rawT.cwd || t.cwd || spaceForT?.folder;
      if (!folder) continue;
      out.push({
        id: `term:${t.address}`,
        name: basename(folder) || t.address,
        folder,
      });
    }

    for (const r of extraRoots) {
      if (r?.id && r?.folder && !out.some((x) => x.id === r.id)) {
        out.push({ id: String(r.id), name: r.name || basename(r.folder) || String(r.id), folder: r.folder });
      }
    }
    return out;
  }

  async function resolveSafe(rootId, rawRelPath = '') {
    const allRoots = collectRoots();
    if (!allRoots.length) throw new Error('当前没有可浏览的工作区目录');
    const root = (rootId ? allRoots.find((r) => r.id === String(rootId)) : allRoots[0]) ?? allRoots[0];

    let rootReal;
    try {
      rootReal = await realpath(root.folder);
    } catch {
      throw new Error('工作区目录不存在或无法访问');
    }

    const cleanRel = String(rawRelPath ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (hasForbiddenSegment(cleanRel)) throw new Error('不允许访问该路径');

    const candidate = cleanRel ? resolve(rootReal, cleanRel) : rootReal;
    if (!isInsideRoot(candidate, rootReal)) {
      throw new Error('路径超出工作区范围');
    }

    let targetReal;
    try {
      targetReal = await realpath(candidate);
    } catch {
      throw new Error('文件或目录不存在');
    }

    if (!isInsideRoot(targetReal, rootReal)) {
      throw new Error('符号链接超出工作区范围');
    }

    const relFromRoot = targetReal === rootReal ? '' : relative(rootReal, targetReal).split(sep).join('/');
    if (hasForbiddenSegment(relFromRoot)) throw new Error('不允许访问 .git 内部文件');

    return { root, rootReal, targetReal, relPath: relFromRoot };
  }

  async function roots() {
    const all = collectRoots();
    const valid = [];
    const seenFolders = new Set();
    for (const r of all) {
      if (seenFolders.has(r.folder)) continue;
      try {
        const st = await stat(r.folder);
        if (st.isDirectory()) {
          seenFolders.add(r.folder);
          valid.push({ id: r.id, name: r.name, folder: basename(r.folder) || r.folder });
        }
      } catch {}
    }
    return { roots: valid };
  }

  async function gitMarksForRoot(rootReal) {
    try {
      const topOut = await runBin('git', ['-C', rootReal, 'rev-parse', '--show-toplevel'], 4_000);
      const topReal = await realpath(topOut.stdout.trim());
      const prefix = topReal === rootReal ? '' : relative(topReal, rootReal).split(sep).join('/');
      const { stdout } = await runBin('git', [
        '-C', rootReal,
        '--no-optional-locks',
        '-c', 'core.fsmonitor=false',
        'status', '--porcelain=v1', '-z',
        '--no-renames', '--untracked-files=all',
      ], 6_000);
      const marks = {};
      for (const rec of stdout.split('\0')) {
        if (rec.length < 4) continue;
        const xy = rec.slice(0, 2);
        const rawPath = rec.slice(3);
        let relInside = rawPath;
        if (prefix) {
          if (rawPath === prefix) relInside = '';
          else if (rawPath.startsWith(`${prefix}/`)) relInside = rawPath.slice(prefix.length + 1);
          else continue;
        }
        relInside = relInside.replace(/\/+$/, '');
        if (!relInside) continue;
        let mark = 'M';
        if (xy === '??') mark = 'U';
        else if (xy.includes('D')) mark = 'D';
        else if (xy.includes('A')) mark = 'A';
        marks[relInside] = mark;
      }
      return marks;
    } catch {
      return {};
    }
  }

  async function readSharedExpanded(rootReal) {
    try {
      const raw = JSON.parse(await readFile(join(HERDR_APP_HOME, 'shared.json'), 'utf8'));
      const map = raw?.['my-files/folders'];
      const list = Array.isArray(map?.[rootReal]) ? map[rootReal] : [];
      return list.filter((p) => typeof p === 'string' && !hasForbiddenSegment(p));
    } catch {
      return [];
    }
  }

  async function readDirItems(rootReal, targetReal, normalizedRel) {
    const dirEntries = await readdir(targetReal, { withFileTypes: true });
    const filtered = dirEntries
      .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
      .sort((a, b) => {
        const aDir = a.isDirectory();
        const bDir = b.isDirectory();
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });

    const cappedEntries = filtered.slice(0, MAX_DIR_SCAN);
    const items = [];
    for (const entry of cappedEntries) {
      if (items.length >= MAX_DIR_ITEMS) break;
      const full = join(targetReal, entry.name);
      try {
        const realFull = await realpath(full);
        if (!isInsideRoot(realFull, rootReal)) continue;
        const relCheck = realFull === rootReal ? '' : relative(rootReal, realFull);
        if (hasForbiddenSegment(relCheck)) continue;
        const st = await stat(realFull);
        const isDir = st.isDirectory();
        const itemRel = normalizedRel ? `${normalizedRel}/${entry.name}` : entry.name;
        items.push({
          name: entry.name,
          path: itemRel,
          dir: isDir,
          size: isDir ? 0 : st.size,
          mtime: Math.trunc(st.mtimeMs),
          kind: isDir ? 'dir' : classifyFile(entry.name),
        });
      } catch {}
    }

    items.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return { items, truncated: filtered.length > items.length };
  }

  async function panel({ address, rootId, open, folders, onlyChanged } = {}) {
    let rootReal = null;
    try {
      const resolved = await resolveSafe(rootId || (address ? `term:${address}` : undefined), '');
      rootReal = resolved.rootReal;
    } catch {}

    if (syncApp) {
      if (rootReal && (Array.isArray(folders) || typeof onlyChanged === 'boolean')) {
        try {
          const syncDir = join(HERDR_APP_HOME, 'data', 'my-files');
          await mkdir(syncDir, { recursive: true });
          const payload = {
            root: rootReal,
            folders: Array.isArray(folders) ? folders.map(String) : undefined,
            onlyChanged: typeof onlyChanged === 'boolean' ? onlyChanged : undefined,
            ts: Date.now(),
          };
          await writeFile(join(syncDir, 'phone-sync.json'), JSON.stringify(payload));
          await runBin('herdr-app', ['do', 'my-files.sync'], 3_000).catch(() => {});
        } catch (err) {
          log(`files.panel sync error: ${err?.message ?? err}`);
        }
      }

      if (open === true) {
        try {
          if (address) {
            const layout = terminals?.layout?.() ?? [];
            for (const s of layout) {
              for (const tab of s.tabs ?? []) {
                if ((tab.terminals ?? []).includes(address)) {
                  await runBin('herdr-app', ['do', 'space.select', JSON.stringify({ id: s.id })], 3_000).catch(() => {});
                  await runBin('herdr-app', ['do', 'tab.select', JSON.stringify({ id: tab.id })], 3_000).catch(() => {});
                  await runBin('herdr-app', ['do', 'pane.focus', JSON.stringify({ terminal: address })], 3_000).catch(() => {});
                  break;
                }
              }
            }
          }
          await runBin('herdr-app', ['do', 'layout.select', JSON.stringify({ stack: 'panel-body', child: 'files' })], 3_000).catch(() => {});
          await runBin('herdr-app', ['do', 'layout.show', JSON.stringify({ id: 'panel' })], 3_000).catch(() => {});
        } catch (err) {
          log(`files.panel open error: ${err?.message ?? err}`);
        }
      } else if (open === false) {
        try {
          await runBin('herdr-app', ['do', 'layout.hide', JSON.stringify({ id: 'panel' })], 3_000).catch(() => {});
        } catch {}
      }
    }

    return { ok: true, root: rootReal };
  }

  async function list({ rootId, path: relPath = '', syncPanel = false, address } = {}) {
    const t0 = Date.now();
    const { root, rootReal, targetReal, relPath: normalizedRel } = await resolveSafe(rootId, relPath);
    const { items, truncated } = await readDirItems(rootReal, targetReal, normalizedRel);

    if (syncPanel) {
      panel({ address: address || (String(root.id).startsWith('term:') ? String(root.id).slice(5) : undefined), rootId: root.id, open: true }).catch(() => {});
    }

    if (normalizedRel === '') {
      const [marks, expandedFolders] = await Promise.all([
        gitMarksForRoot(rootReal),
        readSharedExpanded(rootReal),
      ]);
      const toPreload = new Set(expandedFolders);
      for (const changedPath of Object.keys(marks)) {
        const parts = changedPath.split('/');
        let cur = '';
        for (let i = 0; i < parts.length - 1; i++) {
          cur = cur ? `${cur}/${parts[i]}` : parts[i];
          if (toPreload.size < 20) toPreload.add(cur);
        }
      }
      const subfolders = {};
      for (const subRel of [...toPreload].slice(0, 20)) {
        try {
          const subResolved = await resolveSafe(root.id, subRel);
          if (subResolved.relPath) {
            const subDir = await readDirItems(rootReal, subResolved.targetReal, subResolved.relPath);
            subfolders[subResolved.relPath] = subDir.items;
          }
        } catch {}
      }
      log(`wayne-herdr-mods: files.list root=${root.id} items=${items.length} marks=${Object.keys(marks).length} sub=${Object.keys(subfolders).length} ms=${Date.now() - t0}`);
      return {
        rootId: root.id,
        rootName: root.name,
        path: normalizedRel,
        items,
        truncated,
        marks,
        expandedFolders,
        subfolders,
      };
    }

    log(`wayne-herdr-mods: files.list root=${root.id} path=${normalizedRel} items=${items.length} ms=${Date.now() - t0}`);
    return {
      rootId: root.id,
      rootName: root.name,
      path: normalizedRel,
      items,
      truncated,
    };
  }

  async function buildImagePreview(targetReal, rootReal, st, ext, name, hash) {
    return dedup(`img:${hash}`, async () => {
      await mkdir(cacheDir, { recursive: true });
      const directExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg']);
      if (st.size <= 160 * 1024 && directExts.has(ext)) {
        const mime = MIME_BY_EXT[ext] ?? 'image/jpeg';
        const pid = registerPreview(`img-${hash}`, { filePath: targetReal, rootReal, mime, name, total: st.size });
        const inline = st.size <= 48 * 1024 ? `data:${mime};base64,${(await readFile(targetReal)).toString('base64')}` : undefined;
        return { previewId: pid, mime, total: st.size, inline };
      }

      const outJpg = join(cacheDir, `${hash}-1440.jpg`);
      try {
        await stat(outJpg);
      } catch {
        const tmpJpg = join(cacheDir, `${hash}-1440.${process.pid}.${Date.now()}.tmp.jpg`);
        try {
          await runBin('/usr/bin/sips', ['-Z', '1440', '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', targetReal, '--out', tmpJpg], 20_000);
          await rename(tmpJpg, outJpg);
        } finally {
          await rm(tmpJpg, { force: true }).catch(() => {});
        }
      }
      const outStat = await stat(outJpg);
      const pid = registerPreview(`img-${hash}`, { filePath: outJpg, rootReal: cacheDir, mime: 'image/jpeg', name: `${name}.jpg`, total: outStat.size });
      const inline = outStat.size <= 48 * 1024 ? `data:image/jpeg;base64,${(await readFile(outJpg)).toString('base64')}` : undefined;
      return { previewId: pid, mime: 'image/jpeg', total: outStat.size, inline };
    });
  }

  async function probeVideoDuration(targetReal) {
    try {
      const { stdout } = await runBin('ffprobe', [
        '-v', 'error',
        '-protocol_whitelist', 'file,pipe',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        targetReal,
      ], 8_000);
      const d = Number.parseFloat(stdout.trim());
      return Number.isFinite(d) && d > 0 ? d : 0;
    } catch {
      return 0;
    }
  }

  async function buildVideoPreview(targetReal, st, name, hash) {
    return dedup(`vid:${hash}`, async () => {
      await mkdir(cacheDir, { recursive: true });
      const stripJpg = join(cacheDir, `${hash}-strip.jpg`);
      const outMp4 = join(cacheDir, `${hash}-480p.mp4`);
      const duration = await probeVideoDuration(targetReal);

      // 1. 6-frame horizontal storyboard filmstrip (~40 KB JPEG) for instant visual scrubbing
      let strip;
      try {
        try {
          await stat(stripJpg);
        } catch {
          const tmpStrip = join(cacheDir, `${hash}-strip.${process.pid}.${Date.now()}.tmp.jpg`);
          try {
            const clipDur = Math.max(1, Math.min(duration || 6, 300));
            const fpsExpr = duration > 1 ? `fps=6/${clipDur.toFixed(2)}` : 'fps=1';
            await runBin('ffmpeg', [
              '-y',
              '-protocol_whitelist', 'file,pipe',
              '-hwaccel', 'videotoolbox',
              '-t', String(clipDur),
              '-i', targetReal,
              '-frames:v', '1',
              '-vf', `${fpsExpr},scale=280:-2,tile=6x1`,
              '-q:v', '6',
              tmpStrip,
            ], 20_000);
            await rename(tmpStrip, stripJpg);
          } finally {
            await rm(tmpStrip, { force: true }).catch(() => {});
          }
        }
        const stripBuf = await readFile(stripJpg);
        strip = `data:image/jpeg;base64,${stripBuf.toString('base64')}`;
      } catch (e) {
        log(`wayne-herdr-mods: filmstrip 生成失败: ${e.message}`);
      }

      // 2. Low-bandwidth 480p@15fps H.264 + 24kbps mono AAC + faststart MP4 (~25-32 KB/s)
      try {
        await stat(outMp4);
      } catch {
        const tmpMp4 = join(cacheDir, `${hash}-480p.${process.pid}.${Date.now()}.tmp.mp4`);
        const scaleFilter = "scale='min(854,iw)':-2,fps=15";
        try {
          try {
            await runBin('ffmpeg', [
              '-y',
              '-protocol_whitelist', 'file,pipe',
              '-hwaccel', 'videotoolbox',
              '-i', targetReal,
              '-t', '300',
              '-vf', scaleFilter,
              '-c:v', 'h264_videotoolbox', '-b:v', '220k', '-maxrate', '260k', '-bufsize', '520k',
              '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-ac', '1', '-b:a', '24k',
              '-movflags', '+faststart',
              tmpMp4,
            ], 60_000);
          } catch {
            await runBin('ffmpeg', [
              '-y',
              '-protocol_whitelist', 'file,pipe',
              '-i', targetReal,
              '-t', '300',
              '-vf', scaleFilter,
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-maxrate', '260k', '-bufsize', '520k',
              '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-ac', '1', '-b:a', '24k',
              '-movflags', '+faststart',
              tmpMp4,
            ], 60_000);
          }
          await rename(tmpMp4, outMp4);
        } finally {
          await rm(tmpMp4, { force: true }).catch(() => {});
        }
      }

      const mp4Stat = await stat(outMp4);
      const pid = registerPreview(`vid-${hash}`, {
        filePath: outMp4,
        rootReal: cacheDir,
        mime: 'video/mp4',
        name: name.replace(/\.[^.]+$/, '') + '.mp4',
        total: mp4Stat.size,
      });

      return {
        previewId: pid,
        mime: 'video/mp4',
        total: mp4Stat.size,
        duration: Math.round(duration * 10) / 10,
        strip,
        tiles: 6,
      };
    });
  }

  async function buildLookPreview(targetReal, rootReal, st, ext, name, hash) {
    return dedup(`look:${hash}`, async () => {
      await mkdir(cacheDir, { recursive: true });
      const outJpg = join(cacheDir, `${hash}-look.jpg`);
      let thumbPreviewId = null;
      let thumbTotal = 0;
      let inline = undefined;

      try {
        try {
          await stat(outJpg);
        } catch {
          const tmpDir = join(cacheDir, `ql-${hash}-${process.pid}-${Date.now()}`);
          const tmpJpg = join(cacheDir, `${hash}-look.${process.pid}.${Date.now()}.tmp.jpg`);
          await mkdir(tmpDir, { recursive: true });
          try {
            await runBin('/usr/bin/qlmanage', ['-t', '-s', '1600', '-o', tmpDir, targetReal], 20_000);
            const generated = (await readdir(tmpDir)).find((f) => f.endsWith('.png'));
            if (generated) {
              await runBin('/usr/bin/sips', ['-Z', '1440', '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', join(tmpDir, generated), '--out', tmpJpg], 15_000);
              await rename(tmpJpg, outJpg);
            }
          } finally {
            await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            await rm(tmpJpg, { force: true }).catch(() => {});
          }
        }
        const jpgStat = await stat(outJpg);
        thumbTotal = jpgStat.size;
        thumbPreviewId = registerPreview(`look-${hash}`, { filePath: outJpg, rootReal: cacheDir, mime: 'image/jpeg', name: `${name}.jpg`, total: jpgStat.size });
        if (jpgStat.size <= 64 * 1024) {
          inline = `data:image/jpeg;base64,${(await readFile(outJpg)).toString('base64')}`;
        }
      } catch (e) {
        log(`wayne-herdr-mods: QuickLook 缩略图生成失败: ${e.message}`);
      }

      const rawMime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      const rawPreviewId = st.size <= MAX_RAW_DOC_BYTES
        ? registerPreview(`raw-${hash}`, { filePath: targetReal, rootReal, mime: rawMime, name, total: st.size })
        : null;

      return {
        thumbPreviewId,
        thumbTotal,
        inline,
        rawPreviewId,
        rawTotal: rawPreviewId ? st.size : 0,
        rawMime,
      };
    });
  }

  async function open({ rootId, path: relPath } = {}) {
    if (!relPath) throw new Error('缺少文件路径');
    const t0 = Date.now();
    const { root, rootReal, targetReal, relPath: normalizedRel } = await resolveSafe(rootId, relPath);
    const st = await stat(targetReal);
    if (st.isDirectory()) throw new Error('不能直接打开文件夹');

    const name = basename(targetReal);
    const ext = extname(name).slice(1).toLowerCase();
    const kind = classifyFile(name);
    const hash = createHash('md5')
      .update(`${targetReal}:${st.size}:${Math.trunc(st.mtimeMs)}`)
      .digest('hex')
      .slice(0, 20);

    if (kind === 'image') {
      const img = await buildImagePreview(targetReal, rootReal, st, ext, name, hash);
      log(`wayne-herdr-mods: files.open kind=image path=${normalizedRel} rawBytes=${st.size} previewBytes=${img.total} ms=${Date.now() - t0}`);
      return {
        kind: 'image',
        rootId: root.id,
        name,
        path: normalizedRel,
        ext,
        size: st.size,
        mtime: Math.trunc(st.mtimeMs),
        ...img,
      };
    }

    if (kind === 'video') {
      const vid = await buildVideoPreview(targetReal, st, name, hash);
      log(`wayne-herdr-mods: files.open kind=video path=${normalizedRel} rawBytes=${st.size} previewBytes=${vid.total} dur=${vid.duration}s ms=${Date.now() - t0}`);
      return {
        kind: 'video',
        rootId: root.id,
        name,
        path: normalizedRel,
        ext,
        size: st.size,
        mtime: Math.trunc(st.mtimeMs),
        ...vid,
      };
    }

    if (kind === 'audio') {
      const mime = MIME_BY_EXT[ext] ?? 'audio/mp4';
      const pid = st.size <= MAX_RAW_DOC_BYTES
        ? registerPreview(`aud-${hash}`, { filePath: targetReal, rootReal, mime, name, total: st.size })
        : null;
      log(`wayne-herdr-mods: files.open kind=audio path=${normalizedRel} rawBytes=${st.size} ms=${Date.now() - t0}`);
      return {
        kind: 'audio',
        rootId: root.id,
        name,
        path: normalizedRel,
        ext,
        size: st.size,
        mtime: Math.trunc(st.mtimeMs),
        previewId: pid,
        mime,
        total: st.size,
      };
    }

    if (kind === 'look') {
      const look = await buildLookPreview(targetReal, rootReal, st, ext, name, hash);
      log(`wayne-herdr-mods: files.open kind=look path=${normalizedRel} rawBytes=${st.size} thumbBytes=${look.thumbTotal} ms=${Date.now() - t0}`);
      return {
        kind: 'look',
        rootId: root.id,
        name,
        path: normalizedRel,
        ext,
        size: st.size,
        mtime: Math.trunc(st.mtimeMs),
        ...look,
      };
    }

    // Text / Markdown / Code (with binary sniff check)
    const readLen = Math.min(st.size, MAX_TEXT_BYTES);
    let buf = Buffer.alloc(0);
    if (readLen > 0) {
      const fh = await fsOpen(targetReal, 'r');
      try {
        buf = Buffer.alloc(readLen);
        const { bytesRead } = await fh.read(buf, 0, readLen, 0);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    }

    const sniffLen = Math.min(buf.length, 4096);
    for (let i = 0; i < sniffLen; i++) {
      if (buf[i] === 0) {
        const rawPreviewId = st.size <= MAX_RAW_DOC_BYTES
          ? registerPreview(`bin-${hash}`, { filePath: targetReal, rootReal, mime: 'application/octet-stream', name, total: st.size })
          : null;
        log(`wayne-herdr-mods: files.open kind=binary path=${normalizedRel} rawBytes=${st.size} ms=${Date.now() - t0}`);
        return {
          kind: 'binary',
          rootId: root.id,
          name,
          path: normalizedRel,
          ext,
          size: st.size,
          mtime: Math.trunc(st.mtimeMs),
          previewId: rawPreviewId,
          total: st.size,
        };
      }
    }

    const qlName = /\.(txt|md|json|log|csv|xml|yaml|yml|js|ts|tsx|jsx|py|sh|swift|rs|go|c|h|cpp|css|html)$/i.test(name)
      ? name
      : `${name}.txt`;
    const rawPreviewId = st.size > 0 && st.size <= MAX_RAW_DOC_BYTES
      ? registerPreview(`txt-${hash}`, { filePath: targetReal, rootReal, mime: 'text/plain; charset=utf-8', name: qlName, total: st.size })
      : null;

    log(`wayne-herdr-mods: files.open kind=${kind} path=${normalizedRel} rawBytes=${st.size} inlineBytes=${buf.length} truncated=${st.size > MAX_TEXT_BYTES} ms=${Date.now() - t0}`);
    return {
      kind, // 'md' | 'text'
      rootId: root.id,
      name,
      path: normalizedRel,
      ext,
      size: st.size,
      mtime: Math.trunc(st.mtimeMs),
      text: buf.toString('utf8'),
      truncated: st.size > MAX_TEXT_BYTES,
      rawPreviewId,
      rawTotal: rawPreviewId ? st.size : 0,
    };
  }

  async function slice({ previewId, offset = 0, length = MAX_SLICE_BYTES } = {}) {
    const entry = touchPreview(String(previewId ?? ''));
    if (!entry) throw new Error('预览已过期，请重新打开文件');

    // Re-verify realpath containment before opening in case a workspace file was swapped with a symlink
    const currentReal = await realpath(entry.filePath);
    const allowedRoot = await realpath(entry.rootReal);
    if (!isInsideRoot(currentReal, allowedRoot)) {
      throw new Error('预览文件路径已变更或超出允许范围');
    }

    const off = Math.max(0, Math.trunc(Number(offset) || 0));
    const len = Math.max(1, Math.min(Math.trunc(Number(length) || MAX_SLICE_BYTES), MAX_SLICE_BYTES));
    if (off >= entry.total) {
      return { data: '', offset: off, length: 0, total: entry.total, mime: entry.mime, eof: true };
    }

    const toRead = Math.min(len, entry.total - off);
    const fh = await fsOpen(currentReal, 'r');
    try {
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, off);
      const sliceBuf = buf.subarray(0, bytesRead);
      const eof = bytesRead === 0 || off + bytesRead >= entry.total;
      if (off === 0 || eof) {
        log(`wayne-herdr-mods: files.slice id=${previewId} name=${entry.name} offset=${off} len=${bytesRead} total=${entry.total} eof=${eof}`);
      }
      return {
        data: sliceBuf.toString('base64'),
        offset: off,
        length: bytesRead,
        total: entry.total,
        mime: entry.mime,
        eof,
      };
    } finally {
      await fh.close();
    }
  }

  return { roots, list, open, slice, panel };
}
