/**
 * Everything herdr-relay keeps on disk: this Mac's keys, the paired devices (public keys only)
 * with their Web Push subscriptions, and the VAPID key pair. One JSON file, mode 0600, written
 * atomically. Secrets never leave this file.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { b64, boxKeysFromSecret, newBoxKeys, newSignKeys, signKeysFromSecret, unb64 } from '../shared/e2e.js';

export const defaultDataDir = () => process.env.HERDR_RELAY_DIR ?? join(homedir(), '.config', 'herdr-relay');

export function defaultDesktopName() {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (name) return name.slice(0, 40);
    } catch {}
  }
  return hostname().replace(/\.(local|lan)$/i, '').trim() || 'Mac';
}

export async function createState({ dir = defaultDataDir() } = {}) {
  const file = join(dir, 'state.json');
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = {
      version: 1,
      signSecret: b64(newSignKeys().secretKey),
      boxSecret: b64(newBoxKeys().secretKey),
      vapid: webpush.generateVAPIDKeys(),
      devices: [],
    };
  }
  data.devices ??= [];

  let queue = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(data, null, 2);
    queue = queue.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, file);
    });
    return queue;
  }
  await save();

  const liveName = defaultDesktopName();
  return {
    dir,
    signKeys: signKeysFromSecret(unb64(data.signSecret)),
    boxKeys: boxKeysFromSecret(unb64(data.boxSecret)),
    get desktopName() { return data.customName ?? liveName; },
    get vapid() { return data.vapid; },
    devices: () => data.devices,
    deviceByKey: (pub) => data.devices.find((device) => device.pub === pub),
    deviceById: (id) => data.devices.find((device) => device.id === id),
    async addDevice({ name, pub }) {
      // Pairing the same phone key again replaces the old record instead of duplicating it.
      data.devices = data.devices.filter((device) => device.pub !== pub);
      const device = { id: randomUUID(), name: String(name || '设备').slice(0, 40), pub, createdAt: Date.now(), lastSeen: Date.now(), push: null };
      data.devices.push(device);
      await save();
      return device;
    },
    async updateDevice(id, patch) {
      const device = data.devices.find((item) => item.id === id);
      if (!device) return undefined;
      Object.assign(device, patch);
      await save();
      return device;
    },
    async removeDevice(id) {
      const before = data.devices.length;
      data.devices = data.devices.filter((device) => device.id !== id && !device.id.startsWith(id));
      if (data.devices.length !== before) await save();
      return before - data.devices.length;
    },
    save,
  };
}
