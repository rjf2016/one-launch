// Signs a draft release's latest.yml with the offline primary key and, when asked, publishes the draft. Run by the owner:
//   npm run release:sign -- v1.2.3 [--key=<primary .pem>]      (or set ONELAUNCH_RELEASE_KEY to the .pem path)
// It downloads the draft's installer, hashes it, refuses unless latest.yml states that same file, signs what it
// measured, checks the result the way the app will, uploads it, and checks the uploaded copy once more.
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { keyIdOf, publicKeyOf, sha512OfFile, signManifest, verifyManifest } from '../src/main/updates/manifest.ts';
import { RELEASE_KEYS } from '../src/main/updates/release-keys.ts';
import { askHidden, askYesNo } from './release-prompt.mjs';

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith('--'));
const keyPath = args.find((a) => a.startsWith('--key='))?.slice('--key='.length) ?? process.env.ONELAUNCH_RELEASE_KEY;
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) fail('Usage: npm run release:sign -- v<version> [--key=<primary .pem>]');
if (!keyPath) fail('Name the primary key file with --key=<path> or ONELAUNCH_RELEASE_KEY.');
if (RELEASE_KEYS.length === 0) fail('src/main/updates/release-keys.ts pins no key yet; run npm run release:keygen first.');

const version = tag.slice(1);
const installerName = `OneLaunch-${version}-setup.exe`;

const release = JSON.parse(gh('release', 'view', tag, '--json', 'isDraft,assets,url'));
if (!release.isDraft) fail(`${tag} is already published. A published release is never re-signed; publish a new version instead.`);
const assets = new Set(release.assets.map((a) => a.name));
for (const name of [installerName, `${installerName}.blockmap`, 'latest.yml']) if (!assets.has(name)) fail(`The draft ${tag} has no ${name}.`);

const work = mkdtempSync(join(tmpdir(), 'onelaunch-sign-'));
try {
  console.log(`Downloading ${installerName} and latest.yml from the draft ${tag}…`);
  gh('release', 'download', tag, '--pattern', installerName, '--pattern', 'latest.yml', '--dir', work);
  const installerPath = join(work, installerName);
  const measured = { url: installerName, sha512: await sha512OfFile(installerPath), size: statSync(installerPath).size };

  const text = readFileSync(join(work, 'latest.yml'), 'utf8');
  const stated = yaml.load(text);
  if (/^(signature|keyId):/m.test(text)) fail('latest.yml is already signed.');
  const entry = Array.isArray(stated?.files) && stated.files.length === 1 ? stated.files[0] : null;
  if (stated?.version !== version) fail(`latest.yml says version ${stated?.version}, the tag says ${version}.`);
  if (!entry || entry.url !== measured.url || entry.sha512 !== measured.sha512 || entry.size !== measured.size) {
    fail('latest.yml does not describe the installer in the draft (name, SHA-512 or size differ). Rebuild the release; do not sign it.');
  }

  console.log(
    `\n  Release  ${tag}\n  File     ${measured.url}\n  Size     ${measured.size.toLocaleString('en')} bytes\n  SHA-512  ${measured.sha512.slice(0, 24)}…\n`,
  );
  const passphrase = await askHidden('Passphrase for the primary key: ');
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: readFileSync(keyPath), format: 'pem', passphrase });
  } catch {
    fail('Could not open the key: wrong passphrase, or not a key file.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('That is not an Ed25519 key.');
  const keyId = keyIdOf(publicKeyOf(privateKey));
  if (!RELEASE_KEYS.some((k) => k.id === keyId)) fail(`Key ${keyId} is not pinned in src/main/updates/release-keys.ts, so the app would refuse this release.`);

  const signed = signManifest(version, measured, privateKey);
  const signedText = `${text.endsWith('\n') ? text : `${text}\n`}signature: '${signed.signature}'\nkeyId: '${signed.keyId}'\n`;
  const check = (body) => verifyManifest(yaml.load(body), RELEASE_KEYS);
  const local = check(signedText);
  if (!local.ok) fail(`The signed manifest does not verify: ${local.detail}`);
  writeFileSync(join(work, 'latest.yml'), signedText);

  console.log(`Signed with key ${signed.keyId}. Uploading latest.yml…`);
  gh('release', 'upload', tag, join(work, 'latest.yml'), '--clobber');
  const again = mkdtempSync(join(work, 'uploaded-'));
  gh('release', 'download', tag, '--pattern', 'latest.yml', '--dir', again);
  const uploaded = readFileSync(join(again, 'latest.yml'), 'utf8');
  if (uploaded !== signedText || !check(uploaded).ok)
    fail('The uploaded latest.yml is not the one that was signed. Leave the draft unpublished and run this again.');
  console.log('The uploaded latest.yml verifies.');

  if (await askYesNo(`Publish ${tag} now? Installed copies will start downloading it.`)) {
    gh('release', 'edit', tag, '--draft=false');
    console.log(`Published: ${JSON.parse(gh('release', 'view', tag, '--json', 'url')).url}`);
  } else {
    console.log(`Left as a draft. Publish it from GitHub when ready: ${release.url}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
