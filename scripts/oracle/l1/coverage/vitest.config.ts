import { resolve } from 'node:path';
import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config';

export default mergeConfig(base, {
  test: { setupFiles: [resolve(__dirname, 'setup.mjs')] },
});
