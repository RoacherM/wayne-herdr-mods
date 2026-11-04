// Bundle the host into one file (dist/wayne-herdr-mods.mjs) so `install` can copy it anywhere.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { readHerdrFiles } from './herdr-files.js';
// Our Herdr.app files (herdr-app/) go into the bundle as text: `install` writes them out.
const herdrApp = readHerdrFiles(new URL('../herdr-app', import.meta.url).pathname);
await build({
  entryPoints: [new URL('./main.js', import.meta.url).pathname],
  outfile: new URL('../dist/wayne-herdr-mods.mjs', import.meta.url).pathname,
  define: { __HERDR_APP__: JSON.stringify(herdrApp), __SKILL__: JSON.stringify(readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8')) },
  bundle: true, platform: 'node', format: 'esm', target: 'node20', legalComments: 'none',
  // web-push and qrcode are CommonJS and require() node builtins.
  banner: { js: "// wayne-herdr-mods bundle\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('built dist/wayne-herdr-mods.mjs');
