import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { closeSync, createReadStream, openSync, readSync } from 'node:fs';

// Imported by scripts/release-sign.mjs through Node's type stripping, so it must stay free of local imports and non-erasable syntax.

export const MANIFEST_DOMAIN = 'one-launch-update-v1';

export interface ReleaseKey {
  id: string;
  spki: string;
}

export interface ManifestFile {
  url: string;
  sha512: string;
  size: number;
}

export type ManifestRefusal = 'no-keys' | 'unsupported' | 'malformed' | 'unsigned' | 'unknown-key' | 'bad-signature';

export type ManifestCheck = { ok: true; version: string; file: ManifestFile; keyId: string } | { ok: false; reason: ManifestRefusal; detail: string };

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const KEY_ID = /^[0-9a-f]{16}$/;

export function canonicalPayload(version: string, file: ManifestFile): string {
  return `${MANIFEST_DOMAIN}\n${version}\n${file.url}\n${file.sha512}\n${file.size}\n`;
}

export function keyIdOf(spkiBase64: string): string {
  return createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex').slice(0, 16);
}

export function publicKeyOf(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
}

export function signManifest(version: string, file: ManifestFile, privateKey: KeyObject): { keyId: string; signature: string } {
  return {
    keyId: keyIdOf(publicKeyOf(privateKey)),
    signature: sign(null, Buffer.from(canonicalPayload(version, file), 'utf8'), privateKey).toString('base64'),
  };
}

function refuse(reason: ManifestRefusal, detail: string): ManifestCheck {
  return { ok: false, reason, detail };
}

function field(info: object, name: string): unknown {
  return (info as Record<string, unknown>)[name];
}

export function verifyManifest(info: unknown, keys: readonly ReleaseKey[]): ManifestCheck {
  if (keys.length === 0) return refuse('no-keys', 'this build trusts no release key');
  if (!info || typeof info !== 'object') return refuse('malformed', 'the release manifest is not an object');

  const packages = field(info, 'packages');
  if (packages !== undefined && packages !== null) return refuse('unsupported', 'the release uses a web installer');
  const files = field(info, 'files');
  if (!Array.isArray(files) || files.length !== 1) return refuse('unsupported', 'the release must list exactly one file');
  const entry: unknown = files[0];
  if (!entry || typeof entry !== 'object') return refuse('malformed', 'the release file entry is not an object');
  if (field(entry, 'isAdminRightsRequired') === true) return refuse('unsupported', 'the release asks for administrator rights');

  const version = field(info, 'version');
  const url = field(entry, 'url');
  const sha512 = field(entry, 'sha512');
  const size = field(entry, 'size');
  if (typeof version !== 'string' || !VERSION.test(version)) return refuse('malformed', 'the release version is not a plain version number');
  if (typeof url !== 'string' || !FILE_NAME.test(url)) return refuse('malformed', 'the release file is not a plain .exe name');
  if (typeof sha512 !== 'string' || !SHA512_BASE64.test(sha512)) return refuse('malformed', 'the release file has no SHA-512');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return refuse('malformed', 'the release file has no size');

  const signature = field(info, 'signature');
  const keyId = field(info, 'keyId');
  if (signature === undefined && keyId === undefined) return refuse('unsigned', 'the release is not signed');
  if (typeof signature !== 'string' || !SIGNATURE_BASE64.test(signature)) return refuse('malformed', 'the release signature is malformed');
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) return refuse('malformed', 'the release key id is malformed');

  const key = keys.find((k) => k.id === keyId);
  if (!key) return refuse('unknown-key', `the release is signed with a key this build does not trust (${keyId})`);

  const file: ManifestFile = { url, sha512, size };
  if (!signatureMatches(key, canonicalPayload(version, file), signature)) return refuse('bad-signature', 'the release signature does not match');
  return { ok: true, version, file, keyId };
}

function signatureMatches(key: ReleaseKey, payload: string, signature: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' });
    return publicKey.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function sha512OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')));
  });
}

export function sha512OfFileSync(path: string): string {
  const hash = createHash('sha512');
  const buffer = Buffer.alloc(1 << 20);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('base64');
}
