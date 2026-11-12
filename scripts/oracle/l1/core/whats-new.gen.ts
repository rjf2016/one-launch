import { readFileSync } from 'node:fs';
import { adversarial, fromTest, vectorFile, type Case } from '../lib/index';
import { compareVersions, pickWhatsNew, type WhatsNewRelease } from '../../../../src/shared/whats-new';
import { WHATS_NEW } from '../../../../src/shared/whats-new-releases';

const TESTS = 'test/whats-new.test.ts';
const t = (...titles: string[]) => fromTest(TESTS, ...titles);

const ORDERED = ['0.9.0', '1.0.0-alpha', '1.0.0-beta.2', '1.0.0-beta.2.1', '1.0.0-beta.10', '1.0.0-rc.1', '1.0.0-test', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
const slug = (v: string) => (v === '' ? 'empty' : v.replace(/[^a-z0-9]+/gi, '_').toLowerCase());

const pairs: [string, string, string, Case['origin']][] = [
  ['leading-zero-core', '01.0.0', '1.0.0', adversarial('parseint', 'Number("01") is 1, so 01.0.0 equals 1.0.0')],
  ['leading-zero-pre', '1.0.0-01', '1.0.0-1', adversarial('parseint', 'numeric prerelease ids compare by Number, so 01 equals 1')],
  [
    'beyond-safe-core',
    '9007199254740993.0.0',
    '9007199254740992.0.0',
    adversarial('number', 'core numbers past 2^53 round to the same double and compare equal'),
  ],
  ['beyond-safe-pre', '1.0.0-9007199254740993', '1.0.0-9007199254740992', adversarial('number', 'prerelease numbers past 2^53 compare equal')],
  ['huge-core', '1e400.0.0', '1.0.0', adversarial('parseint', 'Number("1e400") is Infinity, so Infinity - 1 is Infinity: greater')],
  ['huge-both', '1e400.0.0', '1e401.0.0', adversarial('number', 'Infinity - Infinity is NaN, and a NaN difference returns 1 both ways')],
  ['not-a-number-a', 'v1.0.0', '1.0.0', adversarial('parseint', 'Number("v1") is NaN; the NaN difference is not 0 and not below 0, so the answer is 1')],
  ['not-a-number-b', '1.0.0', 'v1.0.0', adversarial('parseint', 'the same pair the other way round is also 1: not antisymmetric')],
  ['space-core', ' 1.0.0', '1.0.0', adversarial('parseint', 'Number(" 1") is 1: leading spaces are ignored')],
  ['nbsp-core', ' 1.0.0', '1.0.0', adversarial('unicode-space', 'Number trims U+00A0 and U+FEFF too')],
  ['hex-core', '0x2.0.0', '2.0.0', adversarial('parseint', 'Number("0x2") is 2')],
  ['plus-core', '+1.0.0', '1.0.0', adversarial('parseint', 'Number("+1") is 1')],
  ['exponent-core', '1e1.0.0', '10.0.0', adversarial('parseint', 'Number("1e1") is 10')],
  ['empty-core-part', '1..0', '1.0.0', adversarial('parseint', 'Number("") is 0')],
  ['two-part', '1.0', '1.0.0', adversarial('other', 'a missing third part counts as 0')],
  ['four-part', '1.0.0.5', '1.0.0', adversarial('other', 'a fourth part is ignored')],
  ['build-metadata', '1.0.0+b1', '1.0.0', adversarial('parseint', 'build metadata is not split off: Number("0+b1") is NaN')],
  ['empty-strings', '', '', adversarial('other', 'two empty strings are equal')],
  ['empty-vs-zero', '', '0.0.0', adversarial('other', 'the empty string reads as 0.0.0')],
  ['dash-only', '-', '0.0.0', adversarial('other', 'a lone dash is a prerelease of 0.0.0')],
  ['empty-pre', '1.0.0-', '1.0.0', adversarial('other', 'a trailing dash makes an empty prerelease, which sorts before the release')],
  ['empty-pre-id-vs-zero', '1.0.0-', '1.0.0-0', adversarial('other', 'an empty prerelease id is not numeric, so it sorts after 0')],
  ['numeric-before-alpha', '1.0.0-1', '1.0.0-a', adversarial('other', 'numeric ids sort before alphanumeric ones')],
  ['ascii-order', '1.0.0-B', '1.0.0-a', adversarial('sort', 'alphanumeric ids compare by UTF-16 code unit, so B is before a')],
  ['hyphen-in-pre', '1.0.0-a-b', '1.0.0-a', adversarial('other', 'only the first dash starts the prerelease; a-b is one id')],
  ['dash-in-core', '1-0.0.0', '1.0.0', adversarial('other', 'a dash inside the core cuts it short')],
  ['longer-pre', '1.0.0-a.b', '1.0.0-a', adversarial('other', 'a longer prerelease with an equal prefix is greater')],
  [
    'arabic-digit-pre',
    '1.0.0-١',
    '1.0.0-2',
    adversarial('unicode-digit', 'JS \\d is ASCII, so ١ is an alphanumeric id and sorts after 2; a Unicode \\d would call it numeric'),
  ],
  ['fullwidth-digit-core', '１.0.0', '0.0.0', adversarial('unicode-digit', 'Number("１") is NaN')],
  ['astral-vs-bmp', '1.0.0-😀', '1.0.0-～', adversarial('sort', 'code-unit order puts the emoji (D83D) before U+FF5E; UTF-8 byte order puts it after')],
  ['non-ascii-pre', '1.0.0-é', '1.0.0-z', adversarial('sort', 'é (U+00E9) sorts after z by code unit')],
  ['lone-surrogate-pre', '1.0.0-\ud800', '1.0.0-￿', adversarial('lone-surrogate', 'a lone surrogate compares by its code unit')],
  ['negative-core', '1.-1.0', '1.0.0', adversarial('parseint', 'a dash inside the core starts the prerelease, so the core is 1 and -1.0 is the prerelease')],
  ['whitespace-pre', '1.0.0- 1', '1.0.0-1', adversarial('unicode-space', 'a space makes the id non-numeric for /^\\d+$/')],
];

const compareCases: Case[] = [
  ...ORDERED.flatMap((a) =>
    ORDERED.map((b) => ({
      id: `ordered.${slug(a)}.vs.${slug(b)}`,
      origin: t('compareVersions', 'orders the numeric core, then a prerelease before its release, then prerelease ids numerically or alphabetically'),
      args: [a, b],
      expect: 'out' as const,
    })),
  ),
  ...pairs.flatMap(([id, a, b, origin]) => [
    { id: `${id}.ab`, origin, args: [a, b], expect: 'out' as const },
    { id: `${id}.ba`, origin, args: [b, a], expect: 'out' as const },
  ]),
];

vectorFile({
  area: 'core',
  function: 'compareVersions',
  source: 'src/shared/whats-new.ts',
  note: [
    "arg0 and arg1 are version strings (package.json versions and the What's New table; never file text). The function does not validate them: the adversarial pairs show what Number() and code-unit string order do with strings pickWhatsNew would refuse.",
    "Every pair of the test's ordered list is a case (121), and every adversarial pair is run both ways (.ab and .ba).",
  ].join('\n'),
  call: compareVersions,
  cases: compareCases,
});

const release = (version: string): WhatsNewRelease => ({
  version,
  date: '2026-10-01',
  sections: [{ heading: 'Changes', items: [{ lead: 'Something changed.' }] }],
});
const BETAS = [release('1.0.0-beta.5'), release('1.0.0-beta.3'), release('1.0.0-beta.1')];
const PICK = 'returns the newest unseen entry at or below the running version';
const NONE = 'treats nothing seen, or something that is not a version, as older than every entry';
const LATEST = 'latestWhatsNew ignores what was seen';
const pkgVersion = (JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const pick = (id: string, releases: WhatsNewRelease[], current: unknown, lastSeen: unknown, origin: Case['origin']): Case => ({
  id,
  origin,
  args: [releases, current, lastSeen],
  expect: 'out',
});
const long = (n: number) => `1.0.0-${'a'.repeat(n - 6)}`;

const pickCases: Case[] = [
  pick('beta5-seen3', BETAS, '1.0.0-beta.5', '1.0.0-beta.3', t('pickWhatsNew', PICK)),
  pick('beta6-seen3', BETAS, '1.0.0-beta.6', '1.0.0-beta.3', t('pickWhatsNew', PICK)),
  pick('beta4-seen3', BETAS, '1.0.0-beta.4', '1.0.0-beta.3', t('pickWhatsNew', PICK)),
  pick('beta5-seen5', BETAS, '1.0.0-beta.5', '1.0.0-beta.5', t('pickWhatsNew', PICK)),
  pick('beta3-seen5', BETAS, '1.0.0-beta.3', '1.0.0-beta.5', t('pickWhatsNew', PICK)),
  pick('beta5-seen-null', BETAS, '1.0.0-beta.5', null, t('pickWhatsNew', NONE)),
  pick('beta2-seen-null', BETAS, '1.0.0-beta.2', null, t('pickWhatsNew', NONE)),
  pick('beta3-seen-garbage', BETAS, '1.0.0-beta.3', 'garbage', t('pickWhatsNew', NONE)),
  pick('current-not-a-version', BETAS, 'not a version', null, t('pickWhatsNew', NONE)),
  pick('no-releases', [], '1.0.0-beta.5', null, t('pickWhatsNew', NONE)),
  pick('latest-beta5', BETAS, '1.0.0-beta.5', null, t('pickWhatsNew', LATEST)),
  pick('latest-beta4', BETAS, '1.0.0-beta.4', null, t('pickWhatsNew', LATEST)),
  pick('latest-beta0', BETAS, '1.0.0-beta.0', null, t('pickWhatsNew', LATEST)),
  pick('app-table-fresh', [...WHATS_NEW], pkgVersion, null, adversarial('other', "the app's own WHATS_NEW table at package.json's version, nothing seen")),
  pick('app-table-seen-current', [...WHATS_NEW], pkgVersion, pkgVersion, adversarial('other', "the app's own table with the current version already seen")),
  pick('cap-current-length-at', [release(long(64))], long(64), null, adversarial('utf16-length', 'a 64-character version is a version')),
  pick('cap-current-length-over', [release(long(65))], long(65), null, adversarial('utf16-length', 'a 65-character version is not')),
  pick(
    'cap-seen-length-over',
    BETAS,
    '1.0.0-beta.5',
    long(65),
    adversarial('utf16-length', 'a 65-character lastSeen is not a version, so it counts as nothing seen'),
  ),
  pick(
    'cap-release-length-over',
    [release(long(65)), release('1.0.0-beta.1')],
    '9.0.0',
    null,
    adversarial('utf16-length', 'a release whose version is 65 characters is skipped'),
  ),
  pick(
    'unsorted-input',
    [release('1.0.0-beta.1'), release('1.0.0-beta.5'), release('1.0.0-beta.3')],
    '1.0.0-beta.9',
    null,
    adversarial('sort', 'the newest is found whatever the order of the list'),
  ),
  pick(
    'equal-versions-first-wins',
    [
      { ...release('1.0.0'), date: '2026-01-01' },
      { ...release('01.0.0'), date: '2026-02-02' },
    ],
    '2.0.0',
    null,
    adversarial('parseint', '1.0.0 and 01.0.0 compare equal; the first in the list is kept'),
  ),
  pick(
    'leading-zero-current',
    BETAS,
    '01.0.0-beta.5',
    null,
    adversarial('parseint', 'a current version with a leading zero passes the shape check and reads as 1'),
  ),
  pick(
    'release-not-a-version',
    [release('v1.0.0'), release('1.0.0-beta.1')],
    '1.0.0',
    null,
    adversarial('other', 'a release whose version is not a version is skipped'),
  ),
  pick(
    'current-trailing-newline',
    BETAS,
    '1.0.0-beta.5\n',
    null,
    adversarial('regex', 'JS $ without the m flag does not match before a final newline, so the version is refused'),
  ),
  pick('current-arabic-digit', BETAS, '١.0.0', null, adversarial('unicode-digit', 'JS \\d is ASCII, so ١.0.0 is not a version')),
  pick('current-number', BETAS, 1, null, adversarial('other', 'a current version that is not a string')),
  pick('seen-number', BETAS, '1.0.0-beta.5', 1, adversarial('other', 'a lastSeen that is not a string counts as nothing seen')),
  pick('seen-newer-than-all', BETAS, '1.0.0-beta.5', '2.0.0', adversarial('other', 'everything at or below the current version is already seen')),
  pick(
    'release-above-current',
    [release('2.0.0'), release('1.0.0-beta.1')],
    '1.0.0',
    null,
    adversarial('other', 'a release above the running version is skipped'),
  ),
  pick(
    'prerelease-vs-release',
    [release('1.0.0'), release('1.0.0-rc.1')],
    '1.0.0-rc.2',
    null,
    adversarial('other', 'a running prerelease does not see the release it precedes'),
  ),
];

vectorFile({
  area: 'core',
  function: 'pickWhatsNew',
  source: 'src/shared/whats-new.ts',
  note: [
    "arg0 is the release list (src/shared/whats-new-releases.ts WHATS_NEW in the app; small lists here, and the real table in the app-table-* cases), arg1 the running version (app.getVersion(), package.json's version), arg2 the whatsNew.lastSeen setting or null. The result is the release object itself, or null.",
    "The app-table-* cases carry the pinned WHATS_NEW table and package.json's version as plain values.",
    'The one length limit is MAX_VERSION_LENGTH, 64 UTF-16 units, applied to arg1, arg2 and each release version (cap-*).',
  ].join('\n'),
  call: pickWhatsNew,
  cases: pickCases,
});
