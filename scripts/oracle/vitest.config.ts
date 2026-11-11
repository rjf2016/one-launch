import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = resolve(__dirname, '../..');
const generator = process.env.ORACLE_GENERATOR;

export default defineConfig({
  root,
  resolve: {
    alias: { '@shared': resolve(root, 'src/shared') },
  },
  test: {
    // Generators write into the bundle, so they run only when generate.mjs names them; a bare run is the tooling's own unit tests.
    include: generator ? [generator] : ['scripts/oracle/test/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
