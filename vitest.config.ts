import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    // Renderer tests (test/renderer/*.test.tsx) ask for jsdom themselves with a `@vitest-environment jsdom` line; everything else runs in node.
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // I/O-bound tests (SQLite backups, the pipeline) take under a second here and up to 6 s on a stalled CI runner; 5 s is a fast-machine default.
    testTimeout: 20_000,
  },
});
