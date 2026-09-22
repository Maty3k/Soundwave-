/**
 * Offline mode: registers the precaching service worker (public/sw.js, filled in at build time by
 * tools/sw-precache-plugin.mjs), so the app opens without a network once it has been loaded.
 *
 * Production builds only, and only where service workers are allowed (a secure context: https or
 * localhost). The worker is registered by a relative URL, so its scope is the folder the app is
 * served from (/ on Herd, /Soundwave-/ on GitHub Pages). Failures are ignored: the app works the
 * same without it, just not offline.
 *
 * Debugging: ?nosw unregisters the worker of this folder and deletes its caches instead.
 */

/** Cache names of public/sw.js start with this. */
const CACHE_PREFIX = 'soundwave-'

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return
  if (new URLSearchParams(window.location.search).has('nosw')) {
    void unregisterServiceWorker()
    return
  }
  if (!import.meta.env.PROD) return
  const register = (): void => {
    try {
      // Relative to the page, so the worker's scope is the app folder (/Soundwave-/ on Pages).
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // Offline mode is a bonus; the app works the same without it.
      })
    } catch {
      // Some browsers throw right away instead (a sandboxed frame, storage turned off).
    }
  }
  // After load, so installing (which downloads the whole build) never competes with the app itself.
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}

/** Removes the worker registered for this folder and the app's caches (?nosw). */
async function unregisterServiceWorker(): Promise<void> {
  try {
    const scope = new URL('./', window.location.href).href
    const registrations = await navigator.serviceWorker.getRegistrations()
    // Only this app's folder: on github.io the origin is shared with other projects.
    await Promise.all(registrations.filter((r) => r.scope === scope).map((r) => r.unregister()))
    if ('caches' in window) {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)))
    }
  } catch {
    // Nothing to undo, or storage is off.
  }
}
