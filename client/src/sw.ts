// The service worker: makes the static build installable and usable offline (docs/redesign.md §1, deploy/aws).
//
// Built by `swPlugin` (client/swPlugin.ts) into `sw.js` at the root of the site, with PRECACHE (the build's version
// and file list) prepended. Everything is addressed relative to the worker's scope, so the same file works at `/`,
// `/mobdaw/` and from a relative (`./`) build in any folder.
//
//   - install:  fetch every file of the build into a cache named after the build's version (`mobdaw-<version>`)
//   - activate: delete the caches of older builds
//   - assets/*  (content-hashed, immutable): cache first, then the network (and keep what it returns)
//   - pages     (navigations, index.html): network first, so a deploy shows up at once; offline, the cached index.html
//   - other files of the build (icons, manifest): network first, cached copy offline
//   - anything else (the cloud build's /api and /collab, other origins): not touched
//
// A new build waits until the page asks it to take over (`{ type: 'skip-waiting' }`, from the "update available"
// toast in src/pwa.ts); the page then reloads once the new worker controls it.

/** Injected by the build: `{ version, files }`, files relative to the scope (`index.html`, `assets/…`). */
declare const PRECACHE: { version: string; files: string[] }

// The worker's global scope, as far as this file uses it (the client's tsconfig has the DOM lib, not WebWorker).
type ExtendableEvent = Event & { waitUntil(p: Promise<unknown>): void }
type FetchEvent = ExtendableEvent & { request: Request; respondWith(r: Response | Promise<Response>): void }
type MessageEv = ExtendableEvent & { data: unknown }
type WorkerScope = {
  registration: { scope: string }
  clients: { claim(): Promise<void> }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void
  addEventListener(type: 'message', fn: (e: MessageEv) => void): void
}
const sw = globalThis as unknown as WorkerScope
export {} // (a module for the type checker; the build wraps it in a function)

const PREFIX = 'mobdaw-'
const CACHE = PREFIX + PRECACHE.version
const scope = sw.registration.scope // ends with '/'
const url = (path: string) => new URL(path, scope).href
const INDEX = url('index.html')
const ASSETS = url('assets/')
const files = new Set(PRECACHE.files.map(url))

sw.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // Hashed assets may come from the HTTP cache (they never change); root files must be the current ones.
    await Promise.all([...files].map(async (u) => {
      const res = await fetch(new Request(u, { cache: u.startsWith(ASSETS) ? 'default' : 'no-cache' }))
      if (!res.ok) throw new Error(`precache ${u}: ${res.status}`)
      await cache.put(u, res)
    }))
  })())
})

sw.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key)
    await sw.clients.claim()
  })())
})

sw.addEventListener('message', (e) => {
  if ((e.data as { type?: string } | null)?.type === 'skip-waiting') e.waitUntil(sw.skipWaiting())
})

/** The page itself: the scope's root or index.html, whatever the query or hash. */
const isPage = (req: Request, u: URL) => req.mode === 'navigate' || u.href.split(/[?#]/)[0] === INDEX

async function cacheFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(req, { ignoreSearch: true })
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok && res.type === 'basic') await cache.put(req, res.clone())
  return res
}

async function networkFirst(req: Request, key: string): Promise<Response> {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(req)
    if (res.ok && res.type === 'basic') await cache.put(key, res.clone())
    return res
  } catch (err) {
    const hit = await cache.match(key)
    if (hit) return hit
    throw err
  }
}

sw.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const u = new URL(req.url)
  if (!u.href.startsWith(scope)) return // other origins, and paths outside the site
  if (isPage(req, u)) {
    // only the app's own page: a navigation to some other path under the scope is left to the network
    const path = u.href.slice(scope.length).split(/[?#]/)[0]
    if (path === '' || path === 'index.html') e.respondWith(networkFirst(req, INDEX))
    return
  }
  if (u.href.startsWith(ASSETS)) return e.respondWith(cacheFirst(req))
  const key = u.href.split(/[?#]/)[0]
  if (files.has(key)) e.respondWith(networkFirst(req, key))
})
