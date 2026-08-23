import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Relative base so the built site works from a subpath (e.g. GitHub Pages).
  base: './',
  server: {
    watch: {
      // Audio assets are watched for no benefit -- they cannot hot-reload --
      // and a locked or still-being-written media file makes the watcher
      // throw EBUSY on Windows, which is an unhandled error that takes the
      // whole dev server down. Excluding them keeps the server up.
      ignored: ['**/*.wav', '**/*.mp3', '**/*.ogg', '**/*.flac'],
    },
  },
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
    // The stylesheet is read as text by one test -- the tutorial overlay has
    // a positioning rule that, if it regresses, rearranges the whole
    // display. Without this, a '?raw' import of a .css file resolves to an
    // empty string and the guard silently passes.
    css: true,
    include: ['src/**/*.test.ts'],
  },
})
