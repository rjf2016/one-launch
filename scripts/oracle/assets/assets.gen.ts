import { test } from 'vitest';
import { resolveOut } from '../lib/out.mjs';
import { generateAssets } from './generate-assets.mjs';

test('copy, styles, tokens, icons, What’s New and the licence are in the bundle', async () => {
  const { WHATS_NEW } = await import('../../../src/shared/whats-new-releases');
  const { BrandMark } = await import('../../../src/renderer/src/components/BrandMark');
  await generateAssets(resolveOut(), { WHATS_NEW, BrandMark });
});
