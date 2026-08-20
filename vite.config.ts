import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Relative base so the built site works from a subpath (e.g. GitHub Pages).
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    // The plan tests pure modules only (geo, parse, ils, separation,
    // autopilot), so no DOM environment is needed. Add 'jsdom' here if
    // that ever changes.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
