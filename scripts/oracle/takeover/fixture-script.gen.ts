import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { resolveOut, writeArtefact } from '../lib/out.mjs';

test('the local vault fixture script, copied into the bundle', () => {
  writeArtefact(resolveOut(), 'takeover/vault/make-local-fixture.mjs', readFileSync(join(import.meta.dirname, 'vault', 'make-local-fixture.mjs')));
});
