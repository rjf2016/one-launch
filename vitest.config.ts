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
  },
});
