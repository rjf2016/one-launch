import { adversarial, bundleBytes, bytes, corpus, file, fixture, fromTest, input, text, vectorFile, type Case } from '../lib/index';
import { parseVdf, vdfFlag, vdfGet, vdfHas, vdfInt, vdfObject, vdfString, type VdfObject } from '../../../../src/main/launchers/steam/vdf';
import { droppedNote, nullProto, show, userFolderNote, withoutHangs, withoutUserFolders } from './support';

const SOURCE = 'src/main/launchers/steam/vdf.ts';
const TESTS = 'test/steam-vdf.test.ts';
const LIMITS = 'test/parse-limits.test.ts';
const LOGINUSERS = 'fixtures/launchers/steam/loginusers.vdf';
const LIBRARY = 'fixtures/launchers/steam/libraryfolders.vdf';
const MANIFEST = 'fixtures/launchers/steam/appmanifest_252950.acf';
const READER =
  'The Steam adapter reads every VDF file with readLauncherText(path, MAX_VDF_BYTES) (src/main/launchers/read-file.ts: readFileSync, then toString utf8, BOM kept).';

const nested = (depth: number): string => `${'"a"\n{\n'.repeat(depth)}${'}\n'.repeat(depth)}`;
const BARE_LITERAL = '\uFEFF// comment\r\n#base "other.vdf"\r\nroot\r\n{\r\n\tkey value // trailing\r\n\t"cond" "x" [$WIN32]\r\n\tsub { inner 1 }\r\n}\r\n';
const ESCAPES_LITERAL = '"a" { "path" "D:\\\\Games\\\\Steam" "q" "say \\"hi\\"" "raw" "C:\\Users\\x" "nl" "a\\nb" }';

const parseCases = (): { cases: Case[]; dropped: string[]; userFolders: string[] } => {
  const hand: Case[] = [
    {
      id: 'fixture-loginusers',
      origin: fromTest(TESTS, 'parseVdf', 'parses nested blocks with quoted keys and values'),
      args: [file(LOGINUSERS)],
      expect: 'out',
    },
    { id: 'fixture-libraryfolders', origin: fixture(LIBRARY), args: [file(LIBRARY)], expect: 'out' },
    { id: 'fixture-appmanifest', origin: fixture(MANIFEST), args: [file(MANIFEST)], expect: 'out' },
    {
      id: 'escapes',
      origin: fromTest(TESTS, 'parseVdf', 'unescapes backslashes and quotes but keeps unknown escapes verbatim'),
      args: [text(ESCAPES_LITERAL)],
      expect: 'out',
    },
    {
      id: 'bare-comments-bom-crlf-base-conditional',
      origin: fromTest(TESTS, 'parseVdf', 'handles bare tokens, comments, a BOM, CRLF, #base directives, and platform conditionals'),
      args: [text(BARE_LITERAL)],
      expect: 'out',
    },
    {
      id: 'case-insensitive-keys',
      origin: fromTest(TESTS, 'parseVdf', 'looks keys up case-insensitively, exact match first'),
      args: [text('"R" { "Name" "exact" "name" "lower" "Flag" "1" }')],
      expect: 'out',
    },
    {
      id: 'error-missing-close',
      origin: fromTest(TESTS, 'parseVdf', 'reports malformed input with a line number'),
      args: [text('"a"\n{\n"b" "c"\n')],
      expect: 'error',
    },
    {
      id: 'error-unexpected-close',
      origin: fromTest(TESTS, 'parseVdf', 'reports malformed input with a line number'),
      args: [text('"a" "b" }')],
      expect: 'error',
    },
    {
      id: 'error-key-no-value-close',
      origin: fromTest(TESTS, 'parseVdf', 'reports malformed input with a line number'),
      args: [text('"a" { "b" }')],
      expect: 'error',
    },
    {
      id: 'error-unterminated',
      origin: fromTest(TESTS, 'parseVdf', 'reports malformed input with a line number'),
      args: [text('"unterminated')],
      expect: 'error',
    },
    {
      id: 'error-open-for-key',
      origin: fromTest(TESTS, 'parseVdf', 'reports malformed input with a line number'),
      args: [text('"a" { { } }')],
      expect: 'error',
    },
    { id: 'empty', origin: fromTest(TESTS, 'parseVdf', 'accepts an empty document'), args: [text('')], expect: 'out' },
    { id: 'comment-only', origin: fromTest(TESTS, 'parseVdf', 'accepts an empty document'), args: [text('// nothing here\n')], expect: 'out' },
    {
      id: 'limits-nested-20',
      origin: fromTest(
        LIMITS,
        'launcher files of a size or shape no launcher writes (H16)',
        'refuses VDF blocks nested absurdly deep instead of overflowing the stack',
      ),
      args: [text(nested(20))],
      expect: 'out',
    },
    {
      id: 'limits-nested-100000',
      origin: fromTest(
        LIMITS,
        'launcher files of a size or shape no launcher writes (H16)',
        'refuses VDF blocks nested absurdly deep instead of overflowing the stack',
      ),
      args: [input('steam', 'parseVdf/nested-100000.vdf', Buffer.from(nested(100_000)))],
      expect: 'error',
    },
    { id: 'cap-depth-at', origin: adversarial('other', 'blocks nested exactly MAX_DEPTH (64) deep parse'), args: [text(nested(64))], expect: 'out' },
    {
      id: 'cap-depth-over',
      origin: adversarial('other', 'blocks nested MAX_DEPTH + 1 (65) deep are refused at the 65th open brace'),
      args: [text(nested(65))],
      expect: 'error',
    },
    {
      id: 'cap-depth-at-one-line',
      origin: adversarial('other', 'the depth limit counts blocks, not lines: 64 blocks on one line'),
      args: [text(`${'k{'.repeat(64)}${'}'.repeat(64)}`)],
      expect: 'out',
    },
    {
      id: 'cap-depth-over-one-line',
      origin: adversarial('other', 'the depth error names the line of the 65th brace; all on line 1'),
      args: [text(`${'k{'.repeat(65)}${'}'.repeat(65)}`)],
      expect: 'error',
    },
    { id: 'escape-tab-cr', origin: adversarial('other', 'the \\t and \\r escapes become a tab and a CR'), args: [text('"k" "a\\tb\\rc"')], expect: 'out' },
    {
      id: 'escape-unknown-kept',
      origin: adversarial('other', 'an unknown escape keeps the backslash and the character'),
      args: [text('"k" "\\x\\0\\u0041\\\'"')],
      expect: 'out',
    },
    {
      id: 'escape-at-end',
      origin: adversarial('other', 'a backslash as the last character of the input is an unterminated string'),
      args: [text('"k" "abc\\')],
      expect: 'error',
    },
    {
      id: 'escape-newline-line-count',
      origin: adversarial(
        'other',
        'a backslash before a newline is an unknown escape kept verbatim, and that newline is not counted, so later line numbers are one short',
      ),
      args: [text('"a" "x\\\ny"\n}')],
      expect: 'error',
    },
    {
      id: 'newline-in-string-counts',
      origin: adversarial('other', 'a newline inside a quoted string is counted for later line numbers'),
      args: [text('"a" "x\ny"\n}')],
      expect: 'error',
    },
    {
      id: 'unterminated-line',
      origin: adversarial('other', 'an unterminated string reports the line it started on'),
      args: [text('"a"\n{\n"b" "multi\nline')],
      expect: 'error',
    },
    { id: 'key-no-value-eof', origin: adversarial('other', 'a key as the last token has no value'), args: [text('"a" "b"\n"c"')], expect: 'error' },
    {
      id: 'key-no-value-root-close',
      origin: adversarial('other', 'a key followed by "}" at the root is "has no value", not "Unexpected }"'),
      args: [text('"a" }')],
      expect: 'error',
    },
    {
      id: 'missing-close-nested',
      origin: adversarial('other', 'the innermost unclosed block is the one named'),
      args: [text('"a"\n{\n"b"\n{\n"c" "d"\n}\n')],
      expect: 'error',
    },
    { id: 'bare-ends-at-quote', origin: adversarial('other', 'a bare token ends at a double quote'), args: [text('ab"cd" ef"gh"')], expect: 'out' },
    { id: 'bare-ends-at-brace', origin: adversarial('other', 'a bare token ends at a brace'), args: [text('k{a b}')], expect: 'out' },
    {
      id: 'bare-slashes',
      origin: adversarial('other', 'a slash starts a comment only at the start of a token; a//b and /x are bare tokens'),
      args: [text('a//b /x c/ d')],
      expect: 'out',
    },
    {
      id: 'comment-after-quoted',
      origin: adversarial('other', 'a comment may follow a quoted token with no space'),
      args: [text('"k" "v"// c\n"k2" "v2"')],
      expect: 'out',
    },
    {
      id: 'directive-base',
      origin: adversarial('other', 'an unquoted #include and its argument are skipped; a quoted "#base" is an ordinary key'),
      args: [text('#include "x.vdf"\n"#base" "y"\nk v')],
      expect: 'out',
    },
    {
      id: 'directive-swallows-close',
      origin: adversarial('other', 'a directive skips the next token whatever it is, here the closing brace, so the block is reported unclosed'),
      args: [text('"a"\n{\n#base\n}\n')],
      expect: 'error',
    },
    { id: 'directive-last-token', origin: adversarial('other', 'a directive as the last token skips past the end'), args: [text('k v #base')], expect: 'out' },
    {
      id: 'conditional-after-block',
      origin: adversarial('other', 'a [$X] token after a block value is skipped too'),
      args: [text('a { b c } [$X360] d e')],
      expect: 'out',
    },
    {
      id: 'conditional-quoted-not-skipped',
      origin: adversarial('other', 'a quoted "[$WIN32]" is not a conditional; it becomes the next key'),
      args: [text('k v "[$WIN32]" w')],
      expect: 'out',
    },
    { id: 'conditional-as-key', origin: adversarial('other', 'a bare [..] token in key position is a key'), args: [text('[$X] v')], expect: 'out' },
    {
      id: 'conditional-twice',
      origin: adversarial('other', 'only one conditional is skipped; a second one is a key'),
      args: [text('k v [$A] [$B] w')],
      expect: 'out',
    },
    {
      id: 'duplicate-keys',
      origin: adversarial('other', 'a repeated key keeps its first position and its last value; keys differing in case are separate'),
      args: [text('"k" "1" "K" "2" "k" "3"')],
      expect: 'out',
    },
    {
      id: 'duplicate-block-replaced',
      origin: adversarial('other', 'a repeated block key replaces the first block wholesale, it does not merge'),
      args: [text('a { x 1 } a { y 2 }')],
      expect: 'out',
    },
    {
      id: 'integer-key-order',
      origin: adversarial(
        'other',
        'JS objects enumerate array-index keys first in ascending order, then the rest in insertion order; 01 and 4294967295 are not array indices',
      ),
      args: [text('"b" "1" "10" "x" "4294967295" "big" "2" "y" "4294967294" "max" "a" "z" "01" "w" "0" "zero"')],
      expect: 'out',
    },
    { id: 'empty-key-value', origin: adversarial('other', 'empty quoted key and value'), args: [text('"" ""')], expect: 'out' },
    {
      id: 'bom-midway',
      origin: adversarial('unicode-space', 'U+FEFF is skipped as whitespace anywhere between tokens, not only at the start'),
      args: [text('"a"\uFEFF{\uFEFF"b"\uFEFF"c"\uFEFF}')],
      expect: 'out',
    },
    { id: 'bom-in-bare', origin: adversarial('unicode-space', 'U+FEFF matches \\s, so it ends a bare token'), args: [text('ab\uFEFFcd')], expect: 'out' },
    {
      id: 'cr-only-eol',
      origin: adversarial('other', 'a lone CR separates tokens but does not count as a line'),
      args: [text('"a"\r{\r"b"\r')],
      expect: 'error',
    },
    {
      id: 'unicode-space-in-quotes',
      origin: adversarial('unicode-space', 'NBSP, vertical tab, form feed, U+2028 and U+3000 inside a quoted string are kept as they are'),
      args: [text('"k\u00a0" "\u000b\u000c\u2028\u3000"')],
      expect: 'out',
    },
    {
      id: 'unicode-space-in-comment',
      origin: adversarial('unicode-space', 'NBSP and U+2028 inside a comment are skipped with it; the comment ends only at LF'),
      args: [text('// x\u00a0y\u2028z\n"k" "v"')],
      expect: 'out',
    },
    {
      id: 'nul-in-bare',
      origin: adversarial('other', 'NUL is neither whitespace nor a delimiter, so it is part of a bare token'),
      args: [text('a\u0000b c')],
      expect: 'out',
    },
    {
      id: 'astral-bare',
      origin: adversarial('utf16-length', 'an astral character in a bare key and value is kept whole'),
      args: [text('\u{1F600}k v\u{1D7D8}')],
      expect: 'out',
    },
    {
      id: 'invalid-utf8-key',
      origin: adversarial(
        'utf8-decode',
        'bytes 0xFF, 0xC3 (truncated) and 0xED 0xA0 0xBD (a CESU surrogate) in a quoted key; Node gives one U+FFFD per maximal invalid subsequence',
      ),
      args: [bytes(Buffer.concat([Buffer.from('"k'), Buffer.from([0xff, 0xc3]), Buffer.from('x'), Buffer.from([0xed, 0xa0, 0xbd]), Buffer.from('" "v"')]))],
      expect: 'out',
    },
    {
      id: 'invalid-utf8-bare',
      origin: adversarial('utf8-decode', 'an overlong 0xC0 0x80 in a bare token gives two U+FFFD'),
      args: [bytes(Buffer.from([0x6b, 0xc0, 0x80, 0x20, 0x76]))],
      expect: 'out',
    },
    {
      id: 'utf8-bom-bytes',
      origin: fixture(LOGINUSERS, 'UTF-8 BOM added'),
      args: [bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bundleBytes(LOGINUSERS)]))],
      expect: 'out',
    },
    {
      id: 'case-keys-kept',
      origin: adversarial('case-mapping', 'keys are stored as written, whatever their case or script'),
      args: [text('"ΟΔΟΣ" "1" "Straße" "2" "İ" "3" "\u212Aelvin" "4"')],
      expect: 'out',
    },
    {
      id: 'proto-key',
      origin: fromTest(TESTS, 'parseVdf', 'does not let a hostile key touch Object.prototype'),
      args: [text('"__proto__" { "polluted" "yes" }')],
      expect: 'out',
    },
    {
      id: 'proto-key-string',
      origin: adversarial('other', 'a __proto__ key with a string value is an own key, and a later __proto__ replaces it'),
      args: [text('"__proto__" "a" "x" "y" "__PROTO__" "b" "__proto__" { "k" "v" }')],
      expect: 'out',
    },
    {
      id: 'proto-like-keys',
      origin: adversarial('other', 'constructor, toString and hasOwnProperty are ordinary keys of a null-prototype object'),
      args: [text('"constructor" "1" "toString" { "valueOf" "2" } "hasOwnProperty" "3"')],
      expect: 'out',
    },
  ];
  const generated = withoutHangs(
    corpus({
      seed: 11,
      count: 160,
      from: [{ path: LOGINUSERS }, { path: LIBRARY }, { path: MANIFEST }],
      args: (mutated) => [mutated],
    }),
  );
  const scanned = withoutUserFolders(generated.cases);
  return { cases: [...hand, ...scanned.cases], dropped: generated.dropped, userFolders: scanned.dropped };
};

const parsed = parseCases();

vectorFile({
  area: 'steam',
  function: 'parseVdf',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    `arg0 is the file text. ${READER}`,
    'The result and every nested block are null-prototype objects; keys are recorded in JS enumeration order (array-index keys first, ascending, then insertion order), which the port must reproduce.',
    'Errors are VdfParseError with code VDF_PARSE and the 1-based line; the message ends with " (line N)".',
    'Caps: MAX_DEPTH 64 blocks (cap-depth-*). The 1 MiB MAX_VDF_BYTES limit is the I/O caller (readLauncherText), not this function.',
    'A key named __proto__ is an own data key (proto-key*). Not recorded, a library limit: a key starting with $ (the encoder refuses it).',
    'Not recordable, an app bug: a \\s character other than space, tab, CR, LF and U+FEFF (vertical tab, form feed, NBSP, U+2028, U+3000 and the rest of Unicode Zs) outside a string or comment makes tokenize() loop forever pushing empty tokens until the heap is exhausted.',
    droppedNote(parsed.dropped),
    userFolderNote(parsed.userFolders),
  ].join('\n'),
  call: parseVdf,
  cases: parsed.cases,
});

const OBJ_NOTE =
  'call rebuilds arg0 recursively as null-prototype objects, as parseVdf makes them, so a key such as toString is found only when the object has it; key order is as recorded. arg1 is the key looked up.';

const loginusers = (): VdfObject => parseVdf(bundleBytes(LOGINUSERS).toString('utf8'));
const firstUser = (): VdfObject => vdfObject(vdfObject(loginusers(), 'users')!, '76561198000000001')!;
const escapes = (): VdfObject => vdfObject(parseVdf(ESCAPES_LITERAL), 'a')!;
const caseR = (): VdfObject => vdfObject(parseVdf('"R" { "Name" "exact" "name" "lower" "Flag" "1" }'), 'r')!;
const plain = (value: VdfObject): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const T_NESTED = 'parses nested blocks with quoted keys and values';
const T_ESC = 'unescapes backslashes and quotes but keeps unknown escapes verbatim';
const T_CASE = 'looks keys up case-insensitively, exact match first';
const T_BARE = 'handles bare tokens, comments, a BOM, CRLF, #base directives, and platform conditionals';

const lookupCases = (): Case[] => [
  { id: 'exact', origin: fromTest(TESTS, 'parseVdf', T_CASE), args: [plain(caseR()), 'Name'], expect: 'out' },
  { id: 'insensitive-first-wins', origin: fromTest(TESTS, 'parseVdf', T_CASE), args: [plain(caseR()), 'NAME'], expect: 'out' },
  {
    id: 'exact-later-key',
    origin: fromTest(TESTS, 'parseVdf', `${T_CASE} | looked up as name: the exact key wins over the earlier Name`),
    args: [plain(caseR()), 'name'],
    expect: 'out',
  },
  { id: 'missing', origin: fromTest(TESTS, 'parseVdf', T_CASE), args: [plain(caseR()), 'missing'], expect: 'out' },
  { id: 'block-value', origin: fromTest(TESTS, 'parseVdf', T_NESTED), args: [plain(loginusers()), 'USERS'], expect: 'out' },
  { id: 'empty-value', origin: adversarial('other', 'an empty string value is found, not missing'), args: [{ k: '' }, 'K'], expect: 'out' },
  { id: 'empty-key', origin: adversarial('other', 'the empty key is a key'), args: [{ '': 'v' }, ''], expect: 'out' },
  {
    id: 'proto-names',
    origin: adversarial('other', 'toString is not found on a null-prototype object that lacks it'),
    args: [{ a: '1' }, 'toString'],
    expect: 'out',
  },
  {
    id: 'proto-key-own',
    origin: fromTest(TESTS, 'parseVdf', 'does not let a hostile key touch Object.prototype'),
    args: [{ ['__proto__']: { polluted: 'yes' } }, '__proto__'],
    expect: 'out',
  },
  {
    id: 'proto-key-missing',
    origin: adversarial('other', 'looking up __proto__ on a null-prototype object without that key finds nothing'),
    args: [{ a: '1' }, '__proto__'],
    expect: 'out',
  },
  {
    id: 'proto-key-insensitive',
    origin: adversarial('case-mapping', '__PROTO__ finds an own __proto__ key case-insensitively'),
    args: [{ ['__proto__']: 'p' }, '__PROTO__'],
    expect: 'out',
  },
  {
    id: 'proto-names-present',
    origin: adversarial('other', 'a toString key is found case-insensitively'),
    args: [{ TOSTRING: '1' }, 'toString'],
    expect: 'out',
  },
  {
    id: 'integer-key-first',
    origin: adversarial('other', 'the case-insensitive scan follows enumeration order, so array-index keys come first'),
    args: [{ 10: 'ten', 2: 'two' }, '2'],
    expect: 'out',
  },
  {
    id: 'kelvin',
    origin: adversarial('case-mapping', 'U+212A KELVIN SIGN lower-cases to k, so Kelvin matches kelvin'),
    args: [{ '\u212Aelvin': 'k' }, 'kelvin'],
    expect: 'out',
  },
  {
    id: 'kelvin-reverse',
    origin: adversarial('case-mapping', 'looking up with U+212A finds the ASCII key'),
    args: [{ kelvin: 'k' }, '\u212Aelvin'],
    expect: 'out',
  },
  { id: 'dotted-i', origin: adversarial('case-mapping', 'İ lower-cases to i plus U+0307, so it does not match i'), args: [{ İd: 'x' }, 'id'], expect: 'out' },
  {
    id: 'dotted-i-self',
    origin: adversarial('case-mapping', 'İD and i̇d (i, U+0307, d) match under toLowerCase'),
    args: [{ İD: 'x' }, 'i\u0307d'],
    expect: 'out',
  },
  {
    id: 'final-sigma',
    origin: adversarial('case-mapping', 'ΟΔΟΣ lower-cases with a final sigma ς, so it does not match οδοσ'),
    args: [{ ΟΔΟΣ: 'x' }, 'οδοσ'],
    expect: 'out',
  },
  { id: 'final-sigma-match', origin: adversarial('case-mapping', 'ΟΔΟΣ matches οδος'), args: [{ ΟΔΟΣ: 'x' }, 'οδος'], expect: 'out' },
  {
    id: 'sharp-s',
    origin: adversarial('case-mapping', 'ß does not lower-case to ss; STRASSE does not match Straße'),
    args: [{ Straße: 'x' }, 'STRASSE'],
    expect: 'out',
  },
  { id: 'dotless-i', origin: adversarial('case-mapping', 'ı (dotless) is not i'), args: [{ ıd: 'x' }, 'ID'], expect: 'out' },
  {
    id: 'lone-surrogate-key',
    origin: adversarial('lone-surrogate', 'a key holding a lone surrogate is matched unit for unit'),
    args: [{ '\ud800A': 'x' }, '\ud800a'],
    expect: 'out',
  },
];

const getter = (name: string, fn: (obj: VdfObject, key: string) => unknown, extra: Case[], note = ''): void =>
  vectorFile({
    area: 'steam',
    function: name,
    source: SOURCE,
    note: [OBJ_NOTE, note].filter(Boolean).join('\n'),
    call: (obj: unknown, key: string) => fn(nullProto(obj) as VdfObject, key),
    cases: () => [...lookupCases(), ...extra],
  });

getter('vdfGet', vdfGet, []);
getter('vdfHas', vdfHas, []);

getter('vdfString', vdfString, [
  { id: 'test-account-name', origin: fromTest(TESTS, 'parseVdf', T_NESTED), args: [plain(firstUser()), 'AccountName'], expect: 'out' },
  { id: 'test-autologin', origin: fromTest(TESTS, 'parseVdf', T_NESTED), args: [plain(firstUser()), 'AutoLogin'], expect: 'out' },
  { id: 'test-path', origin: fromTest(TESTS, 'parseVdf', T_ESC), args: [plain(escapes()), 'path'], expect: 'out' },
  { id: 'test-quote', origin: fromTest(TESTS, 'parseVdf', T_ESC), args: [plain(escapes()), 'q'], expect: 'out' },
  { id: 'test-raw', origin: fromTest(TESTS, 'parseVdf', T_ESC), args: [plain(escapes()), 'raw'], expect: 'out' },
  { id: 'test-nl', origin: fromTest(TESTS, 'parseVdf', T_ESC), args: [plain(escapes()), 'nl'], expect: 'out' },
  { id: 'test-bare-key', origin: fromTest(TESTS, 'parseVdf', T_BARE), args: [plain(vdfObject(parseVdf(BARE_LITERAL), 'root')!), 'key'], expect: 'out' },
  { id: 'test-cond', origin: fromTest(TESTS, 'parseVdf', T_BARE), args: [plain(vdfObject(parseVdf(BARE_LITERAL), 'root')!), 'cond'], expect: 'out' },
]);

getter('vdfObject', vdfObject, [
  { id: 'test-users', origin: fromTest(TESTS, 'parseVdf', T_NESTED), args: [plain(loginusers()), 'users'], expect: 'out' },
  {
    id: 'test-r',
    origin: fromTest(TESTS, 'parseVdf', T_CASE),
    args: [plain(parseVdf('"R" { "Name" "exact" "name" "lower" "Flag" "1" }')), 'r'],
    expect: 'out',
  },
  { id: 'test-sub', origin: fromTest(TESTS, 'parseVdf', T_BARE), args: [plain(vdfObject(parseVdf(BARE_LITERAL), 'root')!), 'sub'], expect: 'out' },
  { id: 'string-not-object', origin: adversarial('other', 'a string value is not an object'), args: [{ k: 'v' }, 'k'], expect: 'out' },
  { id: 'empty-object', origin: adversarial('other', 'an empty block is an object'), args: [{ k: {} }, 'K'], expect: 'out' },
]);

const intValues: [string, string, string][] = [
  ['plain', '1789145779', 'other'],
  ['zero', '0', 'other'],
  ['negative-zero', '-0', 'number'],
  ['negative', '-42', 'other'],
  ['leading-zeros', '00012', 'parseint'],
  ['spaces', ' 7\t', 'unicode-space'],
  ['nbsp', '\u00a07\u00a0', 'unicode-space'],
  ['bom', '\uFEFF7', 'unicode-space'],
  ['line-separator', '\u20287\u2029', 'unicode-space'],
  ['ideographic-space', '\u30007', 'unicode-space'],
  ['nel', '\u00857', 'unicode-space'],
  ['mongolian-vowel-separator', '\u180E7', 'unicode-space'],
  ['plus', '+7', 'parseint'],
  ['hex', '0x10', 'parseint'],
  ['exponent', '1e3', 'parseint'],
  ['decimal', '1.0', 'parseint'],
  ['trailing-junk', '12px', 'parseint'],
  ['inner-space', '1 2', 'parseint'],
  ['minus-only', '-', 'parseint'],
  ['empty', '', 'parseint'],
  ['double-minus', '--1', 'parseint'],
  ['arabic-indic', '\u0661\u0662', 'unicode-digit'],
  ['fullwidth', '\uFF11\uFF12', 'unicode-digit'],
  ['devanagari', '\u0967', 'unicode-digit'],
  ['cap-safe-at', '9007199254740991', 'number'],
  ['cap-safe-over', '9007199254740992', 'number'],
  ['cap-safe-negative-at', '-9007199254740991', 'number'],
  ['cap-safe-negative-over', '-9007199254740992', 'number'],
  ['above-safe-odd', '9007199254740993', 'number'],
  ['huge', '1'.repeat(400), 'number'],
  ['long-leading-zeros', `${'0'.repeat(300)}5`, 'parseint'],
];

getter(
  'vdfInt',
  vdfInt,
  [
    { id: 'test-timestamp', origin: fromTest(TESTS, 'parseVdf', T_NESTED), args: [plain(firstUser()), 'Timestamp'], expect: 'out' },
    { id: 'test-not-number', origin: fromTest(TESTS, 'parseVdf', T_CASE), args: [plain(caseR()), 'Name'], expect: 'out' },
    { id: 'block-is-null', origin: adversarial('other', 'a block value is not an integer'), args: [{ n: {} }, 'n'], expect: 'out' },
    ...intValues.map(([id, value, kind]) => ({
      id: `value-${id}`,
      origin: adversarial(kind as 'other', `${show(value)} through trim, /^-?\\d+$/ (ASCII digits) and Number`),
      args: [{ n: value }, 'n'],
      expect: 'out' as const,
    })),
  ],
  'Caps: Number.isSafeInteger, so 2^53 - 1 is the largest accepted magnitude (cap-safe-*). trim() is the JS one: it strips U+FEFF but not U+0085 or U+180E.',
);

const flagValues: [string, string, string][] = [
  ['one', '1', 'other'],
  ['zero', '0', 'other'],
  ['padded', ' 1\t', 'unicode-space'],
  ['bom', '\uFEFF1', 'unicode-space'],
  ['nbsp', '1\u00a0', 'unicode-space'],
  ['line-separator', '\u20281', 'unicode-space'],
  ['nel', '\u00851', 'unicode-space'],
  ['leading-zero', '01', 'parseint'],
  ['decimal', '1.0', 'parseint'],
  ['true-word', 'true', 'other'],
  ['fullwidth-one', '\uFF11', 'unicode-digit'],
  ['empty', '', 'other'],
];

getter('vdfFlag', vdfFlag, [
  { id: 'test-flag', origin: fromTest(TESTS, 'parseVdf', T_CASE), args: [plain(caseR()), 'flag'], expect: 'out' },
  { id: 'block-is-false', origin: adversarial('other', 'a block value is not a flag'), args: [{ f: {} }, 'f'], expect: 'out' },
  ...flagValues.map(([id, value, kind]) => ({
    id: `value-${id}`,
    origin: adversarial(kind as 'other', `${show(value)} through trim() === "1"`),
    args: [{ f: value }, 'f'],
    expect: 'out' as const,
  })),
]);
