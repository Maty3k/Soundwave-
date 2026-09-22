/**
 * Vite build plugin: fills in the precache list and version of the hand-written service worker
 * (public/sw.js) once the build is written, so the app opens without a network.
 *
 * After every build it walks the output directory, lists every file except sw.js itself, source
 * maps, dotfiles and the test signals under dev/ (as URLs relative to the output root, plus './'
 * for the app page), hashes the list and the file contents into a short version, and writes
 * <outDir>/sw.js from the public/sw.js template. The build fails when the template lacks either
 * placeholder, so a broken worker is never shipped.
 *
 * The pure helpers are exported for tools/sw-precache.test.mjs.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** Placeholder for the version string in public/sw.js (a quoted string literal). */
export const VERSION_PLACEHOLDER = "'__SW_VERSION__'"
/** Placeholder for the precache list in public/sw.js (an empty array behind a marker comment). */
export const PRECACHE_PLACEHOLDER = '/*__SW_PRECACHE__*/[]'
/** The worker file, at the root of public/ and of the build. */
export const SW_FILE = 'sw.js'

const toPosix = (path) => path.replaceAll('\\', '/').replace(/^\.\//, '')

/**
 * Whether a file of the build (path relative to the output root) belongs in the precache.
 * Left out: the worker itself, source maps, dotfiles and anything under dev/ (test signals).
 */
export function isPrecached(relativePath) {
  const path = toPosix(relativePath)
  if (path === '' || path === SW_FILE || path.endsWith('.map')) return false
  if (path === 'dev' || path.startsWith('dev/')) return false
  return !path.split('/').some((segment) => segment === '' || segment.startsWith('.'))
}

/**
 * A relative path as the URL the browser asks for: percent-encoded by the URL parser itself, so
 * the precached key matches the page's request ('?', '#' and '%' are part of the name here).
 */
export function pathToUrl(relativePath) {
  const escaped = toPosix(relativePath).replace(/[%?#]/g, (c) => encodeURIComponent(c))
  return new URL(escaped, 'https://soundwave.invalid/').pathname.slice(1)
}

/**
 * The precache list: URLs relative to the worker, sorted by path, with './' (the app page as the
 * browser asks for it) first when there is an index.html. Duplicates are dropped (cache.addAll
 * rejects them).
 */
export function precacheList(relativePaths) {
  const paths = [...new Set([...relativePaths].map(toPosix).filter(isPrecached))]
  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const urls = paths.map(pathToUrl)
  return paths.includes('index.html') ? ['./', ...urls] : urls
}

/**
 * Short build version: the first 12 hex characters of a SHA-256 over the files (path and content),
 * sorted by path so the order they were found in does not matter.
 * @param {Iterable<readonly [string, string | Uint8Array]>} files
 */
export function swVersion(files) {
  const sorted = [...files].map(([path, content]) => [toPosix(path), content])
  sorted.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const hash = createHash('sha256')
  for (const [path, content] of sorted) {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    hash.update(`${path}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex').slice(0, 12)
}

/**
 * The worker source: the template with both placeholders replaced. Throws when a placeholder is
 * missing or appears more than once.
 * @param {string} template
 * @param {readonly string[]} list
 * @param {string} version
 */
export function swSource(template, list, version) {
  let source = template
  for (const [placeholder, value] of [
    [VERSION_PLACEHOLDER, JSON.stringify(version)],
    [PRECACHE_PLACEHOLDER, JSON.stringify(list)],
  ]) {
    const count = source.split(placeholder).length - 1
    if (count !== 1) {
      throw new Error(`sw-precache: expected ${placeholder} exactly once in ${SW_FILE}, found it ${count} times`)
    }
    // A function, so '$&' and friends in file names are not treated as replacement patterns.
    source = source.replace(placeholder, () => value)
  }
  return source
}

/** Every file under dir, as paths relative to dir with forward slashes. */
export function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(relative(dir, join(entry.parentPath, entry.name))))
}

/**
 * Writes <outDir>/sw.js from the template and returns what it wrote.
 * @param {{ outDir: string, template: string }} options
 */
export function writeServiceWorker({ outDir, template }) {
  const root = resolve(outDir)
  const files = listFiles(root).filter(isPrecached)
  const list = precacheList(files)
  const contents = files.map((path) => [path, readFileSync(join(root, path))])
  const version = swVersion([...contents, [`template:${SW_FILE}`, template]])
  writeFileSync(join(root, SW_FILE), swSource(template, list, version))
  const bytes = contents.reduce((sum, [, content]) => sum + content.length, 0)
  return { version, list, bytes }
}

/**
 * The Vite plugin (build only). Reads the template from the public dir, so a rebuild in watch mode
 * never sees an already filled-in copy.
 * @returns {import('vite').Plugin}
 */
export default function swPrecache() {
  /** @type {import('vite').ResolvedConfig | undefined} */
  let config
  return {
    name: 'soundwave:sw-precache',
    apply: 'build',
    enforce: 'post',
    configResolved(resolved) {
      config = resolved
    },
    writeBundle: {
      order: 'post',
      handler(outputOptions) {
        if (!config || !config.build.write) return
        if (this.environment && this.environment.name !== 'client') return
        const outDir = outputOptions.dir ?? resolve(config.root, config.build.outDir)
        const candidates = [config.publicDir ? join(config.publicDir, SW_FILE) : null, join(outDir, SW_FILE)]
        const templatePath = candidates.find((path) => path !== null && existsSync(path))
        if (!templatePath) this.error(`sw-precache: no ${SW_FILE} template in the public dir (${config.publicDir || 'disabled'})`)
        let result
        try {
          result = writeServiceWorker({ outDir, template: readFileSync(templatePath, 'utf8') })
        } catch (error) {
          this.error(error instanceof Error ? error.message : String(error))
        }
        config.logger.info(
          `sw-precache: ${SW_FILE} version ${result.version}, ${result.list.length} URLs (${(result.bytes / 1024).toFixed(1)} kB)`,
        )
      },
    },
  }
}
