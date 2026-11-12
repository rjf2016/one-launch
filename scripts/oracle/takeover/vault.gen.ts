import { join, resolve } from 'node:path';
import { test, vi } from 'vitest';
import { repoRoot, resolveOut, writeArtefact } from '../lib/out.mjs';
import { FAILURE_BASE, KEY_BYTES, NONCE_BYTES, OTHER_KEY, OVERHEAD, PREFIX, TAG_BYTES, THROWAWAY_KEY, buildVectors, open } from './vault/codec.mjs';
import { probeSafeStorage } from './vault/safestorage-probe.mjs';

vi.mock('electron', () => ({ safeStorage: {} }));

const SCRATCH = resolve(process.env['T11_SCRATCH'] ?? join(repoRoot, '..', 'oracle-scratch', 't11'));
const b64 = (buf: Buffer): string => buf.toString('base64');

interface Probed {
  name: string;
  kind: string;
  decrypts: boolean;
  plaintextMatches?: boolean;
  returned?: string | null;
  thrown?: string | null;
  processExit?: string;
  chromiumLog?: string[];
}

test('portable v10 vectors', async () => {
  const { VaultUnreadableError } = await import('../../../src/main/services/vault');
  const unreadable = new VaultUnreadableError();
  const { valid, failures } = buildVectors(THROWAWAY_KEY);
  for (const v of valid) if (open(THROWAWAY_KEY, v.blob) !== v.plaintext) throw new Error(`${v.name} does not round-trip`);
  for (const f of failures) {
    let opened = true;
    try {
      open(f.otherKey ? OTHER_KEY : THROWAWAY_KEY, f.blob);
    } catch {
      opened = false;
    }
    if (opened) throw new Error(`${f.name} decrypts`);
  }

  const probe = probeSafeStorage(SCRATCH) as {
    available: boolean;
    written: { name: string; prefix: string; blobBytes: number; expectedBytes: number }[];
    decrypted: Probed[];
  };
  if (!probe.available) throw new Error('safeStorage is not available on the probe profile');
  const measured = (name: string): Probed => {
    const found = probe.decrypted.find((d) => d.name === name);
    if (!found) throw new Error(`the probe has no result for ${name}`);
    return found;
  };
  const appOutcome = (p: Probed): object => {
    if (p.processExit && p.processExit !== '0')
      return { outcome: 'the main process ends', detail: `safeStorage.decryptString does not return or throw; the process exits with ${p.processExit}` };
    if (p.decrypts)
      return { outcome: 'no error', detail: `safeStorage.decryptString returns ${JSON.stringify(p.returned)}, which the vault hands back as the plaintext` };
    return { outcome: 'error', error: unreadable.name, code: unreadable.code, message: unreadable.message };
  };

  writeArtefact(resolveOut(), 'takeover/vault/portable-v10.json', {
    format: 'Chromium os_crypt v10 as Electron safeStorage writes it on Windows: prefix, nonce, ciphertext, tag; AES-256-GCM with no associated data',
    encoding: 'every byte string is standard base64 with padding; plaintext is the UTF-8 string',
    layout: {
      prefix: b64(PREFIX),
      prefixText: PREFIX.toString('latin1'),
      prefixBytes: PREFIX.length,
      nonceBytes: NONCE_BYTES,
      tagBytes: TAG_BYTES,
      overheadBytes: OVERHEAD,
      ciphertextBytes: 'equal to the UTF-8 length of the plaintext',
    },
    key: { base64: b64(THROWAWAY_KEY), bytes: KEY_BYTES, note: 'throwaway: the counting bytes 0x00 to 0x1f; no DPAPI involved, never a real key' },
    otherKey: { base64: b64(OTHER_KEY), note: 'the counting bytes 0x20 to 0x3f, used only by the wrong-key failure' },
    nonces: 'fixed: twelve counting bytes from a start byte per vector, so the file is identical on every run',
    valid: valid.map((v) => ({
      name: v.name,
      plaintext: v.plaintext,
      plaintextUtf8Bytes: Buffer.byteLength(v.plaintext, 'utf8'),
      nonce: b64(v.nonce),
      ciphertext: b64(v.ciphertext),
      tag: b64(v.tag),
      blob: b64(v.blob),
      blobBytes: v.blob.length,
      electron: { decryptsToThePlaintext: measured(v.name).plaintextMatches === true },
    })),
    failures: failures.map((f) => {
      const p = measured(f.name);
      return {
        name: f.name,
        derivedFrom: f.name === 'empty-blob' ? null : FAILURE_BASE,
        why: f.why,
        key: f.otherKey ? 'otherKey' : 'key',
        blob: b64(f.blob),
        blobBytes: f.blob.length,
        nodeCrypto: 'refuses',
        electron: {
          safeStorage: {
            decrypts: p.decrypts,
            returned: p.returned ?? null,
            thrown: p.thrown ?? null,
            processExit: p.processExit ?? '0',
            chromiumLog: p.chromiumLog ?? [],
          },
          app: appOutcome(p),
        },
      };
    }),
    electronProbe: {
      how: 'scripts/oracle/takeover/vault/safestorage-probe.mjs: the same vectors rebuilt under a throwaway scratch profile key with the same nonces, each failure decrypted by real safeStorage in a process of its own',
      appMapping: 'src/main/services/vault.ts:59-66: a thrown safeStorage error becomes VaultUnreadableError; a returned string is the plaintext',
      written: probe.written,
    },
  });
});
