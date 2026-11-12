import { adversarial, bundleBytes, bytes, corpus, file, fixture, fromTest, input, Rng, text, vectorFile, type Case, type Origin } from '../lib/index';
import {
  detectLayout,
  maskLogin,
  parseConfig,
  planSavedAccountNames,
  roundTrips,
  serializeConfig,
  splitSavedAccountNames,
  type ConfigLayout,
} from '../../../../src/main/launchers/battlenet/config';
import { testOrigin, bytesOf, CONFIG, inputBytes, D_CONFIG, FILES_TEST, recordable, USER_CONFIG } from './shared';

const SOURCE = 'src/main/launchers/battlenet/config.ts';
const config = bundleBytes(CONFIG);
const configText = config.toString('utf8');
const T = testOrigin(FILES_TEST, D_CONFIG);
const ROUND = 'detects the Qt layout and reproduces the real file byte for byte';
const MOVE = 'moves a login to the front of SavedAccountNames and touches nothing else';
const ADD = 'adds a login that is not in the list and is a no-op when it is already first';
const REFUSE = 'refuses to rewrite a file whose layout it cannot reproduce';
const PREFS = 'reads the per-account close preferences and masks logins';

const qt = (lines: string[], eol = '\n'): string => lines.join(eol) + eol;
const MINI_LINES = [
  '{',
  '    "Client": {',
  '        "AutoLogin": "true",',
  '        "SavedAccountNames": "user_1@example.com,user_2@example.com,user_3@example.com",',
  '        "Install": {',
  '            "DefaultInstallPath": "D:\\/Games"',
  '        }',
  '    }',
  '}',
];
const MINI_LF = Buffer.from(qt(MINI_LINES), 'utf8');
const MINI_CRLF = Buffer.from(qt(MINI_LINES, '\r\n'), 'utf8');
const MINI_LF_PATH = 'l1/battlenet/files/planSavedAccountNames/mini-lf.config';
const MINI_CRLF_PATH = 'l1/battlenet/files/planSavedAccountNames/mini-crlf.config';
const miniLf = () => input('battlenet', 'planSavedAccountNames/mini-lf.config', MINI_LF);
const miniCrlf = () => input('battlenet', 'planSavedAccountNames/mini-crlf.config', MINI_CRLF);

const withNames = (names: string, eol = '\r\n', indent = 4): string => {
  const pad = ' '.repeat(indent);
  return (
    [`{`, `${pad}"Client": {`, `${pad}${pad}"AutoLogin": "true",`, `${pad}${pad}"SavedAccountNames": ${JSON.stringify(names)}`, `${pad}}`, `}`].join(eol) + eol
  );
};
const odd = configText.replace('"AutoLogin": "true"', '"AutoLogin":   "true"');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

interface TextCase {
  id: string;
  origin: Origin;
  arg: unknown;
  parses: boolean;
}

const texts = (): TextCase[] => [
  { id: 'fixture-battlenet-config', origin: T(ROUND), arg: file(CONFIG), parses: true },
  { id: 'fixture-user-config', origin: fixture(USER_CONFIG), arg: file(USER_CONFIG), parses: true },
  { id: 'test-autologin-spaces', origin: T(REFUSE), arg: text(odd), parses: true },
  { id: 'test-open-brace', origin: T(REFUSE), arg: text('{'), parses: false },
  { id: 'test-array', origin: T(REFUSE), arg: text('[]'), parses: false },
  {
    id: 'test-user-prefs-literal',
    origin: T(PREFS, 'the readUserPrefs literal, which readUserPrefs parses'),
    arg: text('{"User":{"Client":{"HideOnClose":"true"}}}'),
    parses: true,
  },
  { id: 'mini-lf', origin: fixture(MINI_LF_PATH), arg: miniLf(), parses: true },
  { id: 'mini-crlf', origin: fixture(MINI_CRLF_PATH), arg: miniCrlf(), parses: true },
  { id: 'empty', origin: fixture(CONFIG, 'emptied'), arg: text(''), parses: false },
  { id: 'whitespace-only', origin: fixture(CONFIG, 'only spaces and CRLF'), arg: text('  \r\n'), parses: false },
  { id: 'null', origin: fixture(CONFIG, 'replaced by the JSON null'), arg: text('null'), parses: false },
  { id: 'string', origin: fixture(CONFIG, 'replaced by a JSON string'), arg: text('"Client"'), parses: false },
  { id: 'number', origin: fixture(CONFIG, 'replaced by a JSON number'), arg: text('1'), parses: false },
  { id: 'true', origin: fixture(CONFIG, 'replaced by the JSON true'), arg: text('true'), parses: false },
  { id: 'empty-object', origin: fixture(CONFIG, 'replaced by an empty object on one line'), arg: text('{}'), parses: true },
  { id: 'empty-object-crlf', origin: fixture(CONFIG, 'replaced by an empty object and CRLF'), arg: text('{}\r\n'), parses: true },
  { id: 'cut-half', origin: fixture(CONFIG, 'cut in half'), arg: bytes(config.subarray(0, 2000)), parses: false },
  { id: 'bom', origin: fixture(CONFIG, 'UTF-8 BOM added'), arg: bytes(Buffer.concat([BOM, config])), parses: true },
  { id: 'double-bom', origin: fixture(CONFIG, 'two UTF-8 BOMs added'), arg: bytes(Buffer.concat([BOM, BOM, config])), parses: false },
  {
    id: 'utf16le-bom',
    origin: adversarial('utf8-decode', 'the mini config behind a UTF-16LE BOM; the bytes FF FE decode to two U+FFFD, which JSON.parse refuses'),
    arg: bytes(Buffer.concat([Buffer.from([0xff, 0xfe]), MINI_LF])),
    parses: false,
  },
  { id: 'lf', origin: fixture(CONFIG, 'CRLF made LF'), arg: text(configText.replace(/\r\n/g, '\n')), parses: true },
  { id: 'mixed-eol', origin: fixture(CONFIG, 'first CRLF made LF, the rest kept'), arg: text(configText.replace('\r\n', '\n')), parses: true },
  { id: 'no-trailing-newline', origin: fixture(CONFIG, 'final CRLF removed'), arg: text(configText.replace(/\r\n$/, '')), parses: true },
  { id: 'unescaped-slashes', origin: fixture(CONFIG, 'every \\/ made /'), arg: text(configText.replace(/\\\//g, '/')), parses: true },
  { id: 'one-slash-unescaped', origin: fixture(CONFIG, 'the first \\/ made /, the rest kept'), arg: text(configText.replace('\\/', '/')), parses: true },
  { id: 'indent-2', origin: fixture(MINI_LF_PATH, 'two-space indent'), arg: text(withNames('user_1@example.com', '\n', 2)), parses: true },
  {
    id: 'cap-indent-at',
    origin: fixture(MINI_LF_PATH, 'ten-space indent, the most JSON.stringify writes'),
    arg: text(withNames('user_1@example.com', '\n', 10)),
    parses: true,
  },
  {
    id: 'cap-indent-over',
    origin: adversarial('other', 'an eleven-space indent; JSON.stringify clamps the space argument to 10, so the file does not round-trip'),
    arg: text(withNames('user_1@example.com', '\n', 11)),
    parses: true,
  },
  {
    id: 'tab-indent',
    origin: fixture(MINI_LF_PATH, 'tab indent, which the indent probe does not see'),
    arg: text(qt(MINI_LINES.map((l) => l.replace(/^( {4})+/, (m) => '\t'.repeat(m.length / 4))))),
    parses: true,
  },
  { id: 'compact', origin: fixture(MINI_LF_PATH, 'written on one line'), arg: text(JSON.stringify(JSON.parse(MINI_LF.toString('utf8')))), parses: true },
  {
    id: 'duplicate-key',
    origin: adversarial('json', 'Client appears twice; JSON.parse keeps the last, a strict parser may refuse or keep the first'),
    arg: text(
      qt([
        '{',
        '    "Client": {',
        '        "AutoLogin": "true"',
        '    },',
        '    "Client": {',
        '        "SavedAccountNames": "user_1@example.com"',
        '    }',
        '}',
      ]),
    ),
    parses: true,
  },
  {
    id: 'integer-keys',
    origin: adversarial('json', 'integer-like keys; a JS object enumerates them first in ascending order, so the file reorders and does not round-trip'),
    arg: text(qt(['{', '    "b": "1",', '    "10": "2",', '    "2": "3"', '}'])),
    parses: true,
  },
  {
    id: 'integer-like-not',
    origin: adversarial('json', 'keys that look numeric but are not array indices (leading zero, sign, 2^32-1) keep insertion order'),
    arg: text(qt(['{', '    "b": "1",', '    "01": "2",', '    "-1": "3",', '    "4294967295": "4",', '    "4294967294": "5"', '}'])),
    parses: true,
  },
  {
    id: 'big-numbers',
    origin: adversarial('json', 'numbers JSON.parse turns into doubles: 1e400 is Infinity, 2^53+1 loses a unit, 1.0 is 1, -0 stays -0'),
    arg: text(
      qt(['{', '    "a": 100000000000000000000000,', '    "b": 1e400,', '    "c": 9007199254740993,', '    "d": 1.0,', '    "e": -0,', '    "f": 0.1', '}']),
    ),
    parses: true,
  },
  {
    id: 'escaped-lone-surrogate',
    origin: adversarial('lone-surrogate', 'a \\ud800 escape; JSON.parse keeps the lone surrogate and JSON.stringify writes it back lower-case'),
    arg: text(qt(['{', '    "Client": {', '        "SavedAccountNames": "\\ud800x@example.com"', '    }', '}'])),
    parses: true,
  },
  {
    id: 'escaped-lone-surrogate-upper',
    origin: adversarial('lone-surrogate', 'an upper-case \\uD800 escape; JSON.stringify writes \\ud800, so the file does not round-trip'),
    arg: text(qt(['{', '    "s": "\\uD800"', '}'])),
    parses: true,
  },
  {
    id: 'cesu-surrogate-bytes',
    origin: adversarial('utf8-decode', 'a surrogate encoded as UTF-8 bytes ED A0 80 inside a string; Node decodes it to U+FFFD three times'),
    arg: bytes(Buffer.concat([Buffer.from('{\n    "s": "a'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('b"\n}\n')])),
    parses: true,
  },
  {
    id: 'invalid-utf8-in-string',
    origin: adversarial('utf8-decode', 'a lone 0xFF and a truncated E2 82 inside strings of the mini config'),
    arg: bytes(Buffer.from(MINI_LF.toString('latin1').replace('user_2', 'user_\xff2').replace('Games', 'Ga\xe2\x82mes'), 'latin1')),
    parses: true,
  },
  {
    id: 'escaped-non-ascii',
    origin: adversarial('json', 'a \\u00e9 escape; JSON.stringify writes the character raw, so the file does not round-trip'),
    arg: text(qt(['{', '    "s": "caf\\u00e9"', '}'])),
    parses: true,
  },
  {
    id: 'raw-non-ascii',
    origin: fixture(MINI_LF_PATH, 'raw non-ASCII and astral characters in a string'),
    arg: text(qt(['{', '    "s": "caf\u00E9 \u{1F600} \u4e2d"', '}'])),
    parses: true,
  },
  {
    id: 'control-escapes',
    origin: adversarial('json', 'control characters as escapes: JSON.stringify writes \\b \\f \\n \\r \\t short and the rest as lower-case \\u00XX'),
    arg: text(qt(['{', '    "s": "\\b\\f\\n\\r\\t\\u0001\\u001f\\u007f\\"\\\\"', '}'])),
    parses: true,
  },
  {
    id: 'control-escapes-upper',
    origin: adversarial('json', 'an upper-case \\u001F escape does not come back as written'),
    arg: text(qt(['{', '    "s": "\\u001F"', '}'])),
    parses: true,
  },
  {
    id: 'raw-line-separator',
    origin: adversarial('json', 'a raw U+2028 inside a string; JSON.stringify writes it raw'),
    arg: text(qt(['{', '    "s": "a\u2028b"', '}'])),
    parses: true,
  },
  {
    id: 'nbsp-before-object',
    origin: adversarial('unicode-space', 'a U+00A0 before the object; JSON whitespace is only space, tab, CR and LF'),
    arg: text('\u00a0{}'),
    parses: false,
  },
  {
    id: 'feff-inside',
    origin: adversarial('unicode-space', 'a U+FEFF after the first brace; only one leading BOM is stripped'),
    arg: text('{\uFEFF}'),
    parses: false,
  },
  { id: 'trailing-comma', origin: fixture(MINI_LF_PATH, 'a trailing comma after the last member'), arg: text('{\n    "a": "1",\n}\n'), parses: false },
  { id: 'trailing-junk', origin: fixture(MINI_LF_PATH, 'text after the closing brace'), arg: text('{}\nx'), parses: false },
  { id: 'single-quotes', origin: fixture(MINI_LF_PATH, 'single-quoted strings'), arg: text("{'a': 'b'}"), parses: false },
  {
    id: 'arrays-and-empties',
    origin: fixture(MINI_LF_PATH, 'arrays, empty arrays and empty objects, as JSON.stringify lays them out'),
    arg: text(JSON.stringify({ a: [1, 'x', [], {}], b: {}, c: [], d: null, e: true }, null, 4) + '\n'),
    parses: true,
  },
  { id: 'qt-empty-object', origin: fixture(MINI_LF_PATH, 'an empty object written over two lines'), arg: text('{\n    "a": {\n    }\n}\n'), parses: true },
  {
    id: 'backslash-slash-in-value',
    origin: adversarial('other', 'the two characters \\\\/ (an escaped backslash, then a slash) make the probe believe slashes are escaped'),
    arg: text(qt(['{', '    "p": "C:\\\\/x"', '}'])),
    parses: true,
  },
  {
    id: 'proto-key',
    origin: adversarial('json', 'an own "__proto__" key; JSON.parse makes it an ordinary property and JSON.stringify writes it back'),
    arg: text(qt(['{', '    "__proto__": {', '        "a": "1"', '    },', '    "b": "2"', '}'])),
    parses: true,
  },
  {
    id: 'proto-nested',
    origin: adversarial('json', 'a "__proto__" key inside Client holding a string, an ordinary member'),
    arg: text(qt(['{', '    "Client": {', '        "__proto__": "x",', '        "SavedAccountNames": "x@example.com"', '    }', '}'])),
    parses: true,
  },
];

const parsedOf = (t: TextCase) => parseConfig(inputBytes(t.arg).toString('utf8'));

const CORPUS_FROM = () => [{ path: CONFIG }, { path: USER_CONFIG }, { path: MINI_LF_PATH, bytes: MINI_LF }, { path: MINI_CRLF_PATH, bytes: MINI_CRLF }];
const textCorpus = (): Case[] =>
  corpus({ seed: 11, count: 160, from: CORPUS_FROM(), args: (m) => [m] }).filter((c) => {
    try {
      return recordable(parseConfig(bytesOf(c).toString('utf8')));
    } catch {
      return true;
    }
  });

const ARG0_CONFIG =
  'arg0 is the file text as src/main/launchers/battlenet/adapter.ts reads Battle.net.config (readLauncherText: readFileSync then toString utf8, BOM kept, invalid bytes as U+FFFD).';
const NO_CAP = 'The function enforces no size cap; it relies on readLauncherText (4 MiB, MAX_LAUNCHER_FILE_BYTES).';

vectorFile({
  area: 'battlenet',
  function: 'parseConfig',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    ARG0_CONFIG,
    'out is { doc, layout }: doc as JSON.parse built it (keys in JS enumeration order, integer-like keys first), layout as detectLayout reads the text.',
    'Errors are BattlenetConfigError with code CONFIG_FORMAT; the "not valid JSON (...)" message embeds V8\'s own JSON.parse message, and the adapter shows it to the user.',
    NO_CAP,
    'gap: src/main/launchers/battlenet/config.ts:44:92 ?: false arm (String(err)), JSON.parse only throws Error instances.',
    'The corpus (seed 11) shares its inputs with detectLayout, roundTrips and serializeConfig; a case whose doc holds a key the encoder refuses (one starting with $) is left out.',
  ].join('\n'),
  call: parseConfig,
  cases: () => [
    ...texts().map((t) => ({ id: t.id, origin: t.origin, args: [t.arg], expect: t.parses ? ('out' as const) : ('error' as const) })),
    ...textCorpus(),
  ],
});

vectorFile({
  area: 'battlenet',
  function: 'detectLayout',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    ARG0_CONFIG,
    'parseConfig calls it on the text with the BOM still in place. It never throws. The corpus is the first 40 seed-11 cases of parseConfig.json.',
  ].join('\n'),
  call: detectLayout,
  cases: () => [...texts().map((t) => ({ id: t.id, origin: t.origin, args: [t.arg], expect: 'out' as const })), ...textCorpus().slice(0, 40)],
});

vectorFile({
  area: 'battlenet',
  function: 'roundTrips',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    ARG0_CONFIG,
    'The round trip itself: parseConfig then serializeConfig, compared with the text. False on any parse error. The adapter refuses the SavedAccountNames rewrite when it is false.',
    NO_CAP,
  ].join('\n'),
  call: roundTrips,
  cases: () => [
    ...texts().map((t) => ({ id: t.id, origin: t.origin, args: [t.arg], expect: 'out' as const })),
    ...corpus({ seed: 11, count: 160, from: CORPUS_FROM(), args: (m) => [m] }),
  ],
});

const LAYOUTS: { id: string; layout: ConfigLayout; what: string }[] = [
  { id: 'indent-0', layout: { eol: '\n', indent: 0, trailingNewline: false, escapeSlashes: false, bom: false }, what: 'indent 0 writes one line' },
  { id: 'indent-1', layout: { eol: '\n', indent: 1, trailingNewline: true, escapeSlashes: false, bom: false }, what: 'indent 1' },
  {
    id: 'indent-2-crlf',
    layout: { eol: '\r\n', indent: 2, trailingNewline: true, escapeSlashes: true, bom: false },
    what: 'indent 2 with CRLF and escaped slashes',
  },
  {
    id: 'cap-indent-at',
    layout: { eol: '\n', indent: 10, trailingNewline: true, escapeSlashes: false, bom: false },
    what: 'indent 10, the most JSON.stringify writes',
  },
  {
    id: 'cap-indent-over',
    layout: { eol: '\n', indent: 11, trailingNewline: true, escapeSlashes: false, bom: false },
    what: 'indent 11, which JSON.stringify clamps to 10',
  },
  {
    id: 'indent-negative',
    layout: { eol: '\n', indent: -1, trailingNewline: true, escapeSlashes: false, bom: false },
    what: 'indent -1, which JSON.stringify treats as none',
  },
  {
    id: 'indent-fraction',
    layout: { eol: '\n', indent: 2.7, trailingNewline: true, escapeSlashes: false, bom: false },
    what: 'indent 2.7, which JSON.stringify truncates to 2',
  },
  { id: 'bom-crlf', layout: { eol: '\r\n', indent: 4, trailingNewline: true, escapeSlashes: true, bom: true }, what: 'the Qt layout behind a BOM' },
  {
    id: 'no-trailing',
    layout: { eol: '\r\n', indent: 4, trailingNewline: false, escapeSlashes: true, bom: false },
    what: 'the Qt layout without the final newline',
  },
];

const SPECIAL_DOCS: { id: string; origin: Origin; doc: unknown }[] = [
  {
    id: 'numbers',
    origin: adversarial('number', 'number formatting: 1e21, 1e-7, 0.1+0.2, 5e-324, 2^53, -0 and the largest double, as JSON.stringify writes them'),
    doc: { a: 1e21, b: 1e-7, c: 0.1 + 0.2, d: 5e-324, e: 2 ** 53, f: -0, g: Number.MAX_VALUE, h: 123456789012345680000 },
  },
  {
    id: 'non-finite',
    origin: adversarial('number', 'NaN and the infinities, which JSON.stringify writes as null'),
    doc: { a: NaN, b: Infinity, c: -Infinity, d: [NaN] },
  },
  {
    id: 'undefined-values',
    origin: adversarial('other', 'undefined members are left out and undefined array items written as null'),
    doc: { a: undefined, b: '1', c: [undefined, 2] },
  },
  {
    id: 'lone-surrogates',
    origin: adversarial('lone-surrogate', 'lone surrogates in a key and a value, which JSON.stringify writes as lower-case \\u escapes'),
    doc: { ['k\ud800']: 'v\udfff', ok: '\u{1F600}' },
  },
  {
    id: 'proto-key',
    origin: adversarial('json', 'a document with an own __proto__ key (built by JSON.parse); JSON.stringify writes it as an ordinary key'),
    doc: JSON.parse('{"__proto__":{"a":"1"},"b":"2"}') as unknown,
  },
  {
    id: 'escapes',
    origin: adversarial('json', 'control characters, quote, backslash, U+2028, U+007F and a slash in a key'),
    doc: { ['a/b']: '\u0000\u0008\u000c\n\r\t\u001f"\\\u2028\u007f/' },
  },
  {
    id: 'nested',
    origin: fixture(CONFIG, 'a nested document with arrays, empty arrays and empty objects'),
    doc: { Client: { list: [1, [2, []], {}], e: {} }, z: [] },
  },
  {
    id: 'integer-keys',
    origin: adversarial('json', 'integer-like keys come out first in ascending order, whatever order the object was built in'),
    doc: { b: '1', 10: '2', 2: '3' },
  },
  { id: 'empty', origin: fixture(CONFIG, 'an empty document'), doc: {} },
];

function serializeCases(): Case[] {
  const out: Case[] = [];
  for (const t of texts().filter((t) => t.parses)) {
    const { doc, layout } = parsedOf(t);
    if (recordable(doc)) out.push({ id: `rt-${t.id}`, origin: t.origin, args: [doc, layout], expect: 'out' });
  }
  const fixtureDoc = parseConfig(configText).doc;
  for (const l of LAYOUTS)
    out.push({ id: `layout-${l.id}`, origin: fixture(CONFIG, `parsed, then written with ${l.what}`), args: [fixtureDoc, l.layout], expect: 'out' });
  const qtLayout = parseConfig(configText).layout;
  for (const d of SPECIAL_DOCS) {
    out.push({ id: `doc-${d.id}`, origin: d.origin, args: [d.doc, qtLayout], expect: 'out' });
    out.push({
      id: `doc-${d.id}-lf2`,
      origin: d.origin,
      args: [d.doc, { eol: '\n', indent: 2, trailingNewline: false, escapeSlashes: false, bom: false }],
      expect: 'out',
    });
  }
  for (const c of textCorpus()) {
    let parsed;
    try {
      parsed = parseConfig(bytesOf(c).toString('utf8'));
    } catch {
      continue;
    }
    out.push({ id: c.id, origin: c.origin, args: [parsed.doc, parsed.layout] });
  }
  for (const c of corpus({ seed: 12, count: 240, from: CORPUS_FROM(), args: (m) => [m] })) {
    let parsed;
    try {
      parsed = parseConfig(bytesOf(c).toString('utf8'));
    } catch {
      continue;
    }
    if (!recordable(parsed.doc)) continue;
    const rng = new Rng(Number(c.id.split('-').pop()) + 12_000);
    const layout: ConfigLayout = {
      eol: rng.pick(['\n', '\r\n'] as const),
      indent: rng.int(13),
      trailingNewline: rng.int(2) === 1,
      escapeSlashes: rng.int(2) === 1,
      bom: rng.int(2) === 1,
    };
    out.push({ id: c.id, origin: { kind: 'corpus', ref: `${c.origin.ref} layout=drawn` }, args: [parsed.doc, layout] });
  }
  return out;
}

vectorFile({
  area: 'battlenet',
  function: 'serializeConfig',
  source: SOURCE,
  note: [
    'arg0 is a config document, arg1 a layout; both in memory, so no decode.',
    'The round trip: case rt-<id> is the out of parseConfig for case <id> of parseConfig.json, and each seed-11 corpus case is the out of parseConfig for the case of the same id there, passed straight in; out equals that text exactly when roundTrips.json says true.',
    'The layout-* and doc-* cases write documents and layouts detectLayout never yields (indent 0, 11, -1, 2.7; NaN, undefined, lone surrogates) to pin JSON.stringify itself.',
    'Seed-12 corpus cases parse a mutated text and write its doc with a layout drawn by Rng(index + 12000): eol, indent 0..12, trailing newline, escaped slashes, BOM, in that order.',
    'It never throws for a JSON document; JSON.stringify could throw only on a bigint or a cycle, which no parsed document holds.',
  ].join('\n'),
  call: serializeConfig,
  cases: serializeCases,
});

vectorFile({
  area: 'battlenet',
  function: 'planSavedAccountNames',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    'arg0 is Battle.net.config as src/main/launchers/battlenet/adapter.ts reads it (readLauncherText for the plan, readFileSync utf8 for the write: both toString utf8, BOM kept); arg1 is the target login from the account, in memory.',
    'out is { text, changes, noop, before, after }; text is the file to write. Errors are BattlenetConfigError (code CONFIG_FORMAT); the adapter shows the message as "Left alone: <message>".',
    NO_CAP,
    'gap: src/main/launchers/battlenet/config.ts:72:64 if arm in the helper section (return null inside the path loop), reached only with a path of two or more keys; planSavedAccountNames asks for Client alone, whose parent is the parsed document, always an object.',
    'Corpus seeds 21, 22 and 23 rewrite towards user_3@example.com (a move), new@example.com (an add) and USER_1@EXAMPLE.COM (first already, a no-op).',
  ].join('\n'),
  call: planSavedAccountNames,
  cases: [
    { id: 'move-saved3', origin: T(MOVE), args: [file(CONFIG), 'SAVED3@example.com'], expect: 'out' },
    { id: 'add-new', origin: T(ADD), args: [file(CONFIG), 'new@example.com'], expect: 'out' },
    { id: 'noop-saved1', origin: T(ADD), args: [file(CONFIG), 'SAVED1@example.com'], expect: 'out' },
    { id: 'refuse-odd-layout', origin: T(REFUSE), args: [text(odd), 'saved2@example.com'], expect: 'error' },
    { id: 'no-client', origin: fixture(USER_CONFIG), args: [file(USER_CONFIG), 'user_1@example.com'], expect: 'error' },
    { id: 'not-json', origin: T(REFUSE, 'parseConfig literal given to the rewriter'), args: [text('{'), 'user_1@example.com'], expect: 'error' },
    { id: 'not-object', origin: T(REFUSE, 'parseConfig literal given to the rewriter'), args: [text('[]'), 'user_1@example.com'], expect: 'error' },
    {
      id: 'client-string',
      origin: fixture(MINI_LF_PATH, 'Client is a string'),
      args: [text(qt(['{', '    "Client": "x"', '}'])), 'user_1@example.com'],
      expect: 'error',
    },
    {
      id: 'client-array',
      origin: fixture(MINI_LF_PATH, 'Client is an array'),
      args: [text(qt(['{', '    "Client": [', '    ]', '}'])), 'user_1@example.com'],
      expect: 'error',
    },
    {
      id: 'client-array-compact',
      origin: fixture(MINI_LF_PATH, 'Client is an empty array on one line'),
      args: [text('{"Client":[]}'), 'user_1@example.com'],
      expect: 'error',
    },
    { id: 'empty-object', origin: fixture(MINI_LF_PATH, 'an empty document'), args: [text('{}'), 'user_1@example.com'], expect: 'error' },
    { id: 'mini-lf-move', origin: fixture(MINI_LF_PATH), args: [miniLf(), 'user_3@example.com'], expect: 'out' },
    { id: 'mini-crlf-move', origin: fixture(MINI_CRLF_PATH), args: [miniCrlf(), 'user_2@example.com'], expect: 'out' },
    {
      id: 'mini-lf-add-slash',
      origin: fixture(MINI_LF_PATH, 'a new login holding a slash and a quote, which the escaped-slash layout writes as \\/ and \\"'),
      args: [miniLf(), 'a/b"c@example.com'],
      expect: 'out',
    },
    { id: 'bom-kept', origin: fixture(CONFIG, 'UTF-8 BOM added'), args: [bytes(Buffer.concat([BOM, config])), 'saved2@example.com'], expect: 'out' },
    { id: 'lf-kept', origin: fixture(CONFIG, 'CRLF made LF'), args: [text(configText.replace(/\r\n/g, '\n')), 'saved5@example.com'], expect: 'out' },
    {
      id: 'no-trailing-newline',
      origin: fixture(CONFIG, 'final CRLF removed'),
      args: [text(configText.replace(/\r\n$/, '')), 'saved4@example.com'],
      expect: 'out',
    },
    {
      id: 'refuse-mixed-eol',
      origin: fixture(CONFIG, 'first CRLF made LF'),
      args: [text(configText.replace('\r\n', '\n')), 'saved2@example.com'],
      expect: 'error',
    },
    {
      id: 'refuse-one-slash',
      origin: fixture(CONFIG, 'the first \\/ made /'),
      args: [text(configText.replace('\\/', '/')), 'saved2@example.com'],
      expect: 'error',
    },
    {
      id: 'names-absent',
      origin: fixture(MINI_LF_PATH, 'no SavedAccountNames: the key is added last'),
      args: [text(qt(['{', '    "Client": {', '        "AutoLogin": "true"', '    }', '}'])), 'User_1@Example.com'],
      expect: 'out',
    },
    {
      id: 'names-not-string',
      origin: fixture(MINI_LF_PATH, 'SavedAccountNames is a number'),
      args: [text(qt(['{', '    "Client": {', '        "SavedAccountNames": 1', '    }', '}'])), 'user_1@example.com'],
      expect: 'out',
    },
    { id: 'names-empty', origin: fixture(MINI_LF_PATH, 'SavedAccountNames is empty'), args: [text(withNames('')), 'user_1@example.com'], expect: 'out' },
    {
      id: 'names-empty-blank-login',
      origin: adversarial('other', 'an empty list and a blank login: the list is written as it was, so noop is true while changes still lists one change'),
      args: [text(withNames('')), '   '],
      expect: 'out',
    },
    {
      id: 'blank-login',
      origin: fixture(MINI_LF_PATH, 'a blank login puts an empty name first'),
      args: [text(withNames('user_1@example.com')), ''],
      expect: 'out',
    },
    {
      id: 'names-commas-only',
      origin: fixture(MINI_LF_PATH, 'SavedAccountNames holds only commas'),
      args: [text(withNames(',,')), 'user_1@example.com'],
      expect: 'out',
    },
    {
      id: 'names-spaces',
      origin: fixture(MINI_LF_PATH, 'spaces and empty items in the list are dropped when it is written back'),
      args: [text(withNames(' user_1@example.com , ,user_2@example.com,')), 'user_2@example.com'],
      expect: 'out',
    },
    {
      id: 'names-spaces-first',
      origin: fixture(MINI_LF_PATH, 'the target is first once its spaces are trimmed: a no-op that leaves the spaces'),
      args: [text(withNames(' user_1@example.com ,user_2@example.com')), 'user_1@example.com'],
      expect: 'out',
    },
    {
      id: 'keeps-found-case',
      origin: fixture(MINI_LF_PATH, 'the moved login keeps the case it was saved with'),
      args: [text(withNames('User_1@Example.com,User_2@Example.com')), '  USER_2@EXAMPLE.COM '],
      expect: 'out',
    },
    {
      id: 'noop-case-insensitive',
      origin: fixture(MINI_LF_PATH, 'the first login differs from the target only in case'),
      args: [text(withNames('User_1@Example.com,user_2@example.com')), 'user_1@example.com'],
      expect: 'out',
    },
    {
      id: 'duplicates-move',
      origin: fixture(MINI_LF_PATH, 'a login saved twice, the target third'),
      args: [text(withNames('user_1@example.com,user_2@example.com,user_1@example.com')), 'user_2@example.com'],
      expect: 'out',
    },
    {
      id: 'duplicates-target',
      origin: fixture(MINI_LF_PATH, 'the target saved twice, not first: both copies collapse into one'),
      args: [text(withNames('user_2@example.com,user_1@example.com,USER_1@example.com')), 'user_1@example.com'],
      expect: 'out',
    },
    {
      id: 'mask-short-and-tag',
      origin: T(PREFS, 'maskLogin literals as saved names around the target'),
      args: [text(withNames('ab,battletag,someone@example.com,@example.com,x')), 'user_1@example.com'],
      expect: 'out',
    },
    {
      id: 'mask-astral-first',
      origin: adversarial(
        'utf16-length',
        'a saved login starting with an astral character; maskLogin keeps login[0], one UTF-16 unit, so the change text holds a lone high surrogate',
      ),
      args: [text(withNames('\u{1F600}x@example.com,\u{1F600}tag,user_1@example.com')), 'user_1@example.com'],
      expect: 'out',
    },
    {
      id: 'case-dotted-i',
      origin: adversarial('case-mapping', 'the login \u0130\u2026 lower-cases to i + U+0307, two code units, which the list does not hold, so it is added'),
      args: [text(withNames('i@example.com,x@example.com')), '\u0130@example.com'],
      expect: 'out',
    },
    {
      id: 'case-kelvin',
      origin: adversarial('case-mapping', 'the Kelvin sign U+212A lower-cases to an ASCII k and matches the saved k@example.com'),
      args: [text(withNames('x@example.com,k@example.com')), '\u212A@example.com'],
      expect: 'out',
    },
    {
      id: 'case-sharp-s',
      origin: adversarial('case-mapping', 'capital sharp s U+1E9E lower-cases to \u00DF; \u00DF itself stays (no upper-case folding)'),
      args: [text(withNames('x@example.com,stra\u00dfe@example.com')), 'STRA\u1E9EE@example.com'],
      expect: 'out',
    },
    {
      id: 'case-final-sigma',
      origin: adversarial('case-mapping', 'a capital sigma at the end of a word lower-cases to the final form \u03C2 in JS'),
      args: [text(withNames('x@example.com')), '\u039F\u03A3@example.com'],
      expect: 'out',
    },
    {
      id: 'trim-unicode',
      origin: adversarial('unicode-space', 'U+3000 and U+FEFF around the login and a saved name; JS trim removes both, Rust str::trim keeps U+FEFF'),
      args: [text(withNames('x@example.com,\uFEFFuser_2@example.com\u3000')), '\u3000user_2@example.com\uFEFF'],
      expect: 'out',
    },
    {
      id: 'trim-nbsp-line-sep',
      origin: adversarial('unicode-space', 'U+00A0 and U+2028 around the login are trimmed'),
      args: [text(withNames('x@example.com')), '\u00a0user_1@example.com\u2028'],
      expect: 'out',
    },
    {
      id: 'login-lone-surrogate',
      origin: adversarial('lone-surrogate', 'a login with a lone surrogate; JSON.stringify writes it as \\udc00'),
      args: [file(CONFIG), '\udc00@example.com'],
      expect: 'out',
    },
    {
      id: 'login-non-ascii-raw',
      origin: fixture(CONFIG, 'a login with non-ASCII and astral characters, written raw'),
      args: [file(CONFIG), 'caf\u00E9\u{1F600}@example.com'],
      expect: 'out',
    },
    {
      id: 'refuse-integer-keys',
      origin: adversarial('json', 'an integer-like key in Client reorders on the way through JSON.parse, so the rewrite is refused'),
      args: [text(qt(['{', '    "Client": {', '        "SavedAccountNames": "x@example.com",', '        "7": "1"', '    }', '}'])), 'user_1@example.com'],
      expect: 'error',
    },
    {
      id: 'proto-key',
      origin: adversarial('json', 'an own "__proto__" key next to Client survives JSON.parse and JSON.stringify as an ordinary key'),
      args: [
        text(
          qt([
            '{',
            '    "__proto__": {',
            '        "SavedAccountNames": "evil@example.com"',
            '    },',
            '    "Client": {',
            '        "SavedAccountNames": "x@example.com"',
            '    }',
            '}',
          ]),
        ),
        'user_1@example.com',
      ],
      expect: 'out',
    },
    {
      id: 'proto-client',
      origin: adversarial('json', 'a "__proto__" key inside Client is an ordinary member, not a prototype'),
      args: [
        text(qt(['{', '    "Client": {', '        "__proto__": "x",', '        "SavedAccountNames": "x@example.com"', '    }', '}'])),
        'user_1@example.com',
      ],
      expect: 'out',
    },
    {
      id: 'duplicate-names-key',
      origin: adversarial('json', 'SavedAccountNames twice; JSON.parse keeps the last and the writer drops the first, so the rewrite is refused'),
      args: [
        text(qt(['{', '    "Client": {', '        "SavedAccountNames": "a@example.com",', '        "SavedAccountNames": "b@example.com"', '    }', '}'])),
        'user_1@example.com',
      ],
      expect: 'error',
    },
    {
      id: 'invalid-utf8-name',
      origin: adversarial(
        'utf8-decode',
        'a lone 0xFF in a saved login: Node decodes it to U+FFFD and the rewrite writes U+FFFD back, so the written bytes differ from the file',
      ),
      args: [bytes(Buffer.from(MINI_LF.toString('latin1').replace('user_2', 'user_\xff2'), 'latin1')), 'user_3@example.com'],
      expect: 'out',
    },
    ...corpus({ seed: 21, count: 40, from: CORPUS_FROM(), args: (m) => [m, 'user_3@example.com'] }),
    ...corpus({ seed: 22, count: 40, from: CORPUS_FROM(), args: (m) => [m, 'new@example.com'] }),
    ...corpus({ seed: 23, count: 40, from: CORPUS_FROM(), args: (m) => [m, 'USER_1@EXAMPLE.COM'] }),
  ],
});

vectorFile({
  area: 'battlenet',
  function: 'maskLogin',
  source: SOURCE,
  note: 'arg0 is a saved login, in memory. planSavedAccountNames shows every login but the target through it. It slices by UTF-16 unit.',
  call: maskLogin,
  cases: [
    { id: 'email', origin: T(PREFS), args: ['someone@example.com'], expect: 'out' },
    { id: 'two-chars', origin: T(PREFS), args: ['ab'], expect: 'out' },
    { id: 'battletag', origin: T(PREFS), args: ['battletag'], expect: 'out' },
    { id: 'empty', origin: T(PREFS, 'an empty login'), args: [''], expect: 'out' },
    { id: 'one-char', origin: T(PREFS, 'a one-character login'), args: ['a'], expect: 'out' },
    { id: 'cap-short-at', origin: T(PREFS, 'two characters, the longest login shown whole'), args: ['xy'], expect: 'out' },
    { id: 'cap-short-over', origin: T(PREFS, 'three characters'), args: ['xyz'], expect: 'out' },
    { id: 'at-first', origin: T(PREFS, 'the @ is the first character'), args: ['@example.com'], expect: 'out' },
    { id: 'at-second', origin: T(PREFS, 'one character before the @'), args: ['a@example.com'], expect: 'out' },
    { id: 'two-ats', origin: T(PREFS, 'two @ signs: the first one splits'), args: ['a@b@example.com'], expect: 'out' },
    {
      id: 'astral-first',
      origin: adversarial('utf16-length', 'an astral first character: login[0] is its high surrogate alone'),
      args: ['\u{1F600}x@example.com'],
      expect: 'out',
    },
    {
      id: 'astral-only',
      origin: adversarial('utf16-length', 'a single astral character is two UTF-16 units, so it is shown whole'),
      args: ['\u{1F600}'],
      expect: 'out',
    },
    {
      id: 'astral-tag',
      origin: adversarial('utf16-length', 'an astral character then a letter: three units, masked to a lone high surrogate'),
      args: ['\u{1F600}x'],
      expect: 'out',
    },
    { id: 'combining', origin: adversarial('utf16-length', 'a base letter and a combining mark: two units, shown whole'), args: ['e\u0301'], expect: 'out' },
  ],
});

vectorFile({
  area: 'battlenet',
  function: 'splitSavedAccountNames',
  source: SOURCE,
  note: 'arg0 is Client.SavedAccountNames as read from the parsed document (a string), or null when absent; in memory.',
  call: splitSavedAccountNames,
  cases: [
    {
      id: 'fixture',
      origin: fromTest(FILES_TEST, D_CONFIG, 'reads the client settings and the Games timestamps'),
      args: ['saved1@example.com,saved2@example.com,saved3@example.com,saved4@example.com,saved5@example.com'],
      expect: 'out',
    },
    { id: 'null', origin: fixture(USER_CONFIG, 'no SavedAccountNames'), args: [null], expect: 'out' },
    { id: 'empty', origin: fixture(CONFIG, 'SavedAccountNames empty'), args: [''], expect: 'out' },
    { id: 'commas', origin: fixture(CONFIG, 'only commas'), args: [',,,'], expect: 'out' },
    { id: 'spaces', origin: fixture(CONFIG, 'spaces and empty items'), args: [' a@example.com , ,b@example.com,'], expect: 'out' },
    { id: 'tabs-newlines', origin: fixture(CONFIG, 'tabs and newlines around items'), args: ['\ta@example.com\n,\r\nb@example.com'], expect: 'out' },
    {
      id: 'unicode-spaces',
      origin: adversarial('unicode-space', 'U+FEFF, U+3000, U+00A0, U+2028 and U+180E around items; JS trim removes all but U+180E'),
      args: ['\uFEFFa@example.com\u3000,\u00a0b@example.com\u2028,\u180Ec@example.com'],
      expect: 'out',
    },
    {
      id: 'only-unicode-space',
      origin: adversarial('unicode-space', 'an item of U+FEFF alone trims to empty and is dropped'),
      args: ['\uFEFF,a@example.com'],
      expect: 'out',
    },
    { id: 'case-kept', origin: fixture(CONFIG, 'mixed case is kept'), args: ['User_1@Example.com'], expect: 'out' },
  ],
});
