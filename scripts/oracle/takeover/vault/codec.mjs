import { createCipheriv, createDecipheriv } from 'node:crypto';

export const PREFIX = Buffer.from('v10', 'latin1');
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;
export const OVERHEAD = PREFIX.length + NONCE_BYTES + TAG_BYTES;

export const counting = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));

export const THROWAWAY_KEY = counting(0x00, KEY_BYTES);
export const OTHER_KEY = counting(0x20, KEY_BYTES);

export const PLAINTEXTS = [
  { name: 'empty', plaintext: '', nonceStart: 0x40 },
  { name: 'ascii', plaintext: 'placeholder-password-1', nonceStart: 0x50 },
  { name: 'utf8-multibyte', plaintext: 'placeholder-pässwörd-日本語-🎮', nonceStart: 0x60 },
  { name: 'vault-probe', plaintext: 'one-launch-vault-probe-v1', nonceStart: 0x70 },
  { name: 'long', plaintext: Array.from({ length: 128 }, (_, i) => `placeholder-${String(i).padStart(3, '0')}-ä`).join(''), nonceStart: 0x80 },
];

export function seal(key, nonce, plaintext) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext, tag, blob: Buffer.concat([PREFIX, nonce, ciphertext, tag]) };
}

export function open(key, blob) {
  if (blob.length < OVERHEAD) throw new Error('shorter than prefix, nonce and tag');
  if (!blob.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('not the v10 prefix');
  const nonce = blob.subarray(PREFIX.length, PREFIX.length + NONCE_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES));
  return Buffer.concat([decipher.update(blob.subarray(PREFIX.length + NONCE_BYTES, blob.length - TAG_BYTES)), decipher.final()]).toString('utf8');
}

const flip = (blob, index, bit) => {
  const out = Buffer.from(blob);
  out[index] ^= bit;
  return out;
};

export const FAILURES = [
  { name: 'wrong-prefix-v11', why: 'the prefix is v11, not v10', make: (b) => Buffer.concat([Buffer.from('v11', 'latin1'), b.subarray(3)]) },
  { name: 'wrong-prefix-v20', why: 'the prefix is v20, not v10', make: (b) => Buffer.concat([Buffer.from('v20', 'latin1'), b.subarray(3)]) },
  { name: 'no-prefix', why: 'the blob starts with the nonce; the prefix is missing', make: (b) => b.subarray(3) },
  { name: 'empty-blob', why: 'zero bytes', make: () => Buffer.alloc(0) },
  { name: 'prefix-only', why: 'the prefix and nothing else', make: (b) => b.subarray(0, 3) },
  { name: 'truncated-in-nonce', why: 'the blob ends inside the nonce', make: (b) => b.subarray(0, 3 + 7) },
  { name: 'truncated-below-overhead', why: 'one byte shorter than prefix, nonce and tag together', make: (b) => b.subarray(0, OVERHEAD - 1) },
  { name: 'truncated-last-byte', why: 'the last byte of the tag is missing', make: (b) => b.subarray(0, b.length - 1) },
  { name: 'flipped-tag-bit', why: 'the lowest bit of the last tag byte is flipped', make: (b) => flip(b, b.length - 1, 0x01) },
  { name: 'flipped-ciphertext-bit', why: 'the lowest bit of the first ciphertext byte is flipped', make: (b) => flip(b, 3 + NONCE_BYTES, 0x01) },
  { name: 'flipped-nonce-bit', why: 'the lowest bit of the first nonce byte is flipped', make: (b) => flip(b, 3, 0x01) },
  { name: 'wrong-key', why: 'an intact blob opened with another key (bytes 0x20 to 0x3f)', make: (b) => b, key: 'other' },
];

export const FAILURE_BASE = 'ascii';

export function buildVectors(key) {
  const valid = PLAINTEXTS.map(({ name, plaintext, nonceStart }) => ({ name, plaintext, ...seal(key, counting(nonceStart, NONCE_BYTES), plaintext) }));
  const base = valid.find((v) => v.name === FAILURE_BASE).blob;
  const failures = FAILURES.map(({ name, why, make, key: which }) => ({ name, why, blob: make(base), otherKey: which === 'other' }));
  return { valid, failures };
}
