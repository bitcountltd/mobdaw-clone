// A self-contained server release for the EC2 host: src/main.ts and every dependency in one ESM file, so the instance
// needs only Node 24 (no npm install there, and the versions are the ones in this repo's lockfile).
//   node deploy/aws/build-server.mjs OUT_DIR
// Writes OUT_DIR/main.mjs (the server) and OUT_DIR/admin.mjs (the admin CLI, server/scripts/admin.ts), with source maps.
// ws's optional native addons stay out: ws falls back to plain JS without them.
import { build } from 'esbuild'
import { resolve } from 'node:path'

const out = resolve(process.argv[2] ?? 'server/release')
const root = resolve(import.meta.dirname, '../..')

await build({
  entryPoints: { main: resolve(root, 'server/src/main.ts'), admin: resolve(root, 'server/scripts/admin.ts') },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // CommonJS dependencies call require() for Node built-ins; give the ESM bundle one
  banner: { js: "import { createRequire as __mobdawRequire } from 'node:module'; const require = __mobdawRequire(import.meta.url);" },
  external: ['bufferutil', 'utf-8-validate'],
  sourcemap: 'linked',
  legalComments: 'linked',
  logLevel: 'warning',
})
console.log(`server release: ${out} (main.mjs, admin.mjs)`)
