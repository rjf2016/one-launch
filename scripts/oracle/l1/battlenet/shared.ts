import { bundleBytes, encodeValue, fromTest, type Case, type Origin } from '../lib/index';

export const BN = 'fixtures/launchers/battlenet';
export const CONFIG = `${BN}/Battle.net.config`;
export const USER_CONFIG = `${BN}/0a1b2c3d.config`;
export const LOG_0913 = `${BN}/battle.net-20260913T032048.091643.log`;
export const LOG_0919 = `${BN}/battle.net-20260919T235113.602062.log`;
export const LOG_0924 = `${BN}/battle.net-20260924T220659.026162.log`;
export const LOGS = [LOG_0913, LOG_0919, LOG_0924];

export const FILES_TEST = 'test/battlenet-files.test.ts';
export const STATE_TEST = 'test/battlenet-product-state.test.ts';
export const LIMITS_TEST = 'test/parse-limits.test.ts';

export const D_CONFIG = 'Battle.net.config';
export const D_CLIENT_LOG = 'client log';
export const D_PRODUCTS = 'products';
export const D_SESSION = 'session blobs';
export const D_STATE = 'Battle.net product state and game start, from the client log';
export const D_LIMITS = 'launcher files of a size or shape no launcher writes (H16)';

export function recordable(value: unknown): boolean {
  try {
    encodeValue(value, 'probe');
    return true;
  } catch {
    return false;
  }
}

export function inputBytes(arg: unknown): Buffer {
  const value = arg as { bytes?: Buffer; path?: string };
  if (value.bytes) return value.bytes;
  if (value.path) return bundleBytes(value.path);
  throw new Error('not an input');
}

export const bytesOf = (c: Case, index = 0): Buffer => inputBytes(c.args[index]);

export const testOrigin =
  (path: string, ...describes: string[]) =>
  (title: string, change?: string): Origin =>
    fromTest(path, ...describes, change ? `${title} | ${change}` : title);
