// Creates the two release signing keys, run once by the owner in their own console:
//   npm run release:keygen -- <folder outside the repo>
// Both private keys are written there as passphrase-encrypted PKCS#8 PEM files; only their public halves go
// into src/main/updates/release-keys.ts, which the app pins. The primary signs releases (npm run release:sign).
// The backup never signs anything until the primary is lost or leaked; keep it offline, apart from the primary.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyIdOf, publicKeyOf } from '../src/main/updates/manifest.ts';
import { RELEASE_KEYS } from '../src/main/updates/release-keys.ts';
import { askHidden } from './release-prompt.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_FILE = join(repoRoot, 'src', 'main', 'updates', 'release-keys.ts');
const MIN_PASSPHRASE = 12;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const target = process.argv[2];
if (!target) fail('Usage: npm run release:keygen -- <folder outside the repo>');
const folder = resolve(target);
const inside = relative(repoRoot, folder);
if (!inside || (!inside.startsWith('..') && !isAbsolute(inside))) fail(`${folder} is inside the repository; private keys must never be there.`);
if (RELEASE_KEYS.length > 0)
  fail(`${KEYS_FILE} already pins ${RELEASE_KEYS.length} key(s). Replacing them strands every installed copy; rotate by hand instead.`);

const files = { primary: join(folder, 'one-launch-release-primary.pem'), backup: join(folder, 'one-launch-release-backup.pem') };
for (const file of Object.values(files)) if (existsSync(file)) fail(`${file} already exists; not overwriting it.`);

const passphrase = await askHidden(`Passphrase for the keys (at least ${MIN_PASSPHRASE} characters): `);
if (passphrase.length < MIN_PASSPHRASE) fail('Too short.');
if ((await askHidden('Same passphrase again: ')) !== passphrase) fail('The two passphrases differ.');

mkdirSync(folder, { recursive: true });
const pinned = [];
for (const [role, file] of Object.entries(files)) {
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }), { flag: 'wx' });
  const spki = publicKeyOf(privateKey);
  pinned.push({ role, id: keyIdOf(spki), spki });
}

writeFileSync(
  KEYS_FILE,
  [
    "import type { ReleaseKey } from './manifest';",
    '',
    '// Written by scripts/release-keygen.mjs. An empty list makes the updater refuse every release.',
    'export const RELEASE_KEYS: readonly ReleaseKey[] = [',
    ...pinned.map((k) => `  { id: '${k.id}', spki: '${k.spki}' }, // ${k.role}`),
    '];',
    '',
  ].join('\n'),
);

console.log(`\nWrote ${files.primary}\nWrote ${files.backup}\nPinned both public keys in ${KEYS_FILE}\n`);
console.log('Next:');
console.log('  1. Move the backup key file somewhere offline (a USB stick or a password manager), away from the primary.');
console.log('  2. Keep the passphrase in your password manager. Without it neither key can sign.');
console.log('  3. Commit src/main/updates/release-keys.ts; the next release will trust these keys.');
