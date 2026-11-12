import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');
export const RECORD_ENV = 'ORACLE_TESTS_RECORD';
export const LIVE_ENV = 'ONELAUNCH_LIVE';
export const CONFIG = 'scripts/oracle/tests/vitest.config.ts';
export const PLAIN_CONFIG = 'scripts/oracle/check.vitest.config.ts';

export const recordName = (file) => `${file.replace(/\//g, '__')}.json`;

export const scratchRoot = (env = process.env) => resolve(env.ORACLE_SCRATCH ?? resolve(repoRoot, '..', 'oracle-scratch'), 'tests');
