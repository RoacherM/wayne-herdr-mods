// Bundle the host into one file (dist/herdr-relay.mjs) so `install` can copy it anywhere.
import { build } from 'esbuild';
await build({
  entryPoints: [new URL('./main.js', import.meta.url).pathname],
  outfile: new URL('../dist/herdr-relay.mjs', import.meta.url).pathname,
  bundle: true, platform: 'node', format: 'esm', target: 'node20', legalComments: 'none',
  // web-push and qrcode are CommonJS and require() node builtins.
  banner: { js: "// herdr-relay bundle\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('built dist/herdr-relay.mjs');
