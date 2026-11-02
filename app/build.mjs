// Build the PWA into ../relay/public (served by the relay Worker as static assets).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const out = new URL('../relay/public/', import.meta.url);
const version = Date.now().toString(36);
mkdirSync(out, { recursive: true });
await build({ entryPoints: [new URL('./src/main.js', import.meta.url).pathname], bundle: true, minify: true, format: 'iife', target: ['safari16', 'chrome110'], outfile: new URL('app.js', out).pathname, legalComments: 'none' });
copyFileSync(new URL('./src/app.css', import.meta.url), new URL('app.css', out));
for (const name of readdirSync(new URL('./static/', import.meta.url))) {
  const src = new URL(`./static/${name}`, import.meta.url);
  if (/\.(html|js|webmanifest)$/.test(name)) writeFileSync(new URL(name, out), readFileSync(src, 'utf8').replaceAll('__V__', version));
  else copyFileSync(src, new URL(name, out));
}
console.log('built', version, readdirSync(out).join(' '));
