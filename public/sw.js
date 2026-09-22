/*
 * Soundwave service worker: lets the app open without a network. Hand-written, no libraries.
 *
 * The build (tools/sw-precache-plugin.mjs) fills in VERSION (a hash of the build) and PRECACHE
 * (every file of the build, relative to this file). Unbuilt it precaches nothing; the app only
 * registers it in production builds anyway (src/pwa.ts).
 *
 * install   cache the whole build, then take over at once. Safe: the app is one bundle loaded at
 *           start, so an open page never asks for a file of a newer build.
 * activate  delete the caches of older builds, then control the open pages.
 * fetch     same-origin GET requests inside the scope only, everything else passes through.
 *           Page loads: network first (3 s), else the cached app; a fresh copy of the app page is
 *           kept. Other files: cache first, then network (and keep a copy). Range requests,
 *           anything that is not a plain 200 and the test signals under ./dev/ (up to 12 MB
 *           each) are never cached.
 *
 * The cached app page is only ever stored together with every file it loads (script, styles,
 * icons, manifest). A page of a newer build must never sit in the cache without its bundle:
 * offline it would open blank. This covers a new deploy seen by an older worker (a page load
 * updates the cached page) and a CDN still serving the previous page while the worker installs.
 */
'use strict'

const VERSION = '__SW_VERSION__'
const PRECACHE = /*__SW_PRECACHE__*/[]

const PREFIX = 'soundwave-'
const CACHE = PREFIX + VERSION
/** How long a page load waits for the network before the cached app is shown. */
const NAV_TIMEOUT_MS = 3000

const SCOPE = self.registration.scope
const ROOT_URL = new URL('./', self.location.href)
const INDEX_URL = new URL('./index.html', self.location.href)
/** The app page is cached under both names the browser may ask for. */
const APP_URLS = [ROOT_URL.href, INDEX_URL.href]
const DEV_URL = new URL('./dev/', self.location.href).href
const SELF_PATH = new URL(self.location.href).pathname
/**
 * Cache lookups ignore Vary. The page loads its bundle and styles with crossorigin, so those
 * requests carry an Origin header, which the worker's own precache requests do not; a server that
 * sends Vary: Origin (vite preview, some CDNs) would make every lookup miss and the app open blank
 * offline. Only same-origin static files are cached here, so the variants are the same file.
 */
const MATCH = { ignoreVary: true }

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // cache: 'reload' skips the HTTP cache, so the precache never mixes files of two builds.
      await cache.addAll(PRECACHE.map((path) => new Request(new URL(path, self.location.href), { cache: 'reload' })))
      // A CDN can still hand out the previous page for a moment after a deploy. Fetch whatever it
      // loads that this build lacks; if that fails, so does the install (the browser retries later).
      for (const url of APP_URLS) {
        const page = await cache.match(url, MATCH)
        if (page) await cacheAppFiles(cache, await page.text(), url, 'reload')
      }
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  // Chrome quirk: DevTools can send these, and fetch() rejects them for other modes.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
  const url = new URL(request.url)
  if (!inScope(url) || request.headers.has('range')) return
  if (request.mode === 'navigate') onNavigate(event, url)
  else event.respondWith(cacheFirst(event))
})

/** Same origin, inside the scope, not a test signal under ./dev/ and not this worker's script. */
function inScope(url) {
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return false
  return !url.href.startsWith(DEV_URL) && url.pathname !== SELF_PATH
}

function isAppPage(url) {
  return url.pathname === ROOT_URL.pathname || url.pathname === INDEX_URL.pathname
}

/** Page loads: network first, the cached app when offline or slow; keeps the cached app fresh. */
function onNavigate(event, url) {
  const isApp = isAppPage(url)
  const network = fetch(event.request)
  // Registered before the page gets the response, so the copy is taken before its body is read.
  event.waitUntil(
    network.then(
      (response) => (isApp && cacheable(response) ? saveApp(response.clone(), url.href) : undefined),
      () => undefined,
    ),
  )
  event.respondWith(navigationResponse(network, event.request, isApp))
}

async function navigationResponse(network, request, isApp) {
  let timer = 0
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, NAV_TIMEOUT_MS, null)
  })
  try {
    const response = await Promise.race([network, timeout])
    // A server error on the app page: the cached app is more useful than an error page.
    if (response && !(isApp && response.status >= 500)) return response
  } catch {
    // Offline or a network error: fall back to the cache below.
  } finally {
    clearTimeout(timer)
  }
  const cached = (await fromCache(request)) ?? (await fromCache(ROOT_URL.href)) ?? (await fromCache(INDEX_URL.href))
  if (cached) return navigable(cached)
  // Nothing cached (storage evicted): keep waiting for the network, or fail like the browser would.
  return network
}

/** Other files: cache first, then network; keeps a copy of what the network returned. */
async function cacheFirst(event) {
  const request = event.request
  const cached = await fromCache(request)
  if (cached) return cached
  const response = await fetch(request)
  if (cacheable(response)) event.waitUntil(save(request, response.clone()))
  return response
}

/** Only complete, same-origin, non-redirected 200 responses the server allows to be stored. */
function cacheable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic' || response.redirected) return false
  return !/no-store/i.test(response.headers.get('cache-control') ?? '')
}

async function fromCache(key) {
  try {
    // caches.match, not caches.open: looking something up must not create the cache.
    return (await caches.match(key, { ...MATCH, cacheName: CACHE })) ?? null
  } catch {
    return null
  }
}

/**
 * This worker's cache, or null once it is gone. Only install creates it. Never bring back one that
 * was deleted: a newer build took over, or ?nosw cleared it while this worker still controlled
 * the page.
 */
async function openCache() {
  return (await caches.has(CACHE)) ? caches.open(CACHE) : null
}

async function save(key, response) {
  try {
    const cache = await openCache()
    if (cache) await cache.put(key, response)
  } catch {
    // Quota, Vary: * or storage turned off: the page still got the network response.
  }
}

/**
 * Keeps the cached app page up to date with a page load from the network. A different page is a
 * newer build: its files are cached first, and if any of them cannot be, the cached app stays as
 * it was (older, but complete).
 */
async function saveApp(response, pageUrl) {
  try {
    const cache = await openCache()
    if (!cache) return
    const html = await response.text()
    const current = await cache.match(ROOT_URL.href, MATCH)
    if (current && (await current.text()) === html) return
    await cacheAppFiles(cache, html, pageUrl, 'default')
    // A plain copy: no URL of its own (the page may have been ./?debug), and no length or encoding
    // of the compressed body it was read from.
    const headers = new Headers(response.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    for (const url of APP_URLS) await cache.put(url, new Response(html, { status: 200, headers }))
  } catch {
    // Offline again, quota or storage turned off: the cached app is left as it was.
  }
}

/**
 * Caches every file the app page loads that is not cached yet. Throws when one cannot be fetched
 * or stored, so a page is never kept without the files it needs.
 */
async function cacheAppFiles(cache, html, pageUrl, mode) {
  const missing = []
  for (const url of pageFiles(html, pageUrl)) if (!(await cache.match(url, MATCH))) missing.push(url)
  const responses = await Promise.all(missing.map((url) => fetch(new Request(url, { cache: mode }))))
  const failed = missing.find((_, i) => !cacheable(responses[i]))
  if (failed) throw new Error('Soundwave offline: cannot cache ' + failed)
  for (const [i, url] of missing.entries()) await cache.put(url, responses[i])
}

const TAG_RE = /<(script|link|img)\b([^>]*)>/gi
const ATTR_RE = {
  src: /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  href: /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
}

/**
 * The files an app page loads, as absolute URLs: <script src>, <link href> (styles, icons, the
 * manifest, module preloads) and <img src>, same scope only. Links to pages (<a href>) and the app
 * page itself are not files it loads.
 */
function pageFiles(html, pageUrl) {
  const urls = new Set()
  for (const [, tag, attrs] of html.matchAll(TAG_RE)) {
    const match = ATTR_RE[tag.toLowerCase() === 'link' ? 'href' : 'src'].exec(attrs)
    if (!match) continue
    let url
    try {
      url = new URL((match[1] ?? match[2] ?? match[3]).replaceAll('&amp;', '&'), pageUrl)
    } catch {
      continue
    }
    url.hash = ''
    if (inScope(url) && !isAppPage(url)) urls.add(url.href)
  }
  return [...urls]
}

/** A page load must not be answered with a redirected response (Chrome rejects it). */
function navigable(response) {
  if (!response.redirected) return response
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
