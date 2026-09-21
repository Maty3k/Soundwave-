import { defineConfig } from 'vite'

// Relative base: the same build works at the root of https://soundwave.test (Laravel Herd)
// and under https://maty3k.github.io/Soundwave-/ (GitHub Pages). Single page, no routes.
export default defineConfig({
  base: './',
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
  },
})
