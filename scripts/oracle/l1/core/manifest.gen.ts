import { adversarial, bundleBytes, bytes, file, fixture, fromTest, text, vectorFile, type Case } from '../lib/index';
import { parseUpdateInfo } from 'electron-updater/out/providers/Provider.js';
import { canonicalPayload, verifyManifest, type ReleaseKey } from '../../../../src/main/updates/manifest';
import { RELEASE_KEYS } from '../../../../src/main/updates/release-keys';

const TESTS = 'test/update-manifest.test.ts';
const SIGNED = 'fixtures/updates/latest.yml';
const UNSIGNED = 'fixtures/updates/latest-unsigned.yml';
const KEYS_README = 'fixtures/updates/README-keys.json';

const readme = JSON.parse(bundleBytes(KEYS_README).toString('utf8')) as { throwawayPublicKeySpkiBase64: string; keyId: string };
const THROWAWAY: ReleaseKey = { id: readme.keyId, spki: readme.throwawayPublicKeySpkiBase64 };
const PINNED = RELEASE_KEYS.map((k) => ({ id: k.id, spki: k.spki }));
const TRUSTED = [THROWAWAY];
const signed = bundleBytes(SIGNED).toString('utf8');

// The P-256 generator point as a public key: a fixed, well-formed key that is not Ed25519, so no key is generated at run time.
const P256_SPKI = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9Q==';

const SHA = 'TrVrOgassNbwx5uV5nUThQ5r3VAp7aMC1XIirwvmxC5hdsYQ0tnXsAOVXxa/O1nBsIoTsP03pTuYmyM0S2R/qw==';
const SIG = 'WmaNrmSbkp1CA6SZqh1JKrl+0wZxwCx88sNKpz5iCKZIcx1YC6TyeqBeaipegc2nAQ6gtrynYf6GS2v/bVScCA==';

function edit(pairs: [string, string][]): string {
  let out = signed;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) throw new Error(`latest.yml has no ${JSON.stringify(from)}`);
    out = out.split(from).join(to);
  }
  return out;
}

const without = (...keys: string[]): string =>
  signed
    .split('\n')
    .filter((l) => !keys.some((k) => l.startsWith(`${k}:`)))
    .join('\n');
const fileEntry = (body: string): string =>
  edit([[`files:\n  - url: OneLaunch-1.0.0-beta.4-setup.exe\n    sha512: ${SHA}\n    size: 50\n`, `files:${body}\n`]]);

interface Spec {
  id: string;
  origin: Case['origin'];
  yaml?: string;
  keys?: ReleaseKey[];
  arg?: ReturnType<typeof bytes> | ReturnType<typeof file>;
}

const fx = (change: string) => fixture(SIGNED, change);
const ft = (...parts: string[]) => {
  const last = parts[parts.length - 1]!;
  if (!last.startsWith('| ')) return fromTest(TESTS, ...parts);
  const titles = parts.slice(0, -1);
  titles[titles.length - 1] = `${titles[titles.length - 1]} ${last}`;
  return fromTest(TESTS, ...titles);
};

const specs: Spec[] = [
  { id: 'fixture-accepted', origin: fixture(SIGNED), arg: file(SIGNED) },
  {
    id: 'fixture-accepted-among-pinned',
    origin: fixture(SIGNED, 'trusted list is the pinned keys then the throwaway key'),
    yaml: signed,
    keys: [...PINNED, THROWAWAY],
  },
  { id: 'fixture-accepted-key-twice', origin: fixture(SIGNED, 'the throwaway key listed twice'), yaml: signed, keys: [THROWAWAY, THROWAWAY] },
  {
    id: 'accepted-extra-fields',
    origin: fx('unknown top-level and file-entry fields added'),
    yaml: edit([['size: 50\n', 'size: 50\n    blockMapSize: 1234\n    isAdminRightsRequired: false\n']]) + 'stagingPercentage: 50\nreleaseNotes: notes\n',
  },
  { id: 'accepted-packages-null', origin: fx('packages: null added'), yaml: `${signed}packages: null\n` },
  { id: 'accepted-packages-tilde', origin: fx('packages: ~ added'), yaml: `${signed}packages: ~\n` },
  { id: 'accepted-crlf', origin: fx('LF made CRLF'), yaml: signed.replace(/\n/g, '\r\n') },
  { id: 'accepted-bom', origin: adversarial('other', `${SIGNED} with a UTF-8 BOM: js-yaml drops a leading U+FEFF before parsing`), yaml: `﻿${signed}` },
  {
    id: 'accepted-size-hex',
    origin: adversarial('number', `${SIGNED} with size: 0x32; js-yaml reads it as the integer 50, so the signature still matches`),
    yaml: edit([['size: 50', 'size: 0x32']]),
  },
  {
    id: 'accepted-size-float',
    origin: adversarial('number', `${SIGNED} with size: 50.0; js-yaml reads a float 50, a safe integer, and the payload prints 50`),
    yaml: edit([['size: 50', 'size: 50.0']]),
  },
  {
    id: 'accepted-size-exponent',
    origin: adversarial('number', `${SIGNED} with size: 5e1; YAML 1.2 core schema reads 50`),
    yaml: edit([['size: 50', 'size: 5e1']]),
  },
  {
    id: 'size-plus-sign',
    origin: adversarial('parseint', `${SIGNED} with size: +50; a leading plus is a YAML integer`),
    yaml: edit([['size: 50', 'size: +50']]),
  },
  {
    id: 'size-leading-zero',
    origin: adversarial('parseint', `${SIGNED} with size: 050; js-yaml's reading of a leading zero`),
    yaml: edit([['size: 50', 'size: 050']]),
  },
  {
    id: 'size-underscore',
    origin: adversarial('parseint', `${SIGNED} with size: 5_0; js-yaml's reading of an underscore`),
    yaml: edit([['size: 50', 'size: 5_0']]),
  },
  { id: 'size-octal', origin: adversarial('parseint', `${SIGNED} with size: 0o62 (50 in octal)`), yaml: edit([['size: 50', 'size: 0o62']]) },
  { id: 'size-quoted', origin: fx('size quoted as a string'), yaml: edit([['size: 50', "size: '50'"]]) },

  { id: 'no-keys', origin: ft('release manifest signatures', 'refuses everything when the build pins no key'), yaml: signed, keys: [] },
  { id: 'no-keys-unsigned', origin: fixture(UNSIGNED, 'no trusted keys'), arg: file(UNSIGNED), keys: [] },
  {
    id: 'not-object-null',
    origin: ft('release manifest signatures', 'refuses fields that could smuggle a second line into the signed payload', '| the manifest is YAML null'),
    yaml: 'null\n',
  },
  { id: 'not-object-empty', origin: fx('an empty document, which js-yaml loads as undefined'), yaml: '' },
  { id: 'not-object-number', origin: fx('the whole document is the number 42'), yaml: '42\n' },
  { id: 'not-object-string', origin: fx('the whole document is a string'), yaml: 'version 1.0.0\n' },
  { id: 'not-object-false', origin: fx('the whole document is false'), yaml: 'false\n' },
  { id: 'array-document', origin: fx('the whole document is a sequence'), yaml: '- 1\n- 2\n' },

  {
    id: 'packages-web-installer',
    origin: ft('release manifest signatures', 'refuses shapes the updater would treat differently from what was signed'),
    yaml: `${signed}packages:\n  x64:\n    path: p.7z\n    sha512: ${SHA}\n`,
  },
  { id: 'packages-zero', origin: fx('packages: 0'), yaml: `${signed}packages: 0\n` },
  { id: 'packages-false', origin: fx('packages: false'), yaml: `${signed}packages: false\n` },
  { id: 'packages-empty-string', origin: fx("packages: ''"), yaml: `${signed}packages: ''\n` },
  {
    id: 'files-two',
    origin: ft('release manifest signatures', 'refuses shapes the updater would treat differently from what was signed | two file entries'),
    yaml: fileEntry(
      `\n  - url: OneLaunch-1.0.0-beta.4-setup.exe\n    sha512: ${SHA}\n    size: 50\n  - url: OneLaunch-1.0.0-beta.4-setup.exe\n    sha512: ${SHA}\n    size: 50`,
    ),
  },
  {
    id: 'files-empty',
    origin: ft('release manifest signatures', 'refuses shapes the updater would treat differently from what was signed | files: []'),
    yaml: fileEntry(' []'),
  },
  { id: 'files-missing', origin: fx('the files list removed'), yaml: fileEntry('').replace('files:\n', '') },
  {
    id: 'files-mapping',
    origin: fx('files is a mapping, not a list'),
    yaml: fileEntry(`\n  url: OneLaunch-1.0.0-beta.4-setup.exe\n  sha512: ${SHA}\n  size: 50`),
  },
  { id: 'files-string', origin: fx('files is a string'), yaml: fileEntry(' OneLaunch-1.0.0-beta.4-setup.exe') },
  { id: 'entry-null', origin: fx('the one file entry is null'), yaml: fileEntry('\n  - null') },
  { id: 'entry-string', origin: fx('the one file entry is a string'), yaml: fileEntry('\n  - OneLaunch-1.0.0-beta.4-setup.exe') },
  { id: 'entry-number', origin: fx('the one file entry is a number'), yaml: fileEntry('\n  - 0') },
  { id: 'entry-sequence', origin: fx('the one file entry is an empty sequence'), yaml: fileEntry('\n  - []') },
  {
    id: 'entry-admin-rights',
    origin: ft('release manifest signatures', 'refuses shapes the updater would treat differently from what was signed', '| isAdminRightsRequired: true'),
    yaml: edit([['size: 50\n', 'size: 50\n    isAdminRightsRequired: true\n']]),
  },
  {
    id: 'entry-admin-rights-string',
    origin: fx("isAdminRightsRequired: 'true', a string, is not true"),
    yaml: edit([['size: 50\n', "size: 50\n    isAdminRightsRequired: 'true'\n"]]),
  },
  {
    id: 'entry-admin-rights-before-version',
    origin: fx('isAdminRightsRequired: true and the version removed: unsupported wins'),
    yaml: without('version').replace('size: 50\n', 'size: 50\n    isAdminRightsRequired: true\n'),
  },

  {
    id: 'version-changed',
    origin: ft('release manifest signatures', 'refuses a manifest whose %s changed after signing | version'),
    yaml: edit([['version: 1.0.0-beta.4', 'version: 1.0.0-beta.5']]),
  },
  { id: 'version-missing', origin: fx('version removed'), yaml: without('version') },
  { id: 'version-number', origin: fx('version: 1.0, which YAML reads as a float'), yaml: edit([['version: 1.0.0-beta.4', 'version: 1.0']]) },
  {
    id: 'version-newline',
    origin: ft('release manifest signatures', 'refuses fields that could smuggle a second line into the signed payload | version "1.0.0\\n"'),
    yaml: edit([['version: 1.0.0-beta.4', 'version: "1.0.0\\n"']]),
  },
  { id: 'version-v-prefix', origin: fx('version v1.0.0-beta.4'), yaml: edit([['version: 1.0.0-beta.4', 'version: v1.0.0-beta.4']]) },
  { id: 'version-empty-pre', origin: fx('version 1.0.0-'), yaml: edit([['version: 1.0.0-beta.4', "version: '1.0.0-'"]]) },
  { id: 'version-build', origin: fx('version with build metadata 1.0.0-beta.4+b1'), yaml: edit([['version: 1.0.0-beta.4', 'version: 1.0.0-beta.4+b1']]) },
  { id: 'version-two-part', origin: fx("version '1.0'"), yaml: edit([['version: 1.0.0-beta.4', "version: '1.0'"]]) },
  {
    id: 'version-long',
    origin: fx('a 200-character prerelease: verifyManifest has no length cap, so it reaches the signature check'),
    yaml: edit([['version: 1.0.0-beta.4', `version: 1.0.0-${'a'.repeat(200)}`]]),
  },
  {
    id: 'version-arabic-digit',
    origin: adversarial('unicode-digit', `${SIGNED} with version ١.0.0: JS \\d is ASCII only, a Unicode \\d would accept it`),
    yaml: edit([['version: 1.0.0-beta.4', 'version: ١.0.0-beta.4']]),
  },
  {
    id: 'url-changed',
    origin: ft('release manifest signatures', 'refuses a manifest whose %s changed after signing | file name'),
    yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', 'url: OneLaunch-evil-setup.exe']]),
  },
  {
    id: 'url-newline',
    origin: ft('release manifest signatures', 'refuses fields that could smuggle a second line into the signed payload | url "a.exe\\n1.0.0"'),
    yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', 'url: "a.exe\\n1.0.0"']]),
  },
  {
    id: 'url-traversal',
    origin: ft('release manifest signatures', 'refuses fields that could smuggle a second line into the signed payload | url ../OneLaunch.exe'),
    yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', 'url: ../OneLaunch.exe']]),
  },
  { id: 'url-missing', origin: fx('url removed from the file entry'), yaml: edit([['  - url: OneLaunch-1.0.0-beta.4-setup.exe\n    sha512', '  - sha512']]) },
  { id: 'url-upper-ext', origin: fx('url with .EXE'), yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', 'url: OneLaunch-1.0.0-beta.4-setup.EXE']]) },
  { id: 'url-bare-ext', origin: fx('url .exe'), yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', "url: '.exe'"]]) },
  { id: 'url-space', origin: fx('url with a space'), yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', 'url: One Launch.exe']]) },
  {
    id: 'url-trailing-space-quoted',
    origin: fx('url with a quoted trailing space'),
    yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', "url: 'OneLaunch-1.0.0-beta.4-setup.exe '"]]),
  },
  {
    id: 'url-trailing-space-plain',
    origin: fx('url with an unquoted trailing space, which YAML drops'),
    yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe\n', 'url: OneLaunch-1.0.0-beta.4-setup.exe   \n']]),
  },
  {
    id: 'url-full-address',
    origin: fx('url as a full https address'),
    yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', 'url: https://example.com/OneLaunch.exe']]),
  },
  { id: 'url-non-ascii', origin: fx('url with a non-ASCII letter'), yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', 'url: OneLaunché.exe']]) },
  { id: 'url-number', origin: fx('url is a number'), yaml: edit([['url: OneLaunch-1.0.0-beta.4-setup.exe', 'url: 12']]) },
  {
    id: 'sha-changed',
    origin: ft('release manifest signatures', 'refuses a manifest whose %s changed after signing | hash'),
    yaml: edit([[`    sha512: ${SHA}`, `    sha512: ${'A'.repeat(86)}==`]]),
  },
  { id: 'sha-missing', origin: fx('sha512 removed from the file entry'), yaml: edit([[`    sha512: ${SHA}\n`, '']]) },
  { id: 'sha-short', origin: fx('sha512 one character short'), yaml: edit([[`    sha512: ${SHA}`, `    sha512: ${SHA.slice(1)}`]]) },
  { id: 'sha-no-padding', origin: fx('sha512 without its == padding'), yaml: edit([[`    sha512: ${SHA}`, `    sha512: ${SHA.slice(0, -2)}`]]) },
  { id: 'sha-url-safe', origin: fx('sha512 in URL-safe base64'), yaml: edit([[`    sha512: ${SHA}`, `    sha512: ${SHA.replace(/\//g, '_')}`]]) },
  {
    id: 'sha-hex',
    origin: fx('sha512 as 128 hex characters'),
    yaml: edit([[`    sha512: ${SHA}`, `    sha512: ${Buffer.from(SHA, 'base64').toString('hex')}`]]),
  },
  {
    id: 'size-changed',
    origin: ft('release manifest signatures', 'refuses a manifest whose %s changed after signing | size'),
    yaml: edit([['size: 50', 'size: 51']]),
  },
  {
    id: 'size-negative',
    origin: ft('release manifest signatures', 'refuses fields that could smuggle a second line into the signed payload | size -1'),
    yaml: edit([['size: 50', 'size: -1']]),
  },
  { id: 'size-zero', origin: fx('size 0'), yaml: edit([['size: 50', 'size: 0']]) },
  { id: 'size-fraction', origin: fx('size 50.5'), yaml: edit([['size: 50', 'size: 50.5']]) },
  { id: 'size-missing', origin: fx('size removed'), yaml: edit([['    size: 50\n', '']]) },
  { id: 'cap-size-safe-at', origin: fx('size 9007199254740991, the largest safe integer'), yaml: edit([['size: 50', 'size: 9007199254740991']]) },
  { id: 'cap-size-safe-over', origin: fx('size 9007199254740992, one over the largest safe integer'), yaml: edit([['size: 50', 'size: 9007199254740992']]) },
  { id: 'size-infinity', origin: fx('size .inf'), yaml: edit([['size: 50', 'size: .inf']]) },
  { id: 'size-nan', origin: fx('size .nan'), yaml: edit([['size: 50', 'size: .nan']]) },

  {
    id: 'unsigned',
    origin: ft('release manifest signatures', 'refuses an unsigned manifest and malformed signatures'),
    arg: file(UNSIGNED),
  },
  {
    id: 'signature-short',
    origin: ft('release manifest signatures', 'refuses an unsigned manifest and malformed signatures', "| signature: 'abc'"),
    yaml: edit([[`signature: '${SIG}'`, "signature: 'abc'"]]),
  },
  {
    id: 'signature-missing-keyid-kept',
    origin: ft('release manifest signatures', 'refuses an unsigned manifest and malformed signatures | signature removed, keyId kept'),
    yaml: without('signature'),
  },
  {
    id: 'keyid-not-hex',
    origin: ft('release manifest signatures', 'refuses an unsigned manifest and malformed signatures', "| keyId: 'NOT-HEX'"),
    yaml: edit([[`keyId: '${THROWAWAY.id}'`, "keyId: 'NOT-HEX'"]]),
  },
  { id: 'keyid-missing-signature-kept', origin: fx('keyId removed, signature kept'), yaml: without('keyId') },
  { id: 'keyid-upper-hex', origin: fx('keyId in upper-case hex'), yaml: edit([[`keyId: '${THROWAWAY.id}'`, `keyId: '${THROWAWAY.id.toUpperCase()}'`]]) },
  {
    id: 'keyid-number',
    origin: fx('keyId as an unquoted all-digit value, which YAML reads as a number'),
    yaml: edit([[`keyId: '${THROWAWAY.id}'`, 'keyId: 3376123012345678']]),
  },
  { id: 'keyid-null', origin: fx('keyId: null with the signature kept'), yaml: edit([[`keyId: '${THROWAWAY.id}'`, 'keyId: null']]) },
  {
    id: 'signature-null-keyid-null',
    origin: fx('signature: null and keyId: null: present but not strings'),
    yaml: edit([
      [`signature: '${SIG}'`, 'signature: null'],
      [`keyId: '${THROWAWAY.id}'`, 'keyId: null'],
    ]),
  },
  { id: 'signature-number', origin: fx('signature is a number'), yaml: edit([[`signature: '${SIG}'`, 'signature: 7']]) },
  { id: 'signature-no-padding', origin: fx('signature without its == padding'), yaml: edit([[`signature: '${SIG}'`, `signature: '${SIG.slice(0, -2)}'`]]) },
  { id: 'keyid-short', origin: fx('keyId 15 hex characters'), yaml: edit([[`keyId: '${THROWAWAY.id}'`, `keyId: '${THROWAWAY.id.slice(1)}'`]]) },

  {
    id: 'unknown-key',
    origin: ft(
      'release manifest signatures',
      'refuses a key it does not pin, even when it names a pinned key id',
      '| the throwaway key is not in the pinned list',
    ),
    yaml: signed,
    keys: PINNED,
  },
  {
    id: 'forged-pinned-keyid',
    origin: ft('release manifest signatures', 'refuses a key it does not pin, even when it names a pinned key id', '| keyId set to the primary pinned id'),
    yaml: edit([[`keyId: '${THROWAWAY.id}'`, `keyId: '${PINNED[0]!.id}'`]]),
    keys: PINNED,
  },
  { id: 'signature-flipped', origin: fx('the first signature character changed'), yaml: edit([[`signature: '${SIG}'`, `signature: 'X${SIG.slice(1)}'`]]) },
  {
    id: 'top-level-path-ignored',
    origin: fx('the top-level path and sha512 changed: they are not signed and not read'),
    yaml: edit([['path: OneLaunch-1.0.0-beta.4-setup.exe', 'path: other.exe']]),
  },
  {
    id: 'trusted-key-garbage-spki',
    origin: fx('the trusted key carries the throwaway id but an SPKI that is not a key'),
    yaml: signed,
    keys: [{ id: THROWAWAY.id, spki: 'garbage' }],
  },
  {
    id: 'trusted-key-other-ed25519',
    origin: fx('the trusted key carries the throwaway id but the primary pinned SPKI'),
    yaml: signed,
    keys: [{ id: THROWAWAY.id, spki: PINNED[0]!.spki }],
  },
  {
    id: 'trusted-key-not-ed25519',
    origin: fx('the trusted key carries the throwaway id but a P-256 SPKI'),
    yaml: signed,
    keys: [{ id: THROWAWAY.id, spki: P256_SPKI }],
  },
  {
    id: 'invalid-utf8-in-url',
    origin: adversarial('utf8-decode', `${SIGNED} with a 0xFF byte in the url; the decode gives U+FFFD and the name check refuses it`),
    arg: bytes(Buffer.from(signed.replace('url: OneLaunch-1.0.0', 'url: OneLaunch\xff-1.0.0'), 'latin1')),
  },
];

const manifestCases = (): Case[] =>
  specs.map((s) => ({
    id: s.id,
    origin: s.origin,
    args: [s.arg ?? text(s.yaml!), s.keys ?? TRUSTED],
    expect: 'out',
  }));

vectorFile({
  area: 'core',
  function: 'verifyManifest',
  source: 'src/main/updates/manifest.ts',
  decode: { 0: 'utf8' },
  note: [
    "arg0 is latest.yml as the update feed serves it. electron-updater's HTTP executor reads the body with setEncoding('utf8') (BOM kept, invalid bytes become U+FFFD) and its Provider.parseUpdateInfo loads it with js-yaml 4 (which drops one leading U+FEFF); src/main/updates/engine.ts hands the result to update-service.ts, which calls verifyManifest(info, keys).",
    "call runs parseUpdateInfo(arg0, 'latest.yml', 'feed') from electron-updater/out/providers/Provider.js, then verifyManifest on the loaded value with arg1 as the trusted keys. The GitHub provider also adds tag, releaseName and releaseNotes to the loaded object; verifyManifest never reads them, so they are left out. The Rust port must load the YAML the way js-yaml 4 does (core schema: 0x hex, 0o octal, .inf, .nan, a leading U+FEFF dropped).",
    "Signed bytes come from fixtures/updates/latest.yml, signed once with the throwaway Ed25519 key whose public half is in fixtures/updates/README-keys.json; no key is generated here, so Ed25519's deterministic signatures keep the output fixed. Every refusal reason ('no-keys', 'malformed', 'unsupported', 'unsigned', 'unknown-key', 'bad-signature') has cases, with the exact detail text. The non-Ed25519 key is the P-256 generator point as a public key.",
    'Gaps: a YAML document js-yaml refuses (a duplicate key, bad indentation) throws from parseUpdateInfo with its stack in the message, which is not verifyManifest and not repeatable, so no case has one.',
  ].join('\n'),
  call: (yaml: string, keys: ReleaseKey[]) => verifyManifest(parseUpdateInfo(yaml, 'latest.yml', 'feed'), keys),
  cases: manifestCases,
});

const FILE = { url: 'OneLaunch-1.0.0-beta.4-setup.exe', sha512: SHA, size: 50 };

vectorFile({
  area: 'core',
  function: 'canonicalPayload',
  source: 'src/main/updates/manifest.ts',
  note: [
    'arg0 is the version, arg1 the file entry { url, sha512, size }, as verifyManifest passes them after its checks; scripts/release-sign.mjs signs the same string as UTF-8 bytes.',
    "Cases outside verifyManifest's checks (a newline in a field, a non-integer size) show the template literal's own formatting: a number prints as JS String(n) does, a missing field as 'undefined'.",
  ].join('\n'),
  call: canonicalPayload,
  cases: [
    {
      id: 'test-literal',
      origin: ft('release manifest signatures', 'signs a fixed, newline-separated payload'),
      args: ['1.2.3', { url: 'a.exe', sha512: 'h', size: 7 }],
      expect: 'out',
    },
    { id: 'fixture-latest', origin: fixture(SIGNED, 'the version and file entry it signs'), args: ['1.0.0-beta.4', FILE], expect: 'out' },
    {
      id: 'large-size',
      origin: fixture(SIGNED, 'size 112000000 as in test/update-manifest.test.ts'),
      args: ['1.0.0-beta.2', { ...FILE, size: 112_000_000 }],
      expect: 'out',
    },
    {
      id: 'size-max-safe',
      origin: adversarial('number', 'size 9007199254740991 prints all its digits'),
      args: ['1.0.0', { ...FILE, size: 9007199254740991 }],
      expect: 'out',
    },
    { id: 'size-exponent', origin: adversarial('number', 'size 1e21 prints as 1e+21 in JS'), args: ['1.0.0', { ...FILE, size: 1e21 }], expect: 'out' },
    { id: 'size-fraction', origin: adversarial('number', 'size 0.1 prints as 0.1'), args: ['1.0.0', { ...FILE, size: 0.1 }], expect: 'out' },
    { id: 'size-tiny', origin: adversarial('number', 'size 1e-7 prints as 1e-7'), args: ['1.0.0', { ...FILE, size: 1e-7 }], expect: 'out' },
    { id: 'size-negative-zero', origin: adversarial('number', 'size -0 prints as 0'), args: ['1.0.0', { ...FILE, size: -0 }], expect: 'out' },
    { id: 'size-nan', origin: adversarial('number', 'size NaN prints as NaN'), args: ['1.0.0', { ...FILE, size: Number.NaN }], expect: 'out' },
    {
      id: 'size-string',
      origin: adversarial('number', 'size given as the string 050 is printed as it is'),
      args: ['1.0.0', { ...FILE, size: '050' }],
      expect: 'out',
    },
    {
      id: 'newline-in-url',
      origin: ft(
        'release manifest signatures',
        'refuses fields that could smuggle a second line into the signed payload',
        '| the payload the tricky url would give',
      ),
      args: ['1.0.0-beta.2', { ...FILE, url: 'a.exe\n1.0.0' }],
      expect: 'out',
    },
    { id: 'missing-fields', origin: adversarial('other', 'an empty file entry: each field prints as undefined'), args: ['1.0.0', {}], expect: 'out' },
    {
      id: 'non-ascii',
      origin: adversarial('utf16-length', 'non-ASCII and astral characters pass through as they are'),
      args: ['1.0.0-é', { ...FILE, url: 'Ünï-😀.exe' }],
      expect: 'out',
    },
    {
      id: 'lone-surrogate',
      origin: adversarial('lone-surrogate', 'a lone high surrogate in the url stays in the string; signing would encode it as U+FFFD'),
      args: ['1.0.0', { ...FILE, url: 'a\ud800.exe' }],
      expect: 'out',
    },
    { id: 'empty', origin: adversarial('other', 'empty version and fields'), args: ['', { url: '', sha512: '', size: 0 }], expect: 'out' },
  ],
});
