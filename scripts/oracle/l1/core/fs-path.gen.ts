import { adversarial, fromTest, vectorFile, type Case } from '../lib/index';
import { normalizeLauncherPath, pathKey } from '../../../../src/main/platform/fs-path';

const TESTS = 'test/fs-path.test.ts';

const lifted: [string, string, string][] = [
  ['epic-mixed', 'unifies mixed separators from Epic manifests', 'C:\\Program Files\\Epic Games/rocketleague'],
  ['relative-forward', 'unifies mixed separators from Epic manifests', 'Binaries/Win64/Launcher.exe'],
  ['steam-registry', 'handles forward-slash Steam registry values', 'd:/games/steam'],
  ['vdf-escaped', 'unescapes VDF double backslashes', 'D:\\\\Games\\\\Steam'],
  ['trailing-separator', 'strips trailing separators but keeps drive roots', 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\'],
  ['drive-root', 'strips trailing separators but keeps drive roots', 'C:\\'],
];

const samePathLifted: [string, string][] = [
  ['samepath-steam-a', 'd:/games/steam'],
  ['samepath-steam-b', 'D:\\Games\\Steam\\'],
  ['samepath-steam2', 'D:\\Games\\Steam2'],
];

const extra: [string, Case['origin'], string][] = [
  ['empty', adversarial('other', 'the empty string normalises to "."'), ''],
  ['blank', adversarial('unicode-space', 'only spaces: trimmed to empty, then "."'), '   '],
  ['trim-ascii', adversarial('unicode-space', 'spaces, tabs and line breaks around a path are trimmed'), ' \t\r\nD:\\Games\\Steam \n'],
  [
    'trim-nbsp-feff',
    adversarial('unicode-space', 'JS trim removes U+00A0, U+FEFF and U+3000; Rust trim keeps U+FEFF'),
    '\u00a0\ufeffD:\\Games\\Steam\u3000\ufeff',
  ],
  ['trim-nel-kept', adversarial('unicode-space', 'JS trim keeps U+0085 (NEL) and U+180E; Rust trim removes U+0085'), '\u0085D:\\Games\\Steam\u180e'],
  ['trim-line-separator', adversarial('unicode-space', 'U+2028 and U+2029 are trimmed in JS'), '\u2028D:\\Games\\Steam\u2029'],
  ['drive-only', adversarial('other', 'a bare drive letter: win32 normalize gives "C:."'), 'C:'],
  ['drive-forward-root', adversarial('other', 'C:/ is the drive root'), 'C:/'],
  ['drive-relative', adversarial('other', 'a drive-relative path keeps its form'), 'D:Games\\Steam'],
  ['dot-segments', adversarial('other', '"." and ".." are resolved'), 'D:\\Games\\.\\Steam\\..\\Epic\\.\\'],
  ['dotdot-above-root', adversarial('other', '".." above the drive root stays at the root'), 'C:\\..\\..\\Windows'],
  ['relative-dotdot', adversarial('other', 'leading ".." of a relative path is kept'), '..\\..\\x\\..\\y'],
  [
    'unc-share',
    adversarial('other', 'a UNC path: the VDF unescape turns its leading \\\\ into \\, so it ends up rooted on the current drive'),
    '\\\\server\\share\\Games',
  ],
  ['unc-escaped', adversarial('other', 'a VDF-escaped UNC path (four backslashes) becomes a true UNC path'), '\\\\\\\\server\\\\share\\\\Games'],
  ['long-path-prefix', adversarial('other', 'the \\\\?\\ prefix'), '\\\\?\\C:\\Games\\Steam'],
  ['three-backslashes', adversarial('other', 'three backslashes in a row: one pair is unescaped, then the separators collapse'), 'D:\\\\\\Games'],
  ['many-separators', adversarial('other', 'runs of mixed separators collapse to one'), 'D:/\\//Games\\\\//Steam///'],
  [
    'short-trailing-two',
    adversarial('utf16-length', 'a two-unit relative path with a trailing separator keeps it: the trailing cut needs more than 3 units'),
    'a\\',
  ],
  ['short-trailing-three', adversarial('utf16-length', 'a three-unit path with a trailing separator keeps it'), 'ab\\'],
  ['short-trailing-four', adversarial('utf16-length', 'a four-unit path with a trailing separator loses it'), 'abc\\'],
  ['astral-trailing', adversarial('utf16-length', 'an emoji counts two units towards the more-than-3 test'), '😀\\'],
  ['root-only', adversarial('other', 'a lone backslash'), '\\'],
  ['forward-root-only', adversarial('other', 'a lone forward slash'), '/'],
  ['dot', adversarial('other', 'a lone dot'), '.'],
  ['trailing-dot-segment', adversarial('other', 'trailing dots and spaces in a segment are kept'), 'D:\\Games. \\Steam.'],
  ['stream-colon', adversarial('other', 'a colon later in the path is kept'), 'D:\\Games\\file.txt:stream'],
  ['non-ascii', adversarial('case-mapping', 'non-ASCII letters pass through normalisation as they are'), 'E:\\Spiele\\ÄÖÜ\\İstanbul\\Straße'],
  ['lone-surrogate', adversarial('lone-surrogate', 'a lone surrogate in a segment is kept'), 'E:\\x\ud800\\y'],
  ['env-placeholder', adversarial('other', 'an unexpanded %VAR% is left as text'), '%ProgramFiles%\\Epic Games'],
];

const caseKeys: [string, Case['origin'], string][] = [
  ['lower-dotted-i', adversarial('case-mapping', 'İ (U+0130) lowercases to i + U+0307, two units'), 'E:\\İstanbul'],
  ['lower-dotless-i', adversarial('case-mapping', 'ı (U+0131) has no lower form change; I lowercases to i'), 'E:\\ıI'],
  ['lower-sharp-s', adversarial('case-mapping', 'ẞ (U+1E9E) lowercases to ß; ß stays'), 'E:\\STRAẞE\\Straße'],
  ['lower-final-sigma', adversarial('case-mapping', 'JS lowercases a word-final Σ to ς and an inner one to σ'), 'E:\\ΟΔΟΣ\\ΣΑ'],
  ['lower-kelvin', adversarial('case-mapping', 'the Kelvin sign U+212A lowercases to k'), 'E:\\\u212Aelvin'],
  ['lower-fullwidth', adversarial('case-mapping', 'fullwidth letters lowercase to fullwidth'), 'E:\\ＡＢＣ'],
  ['lower-cherokee', adversarial('case-mapping', 'Cherokee capital letters lowercase to the small block added in Unicode 8'), 'E:\\Ꭰ'],
  ['lower-astral', adversarial('case-mapping', 'an astral capital (Deseret) lowercases to an astral small letter'), 'E:\\𐐀'],
];

const pathCases = (prefix: (id: string) => string): Case[] => [
  ...lifted.map(([id, title, raw]) => ({ id: prefix(id), origin: fromTest(TESTS, 'normalizeLauncherPath', title), args: [raw], expect: 'out' as const })),
  ...samePathLifted.map(([id, raw]) => ({
    id: prefix(id),
    origin: fromTest(TESTS, 'samePath', 'compares case- and separator-insensitively'),
    args: [raw],
    expect: 'out' as const,
  })),
  ...extra.map(([id, origin, raw]) => ({ id: prefix(id), origin, args: [raw], expect: 'out' as const })),
  ...caseKeys.map(([id, origin, raw]) => ({ id: prefix(id), origin, args: [raw], expect: 'out' as const })),
  { id: prefix('not-a-string'), origin: adversarial('other', 'a non-string throws from trim being missing'), args: [42], expect: 'error' },
];

const NOTE =
  'arg0 is a path string a launcher adapter read (a registry value, a VDF or JSON field, an INI line), already decoded by its caller. The module is node:path on Windows, so normalize and sep are win32 (sep is a backslash). Plain values, no decode.';

vectorFile({
  area: 'core',
  function: 'normalizeLauncherPath',
  source: 'src/main/platform/fs-path.ts',
  note: NOTE,
  call: normalizeLauncherPath,
  cases: pathCases((id) => id),
});

vectorFile({
  area: 'core',
  function: 'pathKey',
  source: 'src/main/platform/fs-path.ts',
  note: `${NOTE}\npathKey is normalizeLauncherPath then String.prototype.toLowerCase (full Unicode lowercase mapping, final sigma included); samePath(a, b) is pathKey(a) === pathKey(b), so the samepath-* cases give the keys test/fs-path.test.ts compares.`,
  call: pathKey,
  cases: pathCases((id) => id),
});
