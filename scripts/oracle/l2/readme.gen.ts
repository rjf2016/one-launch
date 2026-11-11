import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { resolveOut, writeArtefact } from '../lib/out.mjs';

test('the notes on the scripts and expectations are in the bundle', () => {
  writeArtefact(resolveOut(), 'l2/README.md', readFileSync(resolve(import.meta.dirname, 'bundle', 'README.md')));
});
