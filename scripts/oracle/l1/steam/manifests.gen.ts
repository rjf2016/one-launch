import { adversarial, bytes, corpus, file, fixture, fromTest, input, text, vectorFile, type Case } from '../lib/index';
import { isFullyInstalled, needsUpdate, parseAppManifest, parseLibraryFolders } from '../../../../src/main/launchers/steam/manifests';
import { droppedNote, show, userFolderNote, withoutHangs, withoutUserFolders } from './support';

const SOURCE = 'src/main/launchers/steam/manifests.ts';
const TESTS = 'test/steam-files.test.ts';
const LIMITS = 'test/parse-limits.test.ts';
const LIBRARY = 'fixtures/launchers/steam/libraryfolders.vdf';
const MANIFEST = 'fixtures/launchers/steam/appmanifest_252950.acf';
const READER =
  'arg0 is the file text as src/main/launchers/steam/adapter.ts reads it: readLauncherText(path, MAX_VDF_BYTES) (src/main/launchers/read-file.ts: readFileSync, then toString utf8, BOM kept). The 1 MiB MAX_VDF_BYTES limit is that caller’s, not this function’s.';

const library = (entries: string[]): string => `"libraryfolders"\n{\n${entries.join('')}}\n`;
const folder = (key: string, path: string): string => `\t"${key}"\n\t{\n\t\t"path"\t\t"${path}"\n\t}\n`;
const flat = (key: string, path: string): string => `\t"${key}"\t\t"${path}"\n`;

const PRE2021 =
  '"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t\t"1"\n\t"ContentStatsID"\t\t"2"\n\t"1"\t\t"E:\\\\SteamLibrary"\n\t"2"\t\t"e:/steamlibrary/"\n}\n';
const twentyThousand = (): Buffer =>
  Buffer.from(`"libraryfolders"\n{\n${Array.from({ length: 20_000 }, (_, i) => `\t"${i}"\n\t{\n\t\t"path"\t\t"D:\\\\Lib${i % 10_000}"\n\t}\n`).join('')}}\n`);

const libraryCases = (): { cases: Case[]; dropped: string[]; userFolders: string[] } => {
  const hand: Case[] = [
    {
      id: 'fixture',
      origin: fromTest(TESTS, 'parseLibraryFolders', 'returns normalized, deduplicated paths from the current format'),
      args: [file(LIBRARY)],
      expect: 'out',
    },
    {
      id: 'pre-2021-flat',
      origin: fromTest(TESTS, 'parseLibraryFolders', 'accepts the pre-2021 flat format and ignores non-numeric keys and duplicates'),
      args: [text(PRE2021)],
      expect: 'out',
    },
    { id: 'no-block', origin: fromTest(TESTS, 'parseLibraryFolders', 'rejects a file without the expected block'), args: [text('"x" {}')], expect: 'error' },
    {
      id: 'limits-twenty-thousand',
      origin: fromTest(
        LIMITS,
        'launcher files of a size or shape no launcher writes (H16)',
        'deduplicates twenty thousand library folders without comparing every pair',
      ),
      args: [input('steam', 'parseLibraryFolders/twenty-thousand.vdf', twentyThousand())],
      expect: 'out',
    },
    {
      id: 'block-is-string',
      origin: adversarial('other', 'a libraryfolders key whose value is a string is no block'),
      args: [text('"libraryfolders" "x"')],
      expect: 'error',
    },
    { id: 'vdf-error', origin: adversarial('other', 'a VdfParseError propagates as it is'), args: [text('"libraryfolders" {')], expect: 'error' },
    { id: 'empty-block', origin: adversarial('other', 'an empty block lists nothing'), args: [text('"libraryfolders" { }')], expect: 'out' },
    {
      id: 'index-key-order',
      origin: adversarial(
        'other',
        'Object.entries puts array-index keys first in ascending order, so "1" written before "0" still comes second; "01" and "4294967295" are not indices and keep file order after them',
      ),
      args: [text(library([folder('4294967295', 'F:\\\\Big'), folder('01', 'G:\\\\Padded'), folder('1', 'E:\\\\One'), folder('0', 'D:\\\\Zero')]))],
      expect: 'out',
    },
    {
      id: 'dedupe-keeps-enumeration-first',
      origin: adversarial('other', 'the duplicate kept is the first in enumeration order, not file order'),
      args: [text(library([folder('5', 'D:\\\\Games\\\\Steam'), folder('2', 'd:/games/steam/')]))],
      expect: 'out',
    },
    {
      id: 'unicode-digit-keys',
      origin: adversarial('unicode-digit', '/^\\d+$/ has no u flag: keys in Arabic-Indic or fullwidth digits are skipped'),
      args: [text(library([folder('٣', 'D:\\\\Arabic'), folder('３', 'D:\\\\Fullwidth'), folder('3', 'D:\\\\Ascii')]))],
      expect: 'out',
    },
    {
      id: 'signed-keys',
      origin: adversarial('parseint', 'keys -1, +1 and " 1" are not numeric keys'),
      args: [text(library([folder('-1', 'D:\\\\Minus'), folder('+1', 'D:\\\\Plus'), folder(' 1', 'D:\\\\Space'), folder('7', 'D:\\\\Seven')]))],
      expect: 'out',
    },
    {
      id: 'missing-or-empty-path',
      origin: adversarial('unicode-space', 'a block without path, an empty path and paths of spaces, NBSP or U+3000 are skipped'),
      args: [
        text(
          library([
            '\t"0"\n\t{\n\t\t"label"\t\t"x"\n\t}\n',
            folder('1', ''),
            folder('2', '   '),
            folder('3', '\u00a0'),
            folder('4', '\u3000'),
            folder('5', 'D:\\\\Kept'),
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'path-is-block',
      origin: adversarial('other', 'a path that is a block is skipped'),
      args: [text(library(['\t"0"\n\t{\n\t\t"path"\t\t{ }\n\t}\n', folder('1', 'D:\\\\Kept')]))],
      expect: 'out',
    },
    {
      id: 'path-key-case',
      origin: adversarial('case-mapping', 'the path key is found case-insensitively'),
      args: [text(library(['\t"0"\n\t{\n\t\t"PATH"\t\t"D:\\\\Upper"\n\t}\n']))],
      expect: 'out',
    },
    {
      id: 'normalize-separators',
      origin: adversarial('other', 'path.win32 normalisation: mixed and doubled separators, trailing separators, . and .. segments'),
      args: [
        text(
          library([
            flat('0', 'D:/Games//Steam/'),
            flat('1', 'E:\\\\\\\\Lib\\\\.\\\\x\\\\..\\\\y\\\\'),
            flat('2', 'F:\\\\a\\\\..\\\\..\\\\b'),
            flat('3', 'G:\\\\'),
            flat('4', 'H:'),
            flat('5', 'I:/'),
            flat('6', 'relative\\\\lib'),
            flat('7', '\\\\\\\\server\\\\share\\\\lib'),
            flat('8', '//server/share/'),
            flat('9', '  J:\\\\Trimmed  '),
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'unknown-escape-path',
      origin: adversarial('other', 'a single-backslash path survives the VDF unknown-escape rule and normalises'),
      args: [text(library([flat('0', 'D:\\Games\\Steam')]))],
      expect: 'out',
    },
    {
      id: 'dedupe-non-ascii',
      origin: adversarial('case-mapping', 'pathKey lower-cases with toLowerCase: Ä and ä are one path, U+212A KELVIN SIGN and k are one path, İ and i are not'),
      args: [
        text(
          library([
            flat('0', 'D:\\\\Ärger'),
            flat('1', 'd:\\\\ärger'),
            flat('2', 'D:\\\\\u212A'),
            flat('3', 'D:\\\\k'),
            flat('4', 'D:\\\\İ'),
            flat('5', 'D:\\\\i'),
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'astral-path',
      origin: adversarial('utf16-length', 'an astral character and a trailing separator: the separator is dropped by length, not by character'),
      args: [text(library([flat('0', 'D:\\\\\u{1F600}\\\\')]))],
      expect: 'out',
    },
    {
      id: 'invalid-utf8-path',
      origin: adversarial('utf8-decode', 'a lone 0xFF in a path becomes U+FFFD'),
      args: [bytes(Buffer.from('"libraryfolders" { "0" "D:\\\\\xff" }', 'latin1'))],
      expect: 'out',
    },
  ];
  const generated = withoutHangs(
    corpus({
      seed: 41,
      count: 60,
      from: [{ path: LIBRARY }, { path: 'l1/steam/files/parseLibraryFolders/pre-2021.vdf', bytes: Buffer.from(PRE2021) }],
      args: (mutated) => [mutated],
    }),
  );
  hand.splice(2, 0, {
    id: 'fixture-pre-2021',
    origin: fixture('l1/steam/files/parseLibraryFolders/pre-2021.vdf'),
    args: [input('steam', 'parseLibraryFolders/pre-2021.vdf', Buffer.from(PRE2021))],
    expect: 'out',
  });
  const scanned = withoutUserFolders(generated.cases);
  return { cases: [...hand, ...scanned.cases], dropped: generated.dropped, userFolders: scanned.dropped };
};

const libraries = libraryCases();

vectorFile({
  area: 'steam',
  function: 'parseLibraryFolders',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    READER,
    'Paths go through normalizeLauncherPath (src/main/platform/fs-path.ts), which uses node:path normalize with the platform separator; the vectors were made on Windows, so it is path.win32 and the separator is a backslash. Duplicates are found by pathKey (normalised, then toLowerCase).',
    'Errors: ManifestFormatError (code MANIFEST_FORMAT) without a libraryfolders block; VdfParseError as it is.',
    'No cap of its own; the test of twenty thousand folders is limits-twenty-thousand.',
    droppedNote(libraries.dropped),
    userFolderNote(libraries.userFolders),
  ].join('\n'),
  call: parseLibraryFolders,
  cases: libraries.cases,
});

const app = (fields: [string, string][]): string => `"AppState"\n{\n${fields.map(([k, v]) => `\t"${k}"\t\t"${v}"\n`).join('')}}\n`;
const base: [string, string][] = [
  ['appid', '252950'],
  ['name', 'Rocket League'],
  ['installdir', 'rocketleague'],
];
const withField = (key: string, value: string): string => app([...base, [key, value]]);

const manifestCases = (): { cases: Case[]; dropped: string[] } => {
  const T_REJECT = 'rejects manifests without appid or installdir';
  const hand: Case[] = [
    {
      id: 'fixture',
      origin: fromTest(TESTS, 'parseAppManifest', 'reads the fields the library needs and nothing sensitive'),
      args: [file(MANIFEST)],
      expect: 'out',
    },
    { id: 'no-appid', origin: fromTest(TESTS, 'parseAppManifest', T_REJECT), args: [text('"AppState" { "name" "x" "installdir" "x" }')], expect: 'error' },
    { id: 'no-installdir', origin: fromTest(TESTS, 'parseAppManifest', T_REJECT), args: [text('"AppState" { "appid" "1" "name" "x" }')], expect: 'error' },
    { id: 'no-appstate', origin: fromTest(TESTS, 'parseAppManifest', T_REJECT), args: [text('"Other" { }')], expect: 'error' },
    {
      id: 'appstate-is-string',
      origin: adversarial('other', 'an AppState key whose value is a string is no block'),
      args: [text('"AppState" "x"')],
      expect: 'error',
    },
    { id: 'vdf-error', origin: adversarial('other', 'a VdfParseError propagates as it is'), args: [text('"AppState" { "appid" }')], expect: 'error' },
    {
      id: 'minimal',
      origin: adversarial('other', 'only appid and installdir: name falls back to "App <id>", the numbers to their defaults'),
      args: [
        text(
          app([
            ['appid', '7'],
            ['installdir', 'seven'],
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'keys-any-case',
      origin: adversarial('case-mapping', 'every key is looked up case-insensitively'),
      args: [text('"appstate" { "APPID" "9" "InstallDir" "nine" "NAME" "Nine" "stateflags" "4" "BUILDID" "3" }')],
      expect: 'out',
    },
    {
      id: 'appid-trimmed',
      origin: adversarial('unicode-space', 'appid and installdir are trimmed with the JS trim, NBSP and U+FEFF included'),
      args: [
        text(
          app([
            ['appid', '\u00a0 42\uFEFF'],
            ['installdir', '\u3000dir\t'],
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'appid-nel',
      origin: adversarial('unicode-space', 'JS trim keeps U+0085, so the appid is not numeric'),
      args: [
        text(
          app([
            ['appid', '\u008542'],
            ['installdir', 'x'],
          ]),
        ),
      ],
      expect: 'error',
    },
    {
      id: 'appid-unicode-digits',
      origin: adversarial('unicode-digit', 'an appid in Arabic-Indic digits is not numeric (\\d without u)'),
      args: [
        text(
          app([
            ['appid', '٤٢'],
            ['installdir', 'x'],
          ]),
        ),
      ],
      expect: 'error',
    },
    {
      id: 'appid-fullwidth',
      origin: adversarial('unicode-digit', 'an appid in fullwidth digits is not numeric'),
      args: [
        text(
          app([
            ['appid', '４２'],
            ['installdir', 'x'],
          ]),
        ),
      ],
      expect: 'error',
    },
    {
      id: 'appid-signed',
      origin: adversarial('parseint', 'a signed appid is not numeric'),
      args: [
        text(
          app([
            ['appid', '+42'],
            ['installdir', 'x'],
          ]),
        ),
      ],
      expect: 'error',
    },
    {
      id: 'appid-empty',
      origin: adversarial('other', 'an empty appid is missing'),
      args: [
        text(
          app([
            ['appid', ' '],
            ['installdir', 'x'],
          ]),
        ),
      ],
      expect: 'error',
    },
    {
      id: 'appid-leading-zeros',
      origin: adversarial('parseint', 'an appid keeps its leading zeros: it is a string'),
      args: [
        text(
          app([
            ['appid', '007'],
            ['installdir', 'x'],
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'appid-block',
      origin: adversarial('other', 'an appid that is a block is missing'),
      args: [text('"AppState" { "appid" { } "installdir" "x" }')],
      expect: 'error',
    },
    {
      id: 'installdir-empty',
      origin: adversarial('unicode-space', 'an installdir of only spaces and NBSP is missing; the message names the appid'),
      args: [
        text(
          app([
            ['appid', '42'],
            ['installdir', ' \u00a0'],
          ]),
        ),
      ],
      expect: 'error',
    },
    {
      id: 'name-blank',
      origin: adversarial('unicode-space', 'a blank name falls back to "App <id>"'),
      args: [text(withField('name', ' \u2028 ').replace('\t"name"\t\t"Rocket League"\n', ''))],
      expect: 'out',
    },
    {
      id: 'name-trimmed',
      origin: adversarial('unicode-space', 'the name is trimmed'),
      args: [
        text(
          app([
            ['appid', '1'],
            ['installdir', 'x'],
            ['name', '\t Spaced \u00a0'],
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'buildid-blank',
      origin: adversarial('other', 'a blank buildid is an empty string, not null'),
      args: [text(withField('buildid', '  '))],
      expect: 'out',
    },
    {
      id: 'stateflags-junk',
      origin: adversarial('parseint', 'StateFlags that is not an integer is 0'),
      args: [text(withField('StateFlags', '0x6'))],
      expect: 'out',
    },
    {
      id: 'stateflags-negative-zero',
      origin: adversarial('number', 'StateFlags -0 is kept as -0 (vdfInt returns -0 and ?? keeps it)'),
      args: [text(withField('StateFlags', '-0'))],
      expect: 'out',
    },
    { id: 'stateflags-negative', origin: adversarial('number', 'a negative StateFlags is kept'), args: [text(withField('StateFlags', '-4'))], expect: 'out' },
    { id: 'lastplayed-zero', origin: adversarial('number', 'LastPlayed 0 is null'), args: [text(withField('LastPlayed', '0'))], expect: 'out' },
    { id: 'lastplayed-negative-zero', origin: adversarial('number', 'LastPlayed -0 is null'), args: [text(withField('LastPlayed', '-0'))], expect: 'out' },
    { id: 'lastplayed-negative', origin: adversarial('number', 'a negative LastPlayed is null'), args: [text(withField('LastPlayed', '-1'))], expect: 'out' },
    {
      id: 'lastplayed-padded',
      origin: adversarial('unicode-space', 'a padded LastPlayed is read'),
      args: [text(withField('LastPlayed', '\u00a01785117264 '))],
      expect: 'out',
    },
    {
      id: 'cap-size-safe-at',
      origin: adversarial('number', 'SizeOnDisk 2^53 - 1 is read'),
      args: [text(withField('SizeOnDisk', '9007199254740991'))],
      expect: 'out',
    },
    {
      id: 'cap-size-safe-over',
      origin: adversarial('number', 'SizeOnDisk 2^53 is null'),
      args: [text(withField('SizeOnDisk', '9007199254740992'))],
      expect: 'out',
    },
    { id: 'size-negative-zero', origin: adversarial('number', 'SizeOnDisk -0 is -0'), args: [text(withField('SizeOnDisk', '-0'))], expect: 'out' },
    {
      id: 'lastowner-not-surfaced',
      origin: adversarial('other', 'LastOwner and unknown keys never reach the result'),
      args: [text(withField('LastOwner', '76561198000000001'))],
      expect: 'out',
    },
    {
      id: 'proto-key',
      origin: adversarial('other', 'a __proto__ key in AppState is an ordinary key and does not reach the result'),
      args: [text(withField('__proto__', 'x'))],
      expect: 'out',
    },
    {
      id: 'astral-name',
      origin: adversarial('utf16-length', 'an astral name is kept whole'),
      args: [text(withField('name', '\u{1F680} Launch').replace('\t"name"\t\t"Rocket League"\n', ''))],
      expect: 'out',
    },
    {
      id: 'invalid-utf8-installdir',
      origin: adversarial('utf8-decode', 'an overlong 0xC0 0xAF in installdir becomes two U+FFFD'),
      args: [bytes(Buffer.from('"AppState" { "appid" "1" "installdir" "a\xc0\xafb" }', 'latin1'))],
      expect: 'out',
    },
  ];
  const generated = withoutHangs(corpus({ seed: 51, count: 60, from: [{ path: MANIFEST }], args: (mutated) => [mutated] }));
  return { cases: [...hand, ...generated.cases], dropped: generated.dropped };
};

const manifests = manifestCases();

vectorFile({
  area: 'steam',
  function: 'parseAppManifest',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    READER,
    'Errors: ManifestFormatError (code MANIFEST_FORMAT) with three messages (no AppState block, no numeric appid, no installdir naming the appid); VdfParseError as it is.',
    'Numbers come from vdfInt (safe integers only; -0 is kept where ?? or a plain read keeps it). No cap of its own.',
    droppedNote(manifests.dropped),
  ].join('\n'),
  call: parseAppManifest,
  cases: manifests.cases,
});

const flags: [string, number, string][] = [
  ['zero', 0, 'other'],
  ['installed', 4, 'other'],
  ['installed-update', 6, 'other'],
  ['update-only', 2, 'other'],
  ['other-bits', 1026, 'other'],
  ['all-bits', 0xffffffff, 'number'],
  ['high-bit', 2 ** 31, 'number'],
  ['above-32-bits', 2 ** 32 + 6, 'number'],
  ['negative-zero', -0, 'number'],
  ['negative', -4, 'number'],
  ['minus-one', -1, 'number'],
  ['fraction', 6.5, 'number'],
  ['safe-max', Number.MAX_SAFE_INTEGER, 'number'],
];

const flagCases = (fn: string): Case[] => [
  ...(fn === 'isFullyInstalled'
    ? [
        { id: 'test-4', origin: fromTest(TESTS, 'parseAppManifest', 'treats StateFlags as a bit field'), args: [4], expect: 'out' as const },
        { id: 'test-1026', origin: fromTest(TESTS, 'parseAppManifest', 'treats StateFlags as a bit field'), args: [1026], expect: 'out' as const },
        {
          id: 'test-fixture-6',
          origin: fromTest(TESTS, 'parseAppManifest', 'reads the fields the library needs and nothing sensitive'),
          args: [6],
          expect: 'out' as const,
        },
      ]
    : [
        { id: 'test-4', origin: fromTest(TESTS, 'parseAppManifest', 'treats StateFlags as a bit field'), args: [4], expect: 'out' as const },
        {
          id: 'test-fixture-6',
          origin: fromTest(TESTS, 'parseAppManifest', 'reads the fields the library needs and nothing sensitive'),
          args: [6],
          expect: 'out' as const,
        },
      ]),
  ...flags.map(([id, value, kind]) => ({
    id: `flags-${id}`,
    origin: adversarial(kind as 'other', `${show(String(value))} through the & operator, which works on the value as a signed 32-bit integer`),
    args: [value],
    expect: 'out' as const,
  })),
];

const FLAG_NOTE =
  'arg0 is the StateFlags number from parseAppManifest. JS & truncates the operand to a signed 32-bit integer, so bits above 31 are ignored and fractions dropped.';

vectorFile({
  area: 'steam',
  function: 'isFullyInstalled',
  source: SOURCE,
  note: FLAG_NOTE,
  call: isFullyInstalled,
  cases: () => flagCases('isFullyInstalled'),
});
vectorFile({ area: 'steam', function: 'needsUpdate', source: SOURCE, note: FLAG_NOTE, call: needsUpdate, cases: () => flagCases('needsUpdate') });
