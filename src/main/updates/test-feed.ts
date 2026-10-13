import { createPublicKey } from 'node:crypto';
import { keyIdOf, type ReleaseKey } from './manifest';

export const UPDATE_FEED_ENV = 'ONELAUNCH_UPDATE_FEED';
export const UPDATE_KEYS_ENV = 'ONELAUNCH_UPDATE_KEYS';

export class UpdateTestFeedError extends Error {}

export interface UpdateTestFeed {
  url: string;
  keys: ReleaseKey[];
}

function releaseKey(spki: string): ReleaseKey {
  let type: string | undefined;
  try {
    type = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType;
  } catch {
    type = undefined;
  }
  if (type !== 'ed25519') throw new UpdateTestFeedError(`${UPDATE_KEYS_ENV} holds a value that is not an Ed25519 public key`);
  return { id: keyIdOf(spki), spki };
}

// Unpackaged runs only, like ONELAUNCH_FAKE_LAUNCHERS: the packaged exe never reads a feed or a key from its environment.
export function resolveUpdateTestFeed(env: NodeJS.ProcessEnv, isPackaged: boolean): UpdateTestFeed | null {
  if (isPackaged) return null;
  const raw = (env[UPDATE_FEED_ENV] ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpdateTestFeedError(`${UPDATE_FEED_ENV} is not a URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new UpdateTestFeedError(`${UPDATE_FEED_ENV} must be an http://127.0.0.1 address, got "${raw}"`);
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  const keys = (env[UPDATE_KEYS_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(releaseKey);
  return { url: url.toString(), keys };
}
