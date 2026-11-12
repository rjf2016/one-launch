import { resolve } from 'node:path';
import { mergeConfig } from 'vitest/config';
import base from '../../../vitest.config';

export default mergeConfig(base, {
  root: resolve(__dirname, '../../..'),
  test: { setupFiles: [resolve(__dirname, '../lib/clock.setup.mjs'), resolve(__dirname, 'recorder.setup.ts')] },
});
