import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isPrecached,
  pathToUrl,
  PRECACHE_PLACEHOLDER,
  precacheList,
  swSource,
  swVersion,
  VERSION_PLACEHOLDER,
  writeServiceWorker,
} from './sw-precache-plugin.mjs'
import { registerServiceWorker } from '../src/pwa.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8')

const BUILD = [
  'index.html',
  'assets/index-UxU99mFv.js',
  'assets/index-UxU99mFv.js.map',
  'assets/index-BV8QEjSF.css',
  'favicon.svg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'sw.js',
  'dev/walk-10s.wav',
  'dev/tone-2k.wav',
  '.nojekyll',
  '.vite/manifest.json',
]

describe('precacheList', () => {
  const list = precacheList(BUILD)

  it('lists the app page and its files', () => {
    expect(list).toEqual([
      './',
      'assets/index-BV8QEjSF.css',
      'assets/index-UxU99mFv.js',
      'favicon.svg',
      'icons/icon-192.png',
      'icons/icon-512.png',
      'index.html',
      'manifest.webmanifest',
    ])
  })

  it('leaves out the worker, source maps, dotfiles and the test signals under dev/', () => {
    expect(list).not.toContain('sw.js')
    expect(list.some((url) => url.endsWith('.map'))).toBe(false)
    expect(list.some((url) => url.startsWith('dev/'))).toBe(false)
    expect(list.some((url) => url.split('/').some((s) => s.startsWith('.') && s !== '.'))).toBe(false)
    for (const path of ['sw.js', 'a/b.js.map', 'dev/x.wav', 'dev', '.nojekyll', 'x/.hidden/y.js']) expect(isPrecached(path)).toBe(false)
    // Only the top-level dev/ is excluded; a nested folder of that name is an ordinary asset folder.
    expect(isPrecached('assets/dev/x.js')).toBe(true)
  })

  it('has a stable order whatever order the files were found in', () => {
    expect(precacheList([...BUILD].reverse())).toEqual(list)
    expect(precacheList([...BUILD].sort())).toEqual(list)
    expect(list[0]).toBe('./')
  })

  it('accepts Windows separators and drops duplicates', () => {
    expect(precacheList(['icons\\icon-192.png', 'icons/icon-192.png', './index.html', 'index.html'])).toEqual([
      './',
      'icons/icon-192.png',
      'index.html',
    ])
  })

  it('has no app page entry without an index.html', () => {
    expect(precacheList(['a.js'])).toEqual(['a.js'])
    expect(precacheList([])).toEqual([])
  })

  it('encodes names the way the browser requests them', () => {
    expect(pathToUrl('assets/a b.js')).toBe('assets/a%20b.js')
    expect(pathToUrl('assets/x#1?.js')).toBe('assets/x%231%3F.js')
    expect(pathToUrl('assets/icon@2x.png')).toBe('assets/icon@2x.png')
  })
})

describe('swVersion', () => {
  const files = [
    ['index.html', '<html></html>'],
    ['assets/app.js', Buffer.from('console.log(1)')],
  ]

  it('is 12 hex characters and ignores the order of the files', () => {
    const v = swVersion(files)
    expect(v).toMatch(/^[0-9a-f]{12}$/)
    expect(swVersion([...files].reverse())).toBe(v)
  })

  it("changes when a file's content changes", () => {
    expect(swVersion([files[0], ['assets/app.js', 'console.log(2)']])).not.toBe(swVersion(files))
  })

  it('changes when a file is renamed, added or removed', () => {
    const v = swVersion(files)
    expect(swVersion([files[0], ['assets/app2.js', 'console.log(1)']])).not.toBe(v)
    expect(swVersion([...files, ['favicon.svg', '<svg/>']])).not.toBe(v)
    expect(swVersion([files[0]])).not.toBe(v)
  })

  it('does not confuse where one file ends and the next starts', () => {
    expect(swVersion([['a', 'bc'], ['d', '']])).not.toBe(swVersion([['a', 'b'], ['d', 'c']]))
  })
})

describe('swSource', () => {
  const list = precacheList(BUILD)
  const source = swSource(TEMPLATE, list, 'abcdef012345')

  it('replaces both placeholders exactly once', () => {
    expect(TEMPLATE.split(VERSION_PLACEHOLDER)).toHaveLength(2)
    expect(TEMPLATE.split(PRECACHE_PLACEHOLDER)).toHaveLength(2)
    expect(source).not.toContain('__SW_VERSION__')
    expect(source).not.toContain('__SW_PRECACHE__')
    expect(source).toContain(`const VERSION = "abcdef012345"`)
    expect(source).toContain(`const PRECACHE = ${JSON.stringify(list)}`)
  })

  it('is valid JavaScript, as is the unbuilt template', () => {
    expect(() => new vm.Script(source, { filename: 'sw.js' })).not.toThrow()
    expect(() => new vm.Script(TEMPLATE, { filename: 'sw.js' })).not.toThrow()
  })

  it('fails loudly when a placeholder is missing or doubled', () => {
    expect(() => swSource(TEMPLATE.replace(VERSION_PLACEHOLDER, "'x'"), list, 'v')).toThrow(/__SW_VERSION__/)
    expect(() => swSource(TEMPLATE.replace(PRECACHE_PLACEHOLDER, '[]'), list, 'v')).toThrow(/__SW_PRECACHE__/)
    expect(() => swSource(`${TEMPLATE}\n${VERSION_PLACEHOLDER}`, list, 'v')).toThrow(/2 times/)
  })

  it('does not treat $ patterns in file names as replacement patterns', () => {
    const out = swSource(TEMPLATE, ["a$&b$'c.js"], 'v')
    expect(out).toContain(`const PRECACHE = ["a$&b$'c.js"]`)
  })
})

describe('writeServiceWorker', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  function makeBuild(files) {
    dir = mkdtempSync(join(tmpdir(), 'sw-precache-'))
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
  }

  it('writes sw.js with the list of the output directory and a version that follows the content', () => {
    makeBuild({
      'index.html': '<html></html>',
      'assets/app-1.js': 'console.log(1)',
      'assets/app-1.js.map': '{}',
      'dev/walk.wav': 'RIFF',
      'sw.js': TEMPLATE,
    })
    const first = writeServiceWorker({ outDir: dir, template: TEMPLATE })
    expect(first.list).toEqual(['./', 'assets/app-1.js', 'index.html'])
    const written = readFileSync(join(dir, 'sw.js'), 'utf8')
    expect(written).toContain(`const VERSION = "${first.version}"`)
    expect(written).toContain(`const PRECACHE = ["./","assets/app-1.js","index.html"]`)

    // Running it again over its own output gives the same version (sw.js is not part of it).
    expect(writeServiceWorker({ outDir: dir, template: TEMPLATE }).version).toBe(first.version)

    writeFileSync(join(dir, 'index.html'), '<html>changed</html>')
    expect(writeServiceWorker({ outDir: dir, template: TEMPLATE }).version).not.toBe(first.version)
  })
})

// ---- The worker itself, run in a sandbox with a fake Cache API --------------------------------

const ORIGIN = 'https://app.test'
const SCOPE = `${ORIGIN}/Soundwave-/`

function response(body, { status = 200, type = 'basic', redirected = false, headers = {} } = {}) {
  const r = new Response(body, { status, headers })
  Object.defineProperty(r, 'type', { value: type })
  Object.defineProperty(r, 'redirected', { value: redirected })
  return r
}

function copy(r) {
  const c = r.clone()
  Object.defineProperty(c, 'redirected', { value: r.redirected })
  return c
}

const keyOf = (req) => new URL(typeof req === 'string' ? req : req instanceof URL ? req.href : req.url).href

const headersOf = (req) => (typeof req === 'string' || req instanceof URL ? new Headers() : req.headers)

class FakeCache {
  constructor(fetchFn) {
    this.entries = new Map()
    this.requestHeaders = new Map()
    this.fetch = fetchFn
  }
  async match(req, { ignoreVary = false } = {}) {
    const key = keyOf(req)
    const hit = this.entries.get(key)
    if (!hit) return undefined
    // Vary as the Cache API applies it: each named header must be the same as the stored request's.
    if (!ignoreVary) {
      const stored = this.requestHeaders.get(key) ?? new Headers()
      const names = (hit.headers.get('vary') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      if (names.some((name) => name === '*' || stored.get(name) !== headersOf(req).get(name))) return undefined
    }
    return copy(hit)
  }
  async put(req, res) {
    await res.clone().arrayBuffer()
    this.entries.set(keyOf(req), res)
    this.requestHeaders.set(keyOf(req), headersOf(req))
  }
  async addAll(requests) {
    const responses = await Promise.all(requests.map((req) => this.fetch(req)))
    requests.forEach((req, i) => {
      this.entries.set(keyOf(req), responses[i])
      this.requestHeaders.set(keyOf(req), headersOf(req))
    })
  }
}

/** Loads the built worker into a sandbox. routes: url -> () => Response | Promise (or throws). */
function loadWorker({ list = ['./', 'index.html', 'assets/app.js'], version = 'v2', routes: initial = {} } = {}) {
  const routes = new Map(Object.entries(initial))
  const fetched = []
  const fetchFn = async (req) => {
    fetched.push({ url: keyOf(req), cache: req.cache })
    const route = routes.get(keyOf(req))
    if (!route) throw new TypeError('Failed to fetch')
    return route()
  }
  const stores = new Map()
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new FakeCache(fetchFn))
      return stores.get(name)
    },
    async has(name) {
      return stores.has(name)
    },
    async match(req, { cacheName, ...options } = {}) {
      const store = stores.get(cacheName)
      return store ? store.match(req, options) : undefined
    },
    async keys() {
      return [...stores.keys()]
    },
    async delete(name) {
      return stores.delete(name)
    },
  }
  const handlers = {}
  const calls = { skipWaiting: 0, claim: 0, timeouts: [] }
  const sandbox = {
    location: new URL(`${SCOPE}sw.js`),
    registration: { scope: SCOPE },
    addEventListener: (type, fn) => (handlers[type] = fn),
    skipWaiting: async () => void calls.skipWaiting++,
    clients: { claim: async () => void calls.claim++ },
    caches,
    fetch: fetchFn,
    Request,
    Headers,
    Response,
    URL,
    // The navigation timeout, 1000 times faster.
    setTimeout: (fn, ms, ...args) => {
      calls.timeouts.push(ms)
      return setTimeout(fn, ms / 1000, ...args)
    },
    clearTimeout,
  }
  sandbox.self = sandbox
  vm.runInNewContext(swSource(TEMPLATE, list, version), sandbox, { filename: 'sw.js' })

  function dispatch(type, request) {
    const event = {
      request,
      response: null,
      waits: [],
      respondWith(p) {
        this.response = Promise.resolve(p)
      },
      waitUntil(p) {
        this.waits.push(p)
      },
    }
    handlers[type](event)
    return event
  }
  const settle = async (event) => {
    const res = event.response ? await event.response : null
    await Promise.all(event.waits)
    return res
  }
  return { handlers, caches, stores, routes, fetched, calls, dispatch, settle, cacheName: `soundwave-${version}` }
}

const req = (url, { method = 'GET', mode = 'cors', headers = {} } = {}) => ({
  url: new URL(url, SCOPE).href,
  method,
  mode,
  cache: 'default',
  headers: new Headers(headers),
})

async function installed(options) {
  const sw = loadWorker(options)
  await sw.settle(sw.dispatch('install'))
  return sw
}

const appRoutes = (html = '<html>app</html>') => ({
  [SCOPE]: () => response(html),
  [`${SCOPE}index.html`]: () => response(html),
  [`${SCOPE}assets/app.js`]: () => response('console.log(1)'),
})

describe('sw.js', () => {
  it('install: precaches every listed file relative to itself, bypassing the HTTP cache, then takes over', async () => {
    const sw = await installed({ routes: appRoutes() })
    expect(sw.fetched).toEqual([
      { url: SCOPE, cache: 'reload' },
      { url: `${SCOPE}index.html`, cache: 'reload' },
      { url: `${SCOPE}assets/app.js`, cache: 'reload' },
    ])
    expect([...sw.stores.get(sw.cacheName).entries.keys()]).toHaveLength(3)
    expect(sw.calls.skipWaiting).toBe(1)
  })

  it('install: does not take over when a file fails to download', async () => {
    const sw = loadWorker({ routes: { [SCOPE]: () => response('x') } })
    await expect(sw.settle(sw.dispatch('install'))).rejects.toThrow()
    expect(sw.calls.skipWaiting).toBe(0)
  })

  it("activate: deletes older soundwave caches only, then claims the pages", async () => {
    const sw = loadWorker()
    for (const name of ['soundwave-v1', 'soundwave-v2', 'other-app']) await sw.caches.open(name)
    await sw.settle(sw.dispatch('activate'))
    expect(await sw.caches.keys()).toEqual(['soundwave-v2', 'other-app'])
    expect(sw.calls.claim).toBe(1)
  })

  it('fetch: leaves other methods, origins, folders, test signals and range requests alone', async () => {
    const sw = await installed({ routes: appRoutes() })
    const untouched = [
      req('assets/app.js', { method: 'POST' }),
      req('https://cdn.example/x.js'),
      req(`${ORIGIN}/other-project/app.js`),
      req('dev/walk-10s.wav'),
      req('dev/walk-10s.wav', { mode: 'navigate' }),
      req('assets/app.js', { headers: { range: 'bytes=0-99' } }),
      req('sw.js'),
    ]
    for (const r of untouched) expect(sw.dispatch('fetch', r).response).toBeNull()
  })

  it('navigation offline: the cached app, also with a query string', async () => {
    const sw = await installed({ routes: appRoutes() })
    sw.routes.clear()
    for (const url of ['./', './?debug', './index.html', './somewhere']) {
      const res = await sw.settle(sw.dispatch('fetch', req(url, { mode: 'navigate' })))
      expect(await res.text()).toBe('<html>app</html>')
    }
  })

  it('navigation online: the network response, and the cached app is updated', async () => {
    const sw = await installed({ routes: appRoutes() })
    sw.routes.set(`${SCOPE}?debug`, () => response('<html>new</html>'))
    const res = await sw.settle(sw.dispatch('fetch', req('./?debug', { mode: 'navigate' })))
    expect(await res.text()).toBe('<html>new</html>')
    const cache = sw.stores.get(sw.cacheName)
    expect(await (await cache.match(SCOPE)).text()).toBe('<html>new</html>')
    expect(await (await cache.match(`${SCOPE}index.html`)).text()).toBe('<html>new</html>')
  })

  it('navigation slow: the cached app after the timeout, and the late response still updates it', async () => {
    const sw = await installed({ routes: appRoutes() })
    let release
    sw.routes.set(SCOPE, () => new Promise((r) => (release = () => r(response('<html>late</html>')))))
    const event = sw.dispatch('fetch', req('./', { mode: 'navigate' }))
    expect(await (await event.response).text()).toBe('<html>app</html>')
    expect(sw.calls.timeouts).toContain(3000)
    release()
    await Promise.all(event.waits)
    expect(await (await sw.stores.get(sw.cacheName).match(SCOPE)).text()).toBe('<html>late</html>')
  })

  it('navigation: a server error on the app page falls back to the cached app; other pages keep their status', async () => {
    const sw = await installed({ routes: appRoutes() })
    sw.routes.set(SCOPE, () => response('down', { status: 503 }))
    sw.routes.set(`${SCOPE}nope`, () => response('not found', { status: 404 }))
    expect(await (await sw.settle(sw.dispatch('fetch', req('./', { mode: 'navigate' })))).text()).toBe('<html>app</html>')
    expect((await sw.settle(sw.dispatch('fetch', req('./nope', { mode: 'navigate' })))).status).toBe(404)
    // The error page did not replace the cached app.
    expect(await (await sw.stores.get(sw.cacheName).match(SCOPE)).text()).toBe('<html>app</html>')
  })

  it('navigation: never answers with a redirected response', async () => {
    const sw = loadWorker({
      routes: {
        [SCOPE]: () => response('<html>app</html>', { redirected: true }),
        [`${SCOPE}index.html`]: () => response('<html>app</html>'),
        [`${SCOPE}assets/app.js`]: () => response('x'),
      },
    })
    await sw.settle(sw.dispatch('install'))
    sw.routes.clear()
    const res = await sw.settle(sw.dispatch('fetch', req('./', { mode: 'navigate' })))
    expect(res.redirected).toBe(false)
    expect(await res.text()).toBe('<html>app</html>')
  })

  it('files: cache first, then network, keeping only plain 200 responses', async () => {
    const sw = await installed({ routes: appRoutes() })
    const routes = sw.routes
    routes.clear()
    const hit = await sw.settle(sw.dispatch('fetch', req('assets/app.js')))
    expect(await hit.text()).toBe('console.log(1)')
    expect(sw.fetched.filter((f) => f.cache !== 'reload')).toEqual([])

    const extra = {
      'late.js': () => response('late'),
      'partial.js': () => response('p', { status: 206 }),
      'opaque.js': () => response('o', { type: 'opaque' }),
      'moved.js': () => response('m', { redirected: true }),
      'private.js': () => response('s', { headers: { 'cache-control': 'no-store' } }),
      'missing.js': () => response('404', { status: 404 }),
    }
    for (const [name, fn] of Object.entries(extra)) routes.set(`${SCOPE}${name}`, fn)
    for (const name of Object.keys(extra)) await sw.settle(sw.dispatch('fetch', req(name)))
    const cached = [...sw.stores.get(sw.cacheName).entries.keys()].map((k) => k.slice(SCOPE.length))
    expect(cached).toContain('late.js')
    for (const name of ['partial.js', 'opaque.js', 'moved.js', 'private.js', 'missing.js']) expect(cached).not.toContain(name)

    // Offline now: the runtime-cached file still loads.
    routes.clear()
    expect(await (await sw.settle(sw.dispatch('fetch', req('late.js')))).text()).toBe('late')
  })

  it('offline, serves crossorigin requests (they carry Origin) even when the server sends Vary: Origin', async () => {
    const vary = { headers: { vary: 'Origin' } }
    const sw = await installed({
      routes: {
        [SCOPE]: () => response('<html>app</html>', vary),
        [`${SCOPE}index.html`]: () => response('<html>app</html>', vary),
        [`${SCOPE}assets/app.js`]: () => response('console.log(1)', vary),
      },
    })
    sw.routes.set(`${SCOPE}late.js`, () => response('late', vary))
    await sw.settle(sw.dispatch('fetch', req('late.js')))
    sw.routes.clear()
    const crossorigin = { headers: { origin: ORIGIN } }
    expect(await (await sw.settle(sw.dispatch('fetch', req('assets/app.js', crossorigin)))).text()).toBe('console.log(1)')
    expect(await (await sw.settle(sw.dispatch('fetch', req('late.js', crossorigin)))).text()).toBe('late')
    expect(await (await sw.settle(sw.dispatch('fetch', req('./', { mode: 'navigate' })))).text()).toBe('<html>app</html>')
  })

  it('never brings back its cache once it was deleted (a newer build took over, or ?nosw)', async () => {
    const sw = await installed({ routes: appRoutes() })
    await sw.caches.delete(sw.cacheName)
    const nav = await sw.settle(sw.dispatch('fetch', req('./', { mode: 'navigate' })))
    const file = await sw.settle(sw.dispatch('fetch', req('assets/app.js')))
    expect(await nav.text()).toBe('<html>app</html>')
    expect(await file.text()).toBe('console.log(1)')
    expect(await sw.caches.keys()).toEqual([])
  })
})

describe('sw.js: the cached app page is never stored without the files it loads', () => {
  const page = (js) =>
    '<!doctype html><link rel="icon" href="./favicon.svg" /><link rel="stylesheet" crossorigin href="./assets/app.css">' +
    `<script type="module" crossorigin src="./${js}"></script><a href="./?debug">debug</a>`
  const build1 = () => ({
    list: ['./', 'assets/app-1.js', 'assets/app.css', 'favicon.svg', 'index.html'],
    routes: {
      [SCOPE]: () => response(page('assets/app-1.js')),
      [`${SCOPE}index.html`]: () => response(page('assets/app-1.js')),
      [`${SCOPE}assets/app-1.js`]: () => response('build 1'),
      [`${SCOPE}assets/app.css`]: () => response('body{}'),
      [`${SCOPE}favicon.svg`]: () => response('<svg/>'),
    },
  })
  /** A newer build is on the server: a new page that loads a new bundle. */
  const deploy2 = (sw) => {
    sw.routes.set(SCOPE, () => response(page('assets/app-2.js')))
    sw.routes.set(`${SCOPE}?debug`, () => response(page('assets/app-2.js')))
    sw.routes.set(`${SCOPE}assets/app-2.js`, () => response('build 2'))
  }
  /** Opens the app with the network gone: the page, then the bundle it loads (rejects if missing). */
  async function openOffline(sw, url = './') {
    sw.routes.clear()
    const html = await (await sw.settle(sw.dispatch('fetch', req(url, { mode: 'navigate' })))).text()
    const src = html.match(/<script[^>]*src="([^"]+)"/)[1]
    const js = await sw.settle(sw.dispatch('fetch', req(src)))
    return { src, js: await js.text() }
  }

  it('install: a page and its files from the same build need no extra requests', async () => {
    const sw = await installed(build1())
    expect(sw.fetched).toHaveLength(5)
    expect(await openOffline(sw)).toEqual({ src: './assets/app-1.js', js: 'build 1' })
  })

  it('a new build seen by the old worker: its page is cached together with its bundle', async () => {
    const sw = await installed(build1())
    deploy2(sw)
    const res = await sw.settle(sw.dispatch('fetch', req('./?debug', { mode: 'navigate' })))
    expect(await res.text()).toBe(page('assets/app-2.js'))
    expect(sw.fetched.at(-1)).toEqual({ url: `${SCOPE}assets/app-2.js`, cache: 'default' })
    expect(await openOffline(sw)).toEqual({ src: './assets/app-2.js', js: 'build 2' })
    expect(await openOffline(sw, './index.html')).toEqual({ src: './assets/app-2.js', js: 'build 2' })
  })

  it('a slow page load: the late page of a new build is cached only with its bundle', async () => {
    const sw = await installed(build1())
    deploy2(sw)
    let release
    sw.routes.set(SCOPE, () => new Promise((r) => (release = () => r(response(page('assets/app-2.js'))))))
    const event = sw.dispatch('fetch', req('./', { mode: 'navigate' }))
    expect(await (await event.response).text()).toBe(page('assets/app-1.js'))
    release()
    await Promise.all(event.waits)
    expect(await openOffline(sw)).toEqual({ src: './assets/app-2.js', js: 'build 2' })
  })

  it('a new page whose bundle cannot be fetched leaves the cached app as it was', async () => {
    for (const bundle of [null, () => response('gone', { status: 404 }), () => response('x', { headers: { 'cache-control': 'no-store' } })]) {
      const sw = await installed(build1())
      deploy2(sw)
      if (bundle) sw.routes.set(`${SCOPE}assets/app-2.js`, bundle)
      else sw.routes.delete(`${SCOPE}assets/app-2.js`)
      await sw.settle(sw.dispatch('fetch', req('./', { mode: 'navigate' })))
      expect(await openOffline(sw)).toEqual({ src: './assets/app-1.js', js: 'build 1' })
      expect(await openOffline(sw, './index.html')).toEqual({ src: './assets/app-1.js', js: 'build 1' })
    }
  })

  it('an unchanged page is not stored again and loads nothing extra', async () => {
    const sw = await installed(build1())
    const stored = sw.stores.get(sw.cacheName).entries.get(SCOPE)
    const before = sw.fetched.length
    await sw.settle(sw.dispatch('fetch', req('./', { mode: 'navigate' })))
    expect(sw.fetched.length).toBe(before + 1)
    expect(sw.stores.get(sw.cacheName).entries.get(SCOPE)).toBe(stored)
  })

  it('install: a page from another build (a CDN still serving it) gets its files too, or the install fails', async () => {
    const stale = build1()
    stale.routes[SCOPE] = () => response(page('assets/app-0.js'))
    stale.routes[`${SCOPE}assets/app-0.js`] = () => response('build 0')
    const sw = await installed(stale)
    expect(sw.fetched.at(-1)).toEqual({ url: `${SCOPE}assets/app-0.js`, cache: 'reload' })
    expect(await openOffline(sw)).toEqual({ src: './assets/app-0.js', js: 'build 0' })
    expect(sw.calls.skipWaiting).toBe(1)

    delete stale.routes[`${SCOPE}assets/app-0.js`]
    const broken = loadWorker(stale)
    await expect(broken.settle(broken.dispatch('install'))).rejects.toThrow()
    expect(broken.calls.skipWaiting).toBe(0)
  })

  it('counts only files the page loads, inside the scope, and not test signals, the worker or the page itself', async () => {
    const html = [
      '<script>console.log("inline")</script>',
      "<script src='./assets/single.js'></script>",
      '<img alt="" src=./img/unquoted.png>',
      '<link rel="manifest" href="./manifest.webmanifest?v=1&amp;x=2#top">',
      '<SCRIPT TYPE="module" SRC="./assets/UPPER.js"></SCRIPT>',
      '<img data-src="./img/lazy.png" alt="">',
      '<link rel="canonical" href="./">',
      '<link rel="alternate" href="./index.html?x">',
      '<link rel="preconnect" href="https://fonts.example/">',
      '<link rel="icon" href="/other-project/icon.png">',
      '<script src="./dev/tone-2k.wav"></script>',
      '<script src="./sw.js"></script>',
      '<a href="./help.html">help</a>',
    ].join('\n')
    const expected = ['assets/single.js', 'img/unquoted.png', 'manifest.webmanifest?v=1&x=2', 'assets/UPPER.js'].map((p) => `${SCOPE}${p}`)
    const routes = { [SCOPE]: () => response(html), [`${SCOPE}index.html`]: () => response(html) }
    for (const url of expected) routes[url] = () => response('file')
    const sw = await installed({ list: ['./', 'index.html'], routes })
    expect(sw.fetched.slice(2).map((f) => f.url).sort()).toEqual([...expected].sort())
  })
})

describe('registerServiceWorker (src/pwa.ts)', () => {
  const APP = 'https://maty3k.github.io/Soundwave-/'

  function setup({ prod = true, search = '', secure = true, readyState = 'loading', supported = true, register } = {}) {
    vi.stubEnv('PROD', prod)
    const calls = { register: [], unregistered: [], deleted: [], load: null }
    const registrations = [APP, 'https://maty3k.github.io/other-project/'].map((scope) => ({
      scope,
      unregister: async () => void calls.unregistered.push(scope),
    }))
    const serviceWorker = {
      register: register ?? (async (url) => void calls.register.push(url)),
      getRegistrations: async () => registrations,
    }
    vi.stubGlobal('navigator', supported ? { serviceWorker } : {})
    vi.stubGlobal('document', { readyState })
    vi.stubGlobal('caches', {
      keys: async () => ['soundwave-aaa', 'soundwave-bbb', 'other-app'],
      delete: async (name) => void calls.deleted.push(name),
    })
    vi.stubGlobal('window', {
      isSecureContext: secure,
      location: new URL(`${APP}${search}`),
      caches: globalThis.caches,
      addEventListener: (type, fn) => {
        if (type === 'load') calls.load = fn
      },
    })
    return calls
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('production: registers ./sw.js (relative, so the scope is the app folder) once the page has loaded', () => {
    const calls = setup()
    registerServiceWorker()
    expect(calls.register).toEqual([])
    calls.load()
    expect(calls.register).toEqual(['./sw.js'])
  })

  it('registers at once when the page has already loaded', () => {
    const calls = setup({ readyState: 'complete' })
    registerServiceWorker()
    expect(calls.register).toEqual(['./sw.js'])
  })

  it('never in dev, outside a secure context or without service workers', () => {
    for (const options of [{ prod: false }, { secure: false }, { supported: false }]) {
      const calls = setup({ ...options, readyState: 'complete' })
      registerServiceWorker()
      expect(calls.register).toEqual([])
      expect(calls.load).toBeNull()
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it('swallows registration errors, rejected or thrown', async () => {
    for (const register of [async () => Promise.reject(new Error('SecurityError')), () => { throw new Error('SecurityError') }]) {
      setup({ readyState: 'complete', register })
      expect(() => registerServiceWorker()).not.toThrow()
      await new Promise((r) => setTimeout(r, 0))
    }
  })

  it('?nosw: removes only this folder\'s worker and the Soundwave caches, and registers nothing (dev too)', async () => {
    for (const prod of [true, false]) {
      const calls = setup({ prod, search: '?nosw', readyState: 'complete' })
      registerServiceWorker()
      await vi.waitFor(() => expect(calls.deleted).toHaveLength(2))
      expect(calls.unregistered).toEqual([APP])
      expect(calls.deleted).toEqual(['soundwave-aaa', 'soundwave-bbb'])
      expect(calls.register).toEqual([])
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })
})
