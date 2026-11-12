import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const INSTALLER_TEXT = 'placeholder installer bytes, not a real executable';
export const TAMPERED_TEXT = 'placeholder installer bytes, tampered, not signed.';
export const UNKNOWN_KEY_ID = '0000000000000000';

export function loadFixtures(out) {
  const dir = join(out, 'fixtures', 'updates');
  const keys = JSON.parse(readFileSync(join(dir, 'README-keys.json'), 'utf8'));
  const signed = readFileSync(join(dir, 'latest.yml'), 'utf8');
  const unsigned = readFileSync(join(dir, 'latest-unsigned.yml'), 'utf8');
  const field = (name) => new RegExp(`^${name}: '?([^'\\n]+)'?$`, 'm').exec(signed)?.[1] ?? null;
  const file = /^ {2}- url: (.+)\n {4}sha512: (.+)\n {4}size: (\d+)$/m.exec(signed);
  if (!file) throw new Error('fixtures/updates/latest.yml has no files entry in the expected shape');
  const installer = Buffer.from(INSTALLER_TEXT, 'utf8');
  const tampered = Buffer.from(TAMPERED_TEXT, 'utf8');
  const sha512 = createHash('sha512').update(installer).digest('base64');
  if (sha512 !== file[2] || installer.length !== Number(file[3])) throw new Error('the placeholder installer bytes do not match fixtures/updates/latest.yml');
  if (tampered.length !== installer.length) throw new Error('the tampered bytes must have the length the manifest names');
  return {
    spki: keys.throwawayPublicKeySpkiBase64,
    keyId: keys.keyId,
    signed,
    unsigned,
    version: field('version'),
    url: file[1],
    sha512,
    installer,
    tampered,
  };
}

const replaceOnce = (text, from, to) => {
  if (!text.includes(from)) throw new Error(`the manifest has no ${JSON.stringify(from)} to change`);
  return text.replace(from, to);
};

function variant(fx, change) {
  return change(fx.signed);
}

export function conditions(fx, appVersion) {
  const signedFeed = { manifest: fx.signed, installer: fx.installer };
  const refusal = (name, title, change, extra = {}) => ({
    name,
    title,
    group: 'refusal',
    keys: [fx.spki],
    feed: { manifest: variant(fx, change), installer: fx.installer },
    steps: ['start', 'timer', 'manual', 'quit'],
    ...extra,
  });
  return [
    {
      name: 'up-to-date',
      title: 'The feed names the version that is running',
      group: 'core',
      keys: [fx.spki],
      feed: { manifest: replaceOnce(fx.unsigned, `version: ${fx.version}\n`, `version: ${appVersion}\n`), installer: fx.installer },
      steps: ['start', 'timer', 'manual', 'quit'],
    },
    {
      name: 'update-ready',
      title: 'A signed newer release: downloaded, verified, ready; then Restart to update',
      group: 'core',
      keys: [fx.spki],
      feed: signedFeed,
      paced: true,
      steps: ['start', 'timer', 'manual', 'install'],
    },
    {
      name: 'unsigned',
      title: 'The manifest has no signature and no key id',
      group: 'core',
      keys: [fx.spki],
      feed: { manifest: fx.unsigned, installer: fx.installer },
      steps: ['start', 'timer', 'manual', 'quit'],
    },
    {
      name: 'wrong-key',
      title: 'The manifest names a key this build does not trust',
      group: 'core',
      keys: [fx.spki],
      feed: { manifest: replaceOnce(fx.signed, `keyId: '${fx.keyId}'`, `keyId: '${UNKNOWN_KEY_ID}'`), installer: fx.installer },
      steps: ['start', 'timer', 'manual', 'quit'],
    },
    {
      name: 'hash-mismatch',
      title: 'A signed manifest, but the installer the feed serves is other bytes of the same length',
      group: 'core',
      keys: [fx.spki],
      feed: { manifest: fx.signed, installer: fx.tampered },
      steps: ['start', 'timer', 'manual', 'quit'],
    },
    {
      name: 'network-failure',
      title: 'Nothing listens on the feed port: the connection is refused',
      group: 'core',
      keys: [fx.spki],
      feed: null,
      steps: ['start', 'timer', 'manual', 'quit'],
    },
    {
      name: 'no-keys',
      title: 'The build trusts no key (ONELAUNCH_UPDATE_KEYS empty)',
      group: 'refusal',
      keys: [],
      feed: signedFeed,
      steps: ['start', 'timer', 'manual', 'quit'],
    },
    {
      name: 'not-an-object',
      title: 'latest.yml is a YAML scalar, not a mapping',
      group: 'refusal',
      keys: [fx.spki],
      feed: { manifest: 'not a manifest\n', installer: fx.installer },
      direct: true,
      steps: ['start', 'timer', 'manual', 'quit'],
    },
    refusal('web-installer', 'The manifest lists packages (a web installer)', (t) =>
      replaceOnce(
        t,
        `path: ${fx.url}\n`,
        `packages:\n  x64:\n    path: OneLaunch-${fx.version}-x64.nsis.7z\n    sha512: ${fx.sha512}\n    size: 50\npath: ${fx.url}\n`,
      ),
    ),
    refusal('file-count', 'The manifest lists two files', (t) =>
      replaceOnce(t, `path: ${fx.url}\n`, `  - url: ${fx.url}\n    sha512: ${fx.sha512}\n    size: ${fx.installer.length}\npath: ${fx.url}\n`),
    ),
    refusal('file-entry', 'The one file entry is a string, not a mapping', (t) =>
      replaceOnce(t, `  - url: ${fx.url}\n    sha512: ${fx.sha512}\n    size: ${fx.installer.length}\n`, `  - ${fx.url}\n`),
    ),
    refusal('admin-rights', 'The file entry asks for administrator rights', (t) =>
      replaceOnce(t, `    size: ${fx.installer.length}\n`, `    size: ${fx.installer.length}\n    isAdminRightsRequired: true\n`),
    ),
    refusal('version-format', 'The version carries build metadata (valid semver, not a plain version)', (t) =>
      replaceOnce(t, `version: ${fx.version}\n`, `version: ${fx.version}+build.7\n`),
    ),
    refusal('file-name', 'The file url is a path, not a plain .exe name', (t) => replaceOnce(t, `  - url: ${fx.url}\n`, `  - url: downloads/${fx.url}\n`)),
    refusal('file-sha512', 'The file entry has no sha512', (t) => replaceOnce(t, `    sha512: ${fx.sha512}\n`, '')),
    refusal('file-size', 'The file entry has no size', (t) => replaceOnce(t, `    size: ${fx.installer.length}\n`, '')),
    refusal('signature-format', 'The signature is not 64 bytes of base64', (t) => t.replace(/^signature: .*$/m, "signature: 'not-a-signature'")),
    refusal('key-id-format', 'The key id is upper-case hex', (t) => replaceOnce(t, `keyId: '${fx.keyId}'`, `keyId: '${fx.keyId.toUpperCase()}'`)),
    refusal('bad-signature', 'The version was changed after signing', (t) => replaceOnce(t, `version: ${fx.version}\n`, 'version: 1.0.0-beta.5\n')),
    {
      name: 'auto-off-in-flight',
      title: 'Automatic updates switched off while the background check waits for latest.yml (spec 12.2)',
      group: 'behaviour',
      keys: [fx.spki],
      feed: signedFeed,
      autoOffAt: 'manifest',
      steps: ['start', 'timer', 'manual', 'quit'],
    },
    {
      name: 'auto-off-during-download',
      title:
        'Automatic updates switched off while the background download waits for the installer, then on again: a check 15 s later downloads it and it installs at quit',
      group: 'behaviour',
      keys: [fx.spki],
      feed: signedFeed,
      autoOffAt: 'installer',
      steps: ['start', 'timer', 'auto-on', 'timer-again', 'quit'],
    },
    {
      name: 'feed-http-503',
      title: 'The feed answers HTTP 503 to every request',
      group: 'behaviour',
      keys: [fx.spki],
      feed: { ...signedFeed, status: 503 },
      steps: ['start', 'timer', 'manual', 'quit'],
    },
    {
      name: 'no-manifest',
      title: 'The feed has no latest.yml (HTTP 404)',
      group: 'behaviour',
      keys: [fx.spki],
      feed: { manifest: null, installer: fx.installer },
      steps: ['start', 'timer', 'manual', 'quit'],
    },
  ];
}
