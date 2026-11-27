// Adds 12 workspaces (a shell each, in $HOME) to the scratch core of dev/fake-desktop.mjs, so the
// phone's lists and sheets have more rows than fit (DESIGN.md「原生 App 首页（收件箱）」).
// Prints a fresh pairing link into ios/probe/link.json too: each link pairs once.
//   node dev/many-spaces.mjs <fake-desktop's data dir, $TMPDIR/herdr-relay-ui-*>
import { writeFileSync } from 'node:fs';
import { openCore } from '../host/hc.js';
import { controlCall } from '../host/service.js';

const NAMES = ['storyforge', 'storyforge-mcp', 'interviews', 'jobs', 'nuwa', 'agent-forge', 'video-task', 'magpie-plugins', 'dsh-plugins', 'pi-extensions', 'wayne-skills', 'story-forge-agent'];
const dataDir = process.argv[2];
const mac = await openCore({ session: 'relay-ui' });
const doc = await mac.call('doc.get', { name: 'herdr-app' });
const spaces = doc.value.spaces.filter((s) => !s.id.startsWith('x'));
for (const [i, n] of NAMES.entries()) {
  const t = (await mac.call('terminal.run', { argv: ['/bin/zsh', '-f'], cwd: process.env.HOME, labels: { where: n }, rm: true })).address;
  spaces.push({ id: `x${i}`, name: n, folder: `~/Projects/${n}`, tabs: [{ id: `xt${i}`, name: 'main', root: { content: { terminal: t } } }] });
}
await mac.call('doc.set', { name: 'herdr-app', version: doc.version, value: { ...doc.value, spaces } });
mac.close();
if (dataDir) {
  const s = await controlCall(dataDir, 'pair.start');
  writeFileSync(new URL('../ios/probe/link.json', import.meta.url), JSON.stringify({ link: s.pairing.offer.link }));
}
console.log(`${spaces.length} workspaces${dataDir ? '; new link in ios/probe/link.json' : ''}`);
process.exit(0);
