#!/usr/bin/env node
// Serve a built client (default: client/dist) with the SAME response headers CloudFront adds
// (read from deploy/aws/site.yaml, so the two cannot drift), the same Content-Type and
// Cache-Control deploy.sh sets on upload, and S3+OAC behaviour for missing keys (403).
// Use it to check that the CSP does not break the wasm engine / AudioWorklet before deploying:
//
//   (cd client && BASE_PATH=/ npx vite build) && node deploy/aws/serve-local.mjs [--port 8080] [--dir client/dist] [--csp '<policy>']
//
// then open http://localhost:8080/ and watch the console for "Refused to ..." CSP errors.
// No dependencies (Node >= 18).
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const port = Number(opt('--port', process.env.PORT || 8080))
const host = opt('--host', '127.0.0.1')
const root = resolve(opt('--dir', join(here, '../../client/dist')))

/** The security headers of SecurityHeadersPolicy in site.yaml, as name -> value. */
export function headersFromTemplate(yaml) {
  const one = (re, what) => {
    const m = yaml.match(re)
    if (!m) throw new Error(`site.yaml: could not find ${what}`)
    return m[1]
  }
  const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  const h = {}
  const hsts = one(/AccessControlMaxAgeSec:\s*(\d+)/, 'HSTS max-age')
  const sub = /IncludeSubdomains:\s*true/.test(yaml) ? '; includeSubDomains' : ''
  const pre = /Preload:\s*true/.test(yaml) ? '; preload' : ''
  h['Strict-Transport-Security'] = `max-age=${hsts}${sub}${pre}`
  if (/ContentTypeOptions:/.test(yaml)) h['X-Content-Type-Options'] = 'nosniff'
  h['X-Frame-Options'] = one(/FrameOption:\s*(\w+)/, 'FrameOption')
  h['Referrer-Policy'] = one(/ReferrerPolicy:\s*\n\s*ReferrerPolicy:\s*([\w-]+)/, 'ReferrerPolicy')
  // a plain value, or the static branch of the `!If HasServer` (the last "default-src ..." line; the cloud one is a !Sub)
  const csp = yaml.match(/\n\s*ContentSecurityPolicy:\s*(["'].*["'])\s*\n/)?.[1] ?? one(/\n\s*- ("default-src [^\n]*")\s*\n/, 'ContentSecurityPolicy')
  h['Content-Security-Policy'] = unquote(csp)
  for (const m of yaml.matchAll(/- Header:\s*([\w-]+)\s*\n\s*Value:\s*(.+)\n/g)) h[m[1]] = unquote(m[2])
  return h
}

// Same mapping as content_type() in deploy.sh.
const TYPES = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
}

const security = headersFromTemplate(await readFile(join(here, 'site.yaml'), 'utf8'))
// --csp "<policy>" tries a different policy locally (copy the winner back into site.yaml).
if (opt('--csp')) security['Content-Security-Policy'] = opt('--csp')

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(security)) res.setHeader(k, v)
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (path.endsWith('/')) path += 'index.html' // CloudFront DefaultRootObject (root only, but harmless)
  const file = normalize(join(root, path))
  const status = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/xml' })
    res.end(body)
    console.log(code, req.method, req.url)
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return status(405, '<Error><Code>MethodNotAllowed</Code></Error>')
  if (file !== root && !file.startsWith(root + sep)) return status(403, '<Error><Code>AccessDenied</Code></Error>')
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file')
    const body = await readFile(file)
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream')
    res.setHeader('Cache-Control', path.startsWith('/assets/') ? 'public,max-age=31536000,immutable' : 'no-cache')
    res.writeHead(200)
    res.end(req.method === 'HEAD' ? undefined : body)
    console.log(200, req.method, req.url)
  } catch {
    status(403, '<Error><Code>AccessDenied</Code></Error>') // S3 behind OAC without ListBucket
  }
})

server.listen(port, host, () => {
  console.log(`serving ${root} at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/ with:`)
  for (const [k, v] of Object.entries(security)) console.log(`  ${k}: ${v}`)
})
