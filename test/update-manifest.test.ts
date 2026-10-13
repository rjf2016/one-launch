import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalPayload,
  keyIdOf,
  publicKeyOf,
  sha512OfFile,
  sha512OfFileSync,
  signManifest,
  verifyManifest,
  type ManifestFile,
  type ReleaseKey,
} from '../src/main/updates/manifest';
import { RELEASE_KEYS } from '../src/main/updates/release-keys';

function keyPair(): { privateKey: KeyObject; key: ReleaseKey } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKeyOf(privateKey);
  return { privateKey, key: { id: keyIdOf(spki), spki } };
}

const primary = keyPair();
const backup = keyPair();
const stranger = keyPair();
const KEYS = [primary.key, backup.key];

const FILE: ManifestFile = {
  url: 'OneLaunch-1.0.0-beta.2-setup.exe',
  sha512: createHash('sha512').update('installer bytes').digest('base64'),
  size: 112_000_000,
};

function manifest(overrides: Record<string, unknown> = {}, signer: KeyObject = primary.privateKey, file: ManifestFile = FILE): Record<string, unknown> {
  const signed = signManifest('1.0.0-beta.2', file, signer);
  return {
    version: '1.0.0-beta.2',
    files: [{ ...file }],
    path: file.url,
    sha512: file.sha512,
    releaseDate: '2026-10-01T00:00:00.000Z',
    ...signed,
    ...overrides,
  };
}

describe('release manifest signatures', () => {
  it('accepts a manifest signed by a pinned key and reports what it covers', () => {
    expect(verifyManifest(manifest(), KEYS)).toEqual({ ok: true, version: '1.0.0-beta.2', file: FILE, keyId: primary.key.id });
  });

  it('accepts the backup key, so the primary can be retired', () => {
    expect(verifyManifest(manifest({}, backup.privateKey), KEYS)).toMatchObject({ ok: true, keyId: backup.key.id });
  });

  it('signs a fixed, newline-separated payload', () => {
    expect(canonicalPayload('1.2.3', { url: 'a.exe', sha512: 'h', size: 7 })).toBe('one-launch-update-v1\n1.2.3\na.exe\nh\n7\n');
  });

  it.each([
    ['version', { version: '1.0.0-beta.3' }],
    ['file name', { files: [{ ...FILE, url: 'OneLaunch-evil-setup.exe' }] }],
    ['hash', { files: [{ ...FILE, sha512: createHash('sha512').update('other').digest('base64') }] }],
    ['size', { files: [{ ...FILE, size: FILE.size + 1 }] }],
  ])('refuses a manifest whose %s changed after signing', (_what, change) => {
    expect(verifyManifest(manifest(change), KEYS)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a key it does not pin, even when it names a pinned key id', () => {
    expect(verifyManifest(manifest({}, stranger.privateKey), KEYS)).toMatchObject({ ok: false, reason: 'unknown-key' });
    const forged = manifest({}, stranger.privateKey);
    expect(verifyManifest({ ...forged, keyId: primary.key.id }, KEYS)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('refuses everything when the build pins no key', () => {
    expect(verifyManifest(manifest(), [])).toMatchObject({ ok: false, reason: 'no-keys' });
  });

  it('refuses an unsigned manifest and malformed signatures', () => {
    const { signature: _s, keyId: _k, ...unsigned } = manifest();
    expect(verifyManifest(unsigned, KEYS)).toMatchObject({ ok: false, reason: 'unsigned' });
    expect(verifyManifest(manifest({ signature: 'abc' }), KEYS)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyManifest(manifest({ signature: undefined }), KEYS)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyManifest(manifest({ keyId: 'NOT-HEX' }), KEYS)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('refuses shapes the updater would treat differently from what was signed', () => {
    expect(verifyManifest(manifest({ files: [FILE, FILE] }), KEYS)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(verifyManifest(manifest({ files: [] }), KEYS)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(verifyManifest(manifest({ files: [{ ...FILE, isAdminRightsRequired: true }] }), KEYS)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(verifyManifest(manifest({ packages: { x64: { path: 'p.7z', sha512: FILE.sha512 } } }), KEYS)).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('refuses fields that could smuggle a second line into the signed payload', () => {
    const tricky = { ...FILE, url: 'a.exe\n1.0.0' };
    expect(verifyManifest(manifest({}, primary.privateKey, tricky), KEYS)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyManifest(manifest({ version: '1.0.0\n' }), KEYS)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyManifest(manifest({ files: [{ ...FILE, url: '../OneLaunch.exe' }] }), KEYS)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyManifest(manifest({ files: [{ ...FILE, size: -1 }] }), KEYS)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyManifest(null, KEYS)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('pins only well-formed Ed25519 keys whose ids match their bytes', () => {
    for (const key of RELEASE_KEYS) expect(key.id).toBe(keyIdOf(key.spki));
  });
});

describe('installer hashing', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('hashes the same bytes the same way streamed and in one go', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-hash-'));
    const file = join(dir, 'setup.exe');
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    writeFileSync(file, bytes);
    const expected = createHash('sha512').update(bytes).digest('base64');
    expect(await sha512OfFile(file)).toBe(expected);
    expect(sha512OfFileSync(file)).toBe(expected);
  });
});
