import { randomUUID } from 'node:crypto';

/** Chunked uploads from one phone (voice and images): {id, offset, total, mime, data(base64)} → bytes. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // terminal.put takes at most 8 MB
export function createUploads({ now = () => Date.now(), ttlMs = 5 * 60_000, maxBytes = MAX_UPLOAD_BYTES, keep = 6 } = {}) {
  const uploads = new Map();
  const sweep = () => { for (const [id, u] of uploads) if (now() - u.at > ttlMs) uploads.delete(id); };
  return {
    put({ id, offset, total, mime, data }) {
      sweep();
      total = Number(total);
      offset = Number(offset);
      if (!(total > 0 && total <= maxBytes)) throw new Error(`文件太大（最多 ${maxBytes >> 20} MB）`);
      const chunk = Buffer.from(String(data ?? ''), 'base64');
      let u = id ? uploads.get(String(id)) : null;
      if (id && !u) throw new Error('上传已过期，请重试');
      if (!u) {
        if (offset !== 0) throw new Error('上传顺序不对');
        if (uploads.size >= keep) uploads.delete(uploads.keys().next().value);
        u = { id: randomUUID(), bytes: Buffer.alloc(total), received: 0, total, mime: String(mime ?? ''), at: now() };
        uploads.set(u.id, u);
      }
      if (offset !== u.received || offset + chunk.length > u.total) throw new Error('上传顺序不对');
      chunk.copy(u.bytes, offset);
      u.received += chunk.length;
      u.at = now();
      return { id: u.id, received: u.received };
    },
    take(id) {
      const u = uploads.get(String(id));
      uploads.delete(String(id));
      if (!u) throw new Error('上传已过期，请重试');
      if (u.received !== u.total) throw new Error('还没传完');
      return u;
    },
    drop(id) { uploads.delete(String(id)); },
  };
}
