// Bundle the host into one file (dist/herdr-relay.mjs) so `install` can copy it anywhere.
import { build } from 'esbuild';
import { readHerdrFiles } from './herdr-files.js';
// Our Herdr.app files (herdr-app/) go into the bundle as text: `install` writes them out.
const herdrApp = readHerdrFiles(new URL('../herdr-app', import.meta.url).pathname);
await build({
  entryPoints: [new URL('./main.js', import.meta.url).pathname],
  outfile: new URL('../dist/herdr-relay.mjs', import.meta.url).pathname,
  define: { __HERDR_APP__: JSON.stringify(herdrApp) },
  bundle: true, platform: 'node', format: 'esm', target: 'node20', legalComments: 'none',
  // web-push and qrcode are CommonJS and require() node builtins.
  banner: { js: "// herdr-relay bundle\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('built dist/herdr-relay.mjs');
