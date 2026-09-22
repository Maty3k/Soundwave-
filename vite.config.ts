import { defineConfig } from 'vite'
import swPrecache from './tools/sw-precache-plugin.mjs'

// Relative base: the same build works at the root of https://soundwave.test (Laravel Herd)
// and under https://maty3k.github.io/Soundwave-/ (GitHub Pages). Single page, no routes.
export default defineConfig({
  base: './',
  // Fills in the precache list and version of public/sw.js (offline mode) after each build.
  plugins: [swPrecache()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    // The minifier drops the bundled libraries' license headers: list them in dist/licenses.md.
    license: { fileName: 'licenses.md' },
  },
})
