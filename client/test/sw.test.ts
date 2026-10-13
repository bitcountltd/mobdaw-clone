import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { buildVersion, precacheList, swPlugin, swSource } from '../swPlugin'
import { swAllowed } from '../src/pwa'

describe('precache list', () => {
  it('keeps the build, index.html first, without maps, dotfiles or the worker itself', () => {
    expect(precacheList([
      'assets/index-abc.js', 'assets/index-abc.js.map', 'sw.js', 'favicon.svg', 'index.html', '.DS_Store',
      'icons/icon-192.png', 'assets/engine-x.wasm', 'manifest.webmanifest', './favicon.svg',
    ])).toEqual(['index.html', 'assets/engine-x.wasm', 'assets/index-abc.js', 'favicon.svg', 'icons/icon-192.png', 'manifest.webmanifest'])
  })

  it('versions by name and contents', () => {
    const f = (path: string, s: string) => ({ path, bytes: new TextEncoder().encode(s) })
    const v = buildVersion([f('index.html', 'a'), f('assets/x.js', 'b')])
    expect(v).toMatch(/^[0-9a-f]{12}$/)
    expect(buildVersion([f('assets/x.js', 'b'), f('index.html', 'a')])).toBe(v) // order does not matter
    expect(buildVersion([f('index.html', 'a!'), f('assets/x.js', 'b')])).not.toBe(v)
    expect(buildVersion([f('index.htm', 'a'), f('assets/x.js', 'b')])).not.toBe(v)
  })
})

describe('the plugin', () => {
  it('writes sw.js into the output with every file of the build', async () => {
    const root = resolve(__dirname, '..')
    const out = await mkdtemp(join(tmpdir(), 'mobdaw-sw-'))
    try {
      await mkdir(join(out, 'assets'))
      await writeFile(join(out, 'index.html'), '<html></html>')
      await writeFile(join(out, 'assets/index-1.js'), 'x')
      await writeFile(join(out, 'assets/index-1.js.map'), '{}')
      await writeFile(join(out, 'manifest.webmanifest'), '{}')
      const p = swPlugin()
      const info = vi.fn()
      ;(p.configResolved as (c: unknown) => void)({ root, build: { outDir: out, minify: false }, logger: { info } })
      await (p.closeBundle as () => Promise<void>)()
      const src = await readFile(join(out, 'sw.js'), 'utf8')
      const m = src.match(/const PRECACHE = (.*);\n/)!
      const manifest = JSON.parse(m[1])
      expect(manifest.files).toEqual(['index.html', 'assets/index-1.js', 'manifest.webmanifest'])
      expect(manifest.version).toMatch(/^[0-9a-f]{12}$/)
      expect(src).not.toMatch(/^\s*(export|import)\b/m) // a classic worker script
      expect(info).toHaveBeenCalledWith(expect.stringContaining('3 files precached'))
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

/** Run the compiled worker against a fake ServiceWorkerGlobalScope at `scope`. */
async function loadWorker(scope: string, files: string[]) {
  const { code } = await transformWithEsbuild(await readFile(resolve(__dirname, '../src/sw.ts'), 'utf8'), 'sw.ts', { format: 'iife' })
  const listeners: Record<string, (e: unknown) => void> = {}
  const g = {
    registration: { scope },
    clients: { claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(async () => {}),
    addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
  }
  // caches: name -> (url -> body); the network: url -> body, or offline
  const stores = new Map<string, Map<string, string>>()
  const net = { offline: false, files: new Map<string, string>(), hits: [] as string[] }
  const key = (r: string | { url: string }) => (typeof r === 'string' ? r : r.url).split('?')[0]
  const caches = {
    open: async (name: string) => {
      const m = stores.get(name) ?? new Map<string, string>()
      stores.set(name, m)
      return {
        match: async (r: string | { url: string }) => (m.has(key(r)) ? new Response(m.get(key(r))) : undefined),
        put: async (r: string | { url: string }, res: Response) => void m.set(key(r), await res.text()),
      }
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  }
  const fetch = async (r: { url: string }) => {
    net.hits.push(r.url)
    if (net.offline) throw new TypeError('Failed to fetch')
    const body = net.files.get(key(r))
    const res = new Response(body ?? 'missing', { status: body == null ? 403 : 200 })
    Object.defineProperty(res, 'type', { value: 'basic' })
    return res
  }
  class Req { url: string; constructor(u: string) { this.url = u } }
  new Function('globalThis', 'caches', 'fetch', 'Request', swSource('v1', files, code).replace(/^const PRECACHE/m, 'var PRECACHE'))(g, caches, fetch, Req)
  const fetchEvent = (url: string, mode = 'cors', method = 'GET') => {
    const e = { request: { url, mode, method }, respondWith: vi.fn(), waitUntil: vi.fn() }
    listeners.fetch(e)
    return e.respondWith.mock.calls.length > 0
  }
  /** The response the worker gives for a request (null: left to the browser). */
  const respond = async (url: string, mode = 'cors') => {
    const e = { request: { url, mode, method: 'GET' }, respondWith: vi.fn(), waitUntil: vi.fn() }
    listeners.fetch(e)
    if (!e.respondWith.mock.calls.length) return null
    return (await e.respondWith.mock.calls[0][0]).text()
  }
  const lifecycle = async (ev: 'install' | 'activate') => {
    let p: Promise<unknown> = Promise.resolve()
    listeners[ev]({ waitUntil: (x: Promise<unknown>) => (p = x) })
    await p
  }
  return { listeners, g, fetchEvent, respond, lifecycle, net, stores }
}

describe('the worker', () => {
  for (const scope of ['https://daw.bitcount.com/', 'https://wrongbad.com/mobdaw/', 'http://localhost:8080/some/folder/']) {
    it(`handles only the site's own files, relative to its scope (${scope})`, async () => {
      const w = await loadWorker(scope, ['index.html', 'assets/a.js', 'favicon.svg'])
      expect(Object.keys(w.listeners).sort()).toEqual(['activate', 'fetch', 'install', 'message'])
      expect(w.fetchEvent(scope, 'navigate')).toBe(true)
      expect(w.fetchEvent(scope + 'index.html#/local/x', 'navigate')).toBe(true)
      expect(w.fetchEvent(scope + 'assets/a.js')).toBe(true)
      expect(w.fetchEvent(scope + 'assets/lazy-chunk.js')).toBe(true) // any hashed asset, precached or not
      expect(w.fetchEvent(scope + 'favicon.svg')).toBe(true)
      expect(w.fetchEvent(scope + 'api/me')).toBe(false) // the cloud server
      expect(w.fetchEvent(scope + 'assets/a.js', 'cors', 'POST')).toBe(false)
      expect(w.fetchEvent('https://elsewhere.example/assets/a.js')).toBe(false)
      expect(w.fetchEvent(new URL('../outside.html', scope).href, 'navigate')).toBe(false)
    })
  }

  it('precaches on install, serves offline, and drops older caches on activate', async () => {
    const scope = 'https://wrongbad.com/mobdaw/'
    const w = await loadWorker(scope, ['index.html', 'assets/a.js'])
    w.stores.set('mobdaw-old', new Map())
    w.stores.set('someone-else', new Map())
    w.net.files.set(scope + 'index.html', 'page v1').set(scope + 'assets/a.js', 'code')
    await w.lifecycle('install')
    await w.lifecycle('activate')
    expect([...w.stores.keys()].sort()).toEqual(['mobdaw-v1', 'someone-else'])
    expect(w.g.clients.claim).toHaveBeenCalled()

    w.net.files.set(scope + 'index.html', 'page v2').set(scope, 'page v2') // ("/" is index.html)
    expect(await w.respond(scope, 'navigate')).toBe('page v2') // online: the network's page (and it is kept)
    w.net.hits.length = 0
    expect(await w.respond(scope + 'assets/a.js')).toBe('code') // cache first: no request
    expect(w.net.hits).toEqual([])
    w.net.offline = true
    expect(await w.respond(scope + '?x=1', 'navigate')).toBe('page v2')
    expect(await w.respond(scope + 'assets/a.js')).toBe('code')
  })

  it('fails the install if a file of the build is missing', async () => {
    const w = await loadWorker('https://daw.bitcount.com/', ['index.html', 'assets/gone.js'])
    w.net.files.set('https://daw.bitcount.com/index.html', 'page')
    await expect(w.lifecycle('install')).rejects.toThrow(/gone\.js: 403/)
  })

  it('takes over only when asked', async () => {
    const w = await loadWorker('https://daw.bitcount.com/', ['index.html'])
    const e = { data: { type: 'nope' }, waitUntil: vi.fn() }
    w.listeners.message(e)
    expect(w.g.skipWaiting).not.toHaveBeenCalled()
    w.listeners.message({ ...e, data: { type: 'skip-waiting' } })
    expect(w.g.skipWaiting).toHaveBeenCalled()
  })
})

describe('registration', () => {
  it('runs only in production builds, on https or localhost', () => {
    expect(swAllowed({ protocol: 'https:', hostname: 'daw.bitcount.com' }, false)).toBe(false)
    // (navigator.serviceWorker does not exist under node: never registers there)
    expect(swAllowed({ protocol: 'https:', hostname: 'daw.bitcount.com' }, true)).toBe('serviceWorker' in (globalThis.navigator ?? {}))
  })
})
