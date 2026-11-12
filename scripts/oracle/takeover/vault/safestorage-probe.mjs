import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NONCE_BYTES, OTHER_KEY, OVERHEAD, PLAINTEXTS, PREFIX, buildVectors, counting, open, seal } from './codec.mjs';
import { unwrapProfileKey } from './profile-key.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const ELECTRON = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const SCRIPT = join(here, 'safestorage-probe.cjs');

function runElectron(mode, profile, io, work, tag = mode) {
  const ioFile = join(work, `${tag}.in.json`);
  const outFile = join(work, `${tag}.out.json`);
  writeFileSync(ioFile, JSON.stringify({ ...io, out: outFile }));
  const env = { ...process.env, TEMP: work, TMP: work };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(ELECTRON, [SCRIPT, mode, profile, ioFile], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const log = (run.stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter(Boolean);
  return { status: run.status, result: run.status === 0 ? JSON.parse(readFileSync(outFile, 'utf8')) : null, log };
}

function mustRun(mode, profile, io, work) {
  const run = runElectron(mode, profile, io, work);
  if (run.status !== 0) throw new Error(`electron ${mode} left with ${run.status}: ${run.log.slice(-2).join(' ')}`);
  return run.result;
}

const exitText = (status) => (status === 0 ? '0' : status === null ? 'timeout' : `0x${(status >>> 0).toString(16).toUpperCase()}`);

/**
 * Asks real Electron safeStorage, on a throwaway profile under `scratchRoot`, what it writes and what it refuses: it encrypts the
 * portable plaintexts, then decrypts the portable vectors rebuilt under that profile's own key with the same fixed nonces, and
 * each failure in a process of its own. Returns only lengths, prefixes, booleans, error texts and exit codes.
 */
export function probeSafeStorage(scratchRoot) {
  const work = join(scratchRoot, 'safestorage-probe');
  rmSync(work, { recursive: true, force: true });
  const profile = join(work, 'profile');
  mkdirSync(profile, { recursive: true });
  try {
    const enc = mustRun('encrypt', profile, { plaintexts: PLAINTEXTS.map((p) => p.plaintext) }, work);
    const key = unwrapProfileKey(profile, scratchRoot);
    const written = PLAINTEXTS.map((p, i) => {
      const blob = Buffer.from(enc.blobs[i], 'base64');
      let opens = false;
      try {
        opens = open(key, blob) === p.plaintext;
      } catch {
        opens = false;
      }
      return {
        name: p.name,
        prefix: blob.subarray(0, PREFIX.length).toString('latin1'),
        blobBytes: blob.length,
        expectedBytes: OVERHEAD + Buffer.byteLength(p.plaintext, 'utf8'),
        opensWithTheProfileKeyByNodeCrypto: opens,
      };
    });
    const { valid, failures } = buildVectors(key);
    const ascii = PLAINTEXTS.find((p) => p.name === 'ascii');
    const dec = mustRun('decrypt', profile, { blobs: valid.map((v) => v.blob.toString('base64')) }, work);
    const decrypted = valid.map((v, i) => ({
      name: v.name,
      kind: 'valid',
      decrypts: dec.results[i].ok,
      plaintextMatches: dec.results[i].ok && dec.results[i].plaintext === v.plaintext,
    }));
    failures.forEach((f, i) => {
      const blob = f.otherKey ? seal(OTHER_KEY, counting(ascii.nonceStart, NONCE_BYTES), ascii.plaintext).blob : f.blob;
      const run = runElectron('decrypt', profile, { blobs: [blob.toString('base64')] }, work, `failure-${i}`);
      const r = run.result?.results[0] ?? null;
      decrypted.push({
        name: f.name,
        kind: 'failure',
        decrypts: r?.ok ?? false,
        returned: r?.ok ? r.plaintext : null,
        thrown: r && !r.ok ? r.message : null,
        processExit: exitText(run.status),
        chromiumLog: run.log,
      });
    });
    return { available: enc.available && dec.available, written, decrypted };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
