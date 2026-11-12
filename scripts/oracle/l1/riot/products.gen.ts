import { adversarial, bundleBytes, bytes, file, fixture, fromTest, text, vectorFile } from '../lib/index';
import { launchArgs, parseInstalls, parseProductSettings } from '../../../../src/main/launchers/riot/products';

const DIR = 'fixtures/launchers/riot';
const VALORANT = `${DIR}/valorant.live.product_settings.yaml`;
const LEAGUE = `${DIR}/league_of_legends.live.product_settings.yaml`;
const INSTALLS = `${DIR}/RiotClientInstalls.json`;
const ADAPTER_TESTS = 'test/riot-adapter.test.ts';
const PARSERS = 'Riot metadata parsers';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const valorant = bundleBytes(VALORANT);
const installs = bundleBytes(INSTALLS);

vectorFile({
  area: 'riot',
  function: 'parseProductSettings',
  source: 'src/main/launchers/riot/products.ts',
  decode: { 0: 'utf8' },
  note: [
    'arg0 is <product>.<patchline>.product_settings.yaml as src/main/launchers/riot/adapter.ts reads it (readLauncherText: readFileSync, then toString utf8; a BOM stays as U+FEFF, invalid bytes become U+FFFD).',
    'The function relies on readLauncherText for its size cap (4 MiB) and enforces none itself.',
    'Lines split on \\r?\\n only: a lone CR stays inside a line, where the JS `.` of TOP_LEVEL_SCALAR does not match it (nor U+2028 or U+2029), so such a line reads as no key at all.',
  ].join('\n'),
  call: parseProductSettings,
  cases: [
    {
      id: 'fixture-valorant',
      origin: fromTest(ADAPTER_TESTS, PARSERS, 'reads the top-level scalars of a product settings file'),
      args: [file(VALORANT)],
      expect: 'out',
    },
    {
      id: 'fixture-league',
      origin: fromTest(ADAPTER_TESTS, PARSERS, 'reads the top-level scalars of a product settings file'),
      args: [file(LEAGUE)],
      expect: 'out',
    },
    {
      id: 'empty-value-and-nested',
      origin: fromTest(ADAPTER_TESTS, PARSERS, 'reads the top-level scalars of a product settings file'),
      args: [text('product_install_full_path: ""\nnested:\n    product_install_root: "x"\n')],
      expect: 'out',
    },
    { id: 'empty', origin: fixture(VALORANT, 'emptied'), args: [text('')], expect: 'out' },
    {
      id: 'crlf',
      origin: fixture(VALORANT, 'LF made CRLF'),
      args: [bytes(Buffer.from(valorant.toString('latin1').replace(/\n/g, '\r\n'), 'latin1'))],
      expect: 'out',
    },
    {
      id: 'bom',
      origin: fixture(VALORANT, 'UTF-8 BOM added: the first line keeps U+FEFF and its key no longer matches'),
      args: [
        bytes(
          Buffer.concat([BOM, Buffer.from('product_install_full_path: "D:/Games/Riot Games/VALORANT/live"\nproduct_install_root: "D:/Games/Riot Games"\n')]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'skipped-prefixes',
      origin: fixture(VALORANT, 'the three keys behind a space, a tab, a comment and a list dash'),
      args: [
        text(
          ' product_install_full_path: "D:/a"\n\tproduct_install_root: "D:/b"\n#product_dependency: "c"\n-product_dependency: "d"\nproduct_dependency: "teamfighttactics.live"\n',
        ),
      ],
      expect: 'out',
    },
    {
      id: 'quotes',
      origin: fixture(LEAGUE, 'single quotes, a bare value, inner quotes, an unmatched quote'),
      args: [
        text(`product_install_full_path: 'D:/Games/Riot Games/League of Legends'\nproduct_install_root: D:/Games/Riot Games\nproduct_dependency: "a"b"\n`),
      ],
      expect: 'out',
    },
    {
      id: 'unmatched-quote',
      origin: fixture(LEAGUE, 'a value with an opening quote only, and one of two single quotes'),
      args: [text(`product_install_full_path: "D:/Games\nproduct_install_root: ''\nproduct_dependency: '\n`)],
      expect: 'out',
    },
    {
      id: 'no-space-after-colon',
      origin: fixture(VALORANT, 'key:value with no space, and trailing spaces and tabs'),
      args: [text('product_install_full_path:D:/x\nproduct_install_root:   "D:/y" \t \nproduct_dependency:\n')],
      expect: 'out',
    },
    {
      id: 'duplicate-keys-last-wins',
      origin: fixture(VALORANT, 'product_install_full_path given twice, then emptied'),
      args: [text('product_install_full_path: "D:/first"\nproduct_install_full_path: "D:/second"\nproduct_install_root: "D:/r"\nproduct_install_root:\n')],
      expect: 'out',
    },
    {
      id: 'comment-in-value',
      origin: fixture(VALORANT, 'a trailing # comment, which YAML would drop and the parser keeps'),
      args: [text('product_install_full_path: D:/Games/Riot Games/VALORANT/live # moved\n')],
      expect: 'out',
    },
    {
      id: 'key-charset',
      origin: fixture(VALORANT, 'a key with a space and one with dots and dashes before the real keys'),
      args: [text('product install: "x"\nproduct.install-root_2: "y"\nproduct_install_root: "D:/Games/Riot Games"\n')],
      expect: 'out',
    },
    {
      id: 'adv-lone-cr',
      origin: adversarial('regex', 'a lone CR inside a line: JS `.` stops at CR so the line reads as no key; a Rust regex `.` matches CR'),
      args: [text('product_install_full_path: "D:/a"\rproduct_install_root: "D:/b"\nproduct_dependency: "x\ry"\n')],
      expect: 'out',
    },
    {
      id: 'adv-line-separator',
      origin: adversarial('regex', 'U+2028 and U+2029 inside a value: JS `.` does not match them, so the line is skipped; Rust `.` matches them'),
      args: [text('product_install_full_path: "D:/a\u2028b"\nproduct_install_root: "D:/c\u2029d"\nproduct_dependency: "e\u0085f"\n')],
      expect: 'out',
    },
    {
      id: 'adv-unicode-space-around',
      origin: adversarial('unicode-space', 'only space and tab are trimmed around a value ([ \\t]*); U+00A0, U+3000 and U+FEFF stay in it'),
      args: [text('product_install_full_path:\u00a0"D:/a"\nproduct_install_root: "D:/b"\u3000\nproduct_dependency: \ufeff"c"\n')],
      expect: 'out',
    },
    {
      id: 'adv-invalid-utf8',
      origin: adversarial('utf8-decode', `${VALORANT} with a lone 0xFF and a truncated sequence in the install path; Node gives one U+FFFD each`),
      args: [
        bytes(
          Buffer.concat([
            Buffer.from('product_install_full_path: "D:/Games/'),
            Buffer.from([0xff]),
            Buffer.from('VALORANT/'),
            Buffer.from([0xe2, 0x82]),
            Buffer.from('live"\n'),
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'adv-astral-key-value',
      origin: adversarial('utf16-length', 'an astral character in a value and before a key; the value is kept whole'),
      args: [text('product_install_full_path: "D:/\u{1F3AE}/live"\n\u{1F3AE}product_install_root: "x"\n')],
      expect: 'out',
    },
  ],
});

const installsCall = (raw: string): unknown => {
  const parsed = parseInstalls(raw);
  return { rcDefault: parsed.rcDefault, rcLive: parsed.rcLive, associatedClients: [...parsed.associatedClients] };
};

const JUNK = 'reads RiotClientInstalls.json and shrugs at junk';

vectorFile({
  area: 'riot',
  function: 'parseInstalls',
  source: 'src/main/launchers/riot/products.ts',
  decode: { 0: 'utf8' },
  note: [
    'arg0 is %ProgramData%\\Riot Games\\RiotClientInstalls.json as src/main/launchers/riot/adapter.ts reads it (readLauncherText: readFileSync, then toString utf8; a BOM stays as U+FEFF, so JSON.parse fails on it and the result is the empty one).',
    'call projects the result: associatedClients, a Map, is recorded as its entries in iteration order ([folder, exe] pairs), which is the order Object.entries gives the parsed object (integer-like keys first, then insertion order).',
    'The function relies on readLauncherText for its size cap (4 MiB) and enforces none itself.',
  ].join('\n'),
  call: installsCall,
  cases: [
    { id: 'fixture', origin: fromTest(ADAPTER_TESTS, PARSERS, JUNK), args: [file(INSTALLS)], expect: 'out' },
    { id: 'junk-empty', origin: fromTest(ADAPTER_TESTS, PARSERS, JUNK), args: [text('')], expect: 'out' },
    { id: 'junk-open-brace', origin: fromTest(ADAPTER_TESTS, PARSERS, JUNK), args: [text('{')], expect: 'out' },
    { id: 'junk-array', origin: fromTest(ADAPTER_TESTS, PARSERS, JUNK), args: [text('[]')], expect: 'out' },
    { id: 'junk-wrong-types', origin: fromTest(ADAPTER_TESTS, PARSERS, JUNK), args: [text('{"rc_default": 5, "associated_client": "x"}')], expect: 'out' },
    { id: 'null', origin: fixture(INSTALLS, 'the JSON literal null'), args: [text('null')], expect: 'out' },
    { id: 'number', origin: fixture(INSTALLS, 'a bare number'), args: [text('42')], expect: 'out' },
    { id: 'string', origin: fixture(INSTALLS, 'a bare string'), args: [text('"D:/Games/Riot Games/Riot Client/RiotClientServices.exe"')], expect: 'out' },
    { id: 'empty-object', origin: fixture(INSTALLS, 'an empty object'), args: [text('{}')], expect: 'out' },
    {
      id: 'array-with-items',
      origin: fixture(INSTALLS, 'an array at the top: typeof object, so it is read and every field is missing'),
      args: [text('["D:/Games/Riot Games/Riot Client/RiotClientServices.exe"]')],
      expect: 'out',
    },
    { id: 'bom', origin: fixture(INSTALLS, 'UTF-8 BOM added'), args: [bytes(Buffer.concat([BOM, installs]))], expect: 'out' },
    {
      id: 'crlf',
      origin: fixture(INSTALLS, 'LF made CRLF'),
      args: [bytes(Buffer.from(installs.toString('latin1').replace(/\n/g, '\r\n'), 'latin1'))],
      expect: 'out',
    },
    { id: 'truncated', origin: fixture(INSTALLS, 'cut in the middle'), args: [bytes(installs.subarray(0, 120))], expect: 'out' },
    {
      id: 'blank-and-non-string-values',
      origin: fixture(INSTALLS, 'blank, whitespace-only, null and non-string values everywhere'),
      args: [
        text(
          '{"rc_default": "", "rc_live": "   ", "associated_client": {"D:/a/": "", "D:/b/": " \\t ", "D:/c/": null, "D:/d/": 7, "D:/e/": {"x": 1}, "D:/f/": "D:/Games/Riot Games/Riot Client/RiotClientServices.exe"}}',
        ),
      ],
      expect: 'out',
    },
    {
      id: 'value-kept-untrimmed',
      origin: fixture(INSTALLS, 'values with outer spaces: the check trims, the value is returned as it is'),
      args: [text('{"rc_default": "  D:/Games/Riot Games/Riot Client/RiotClientServices.exe ", "rc_live": "\\tD:/x"}')],
      expect: 'out',
    },
    {
      id: 'associated-null-and-array',
      origin: fixture(INSTALLS, 'associated_client null, then an array, which Object.entries reads by index'),
      args: [text('{"associated_client": ["D:/Games/Riot Games/Riot Client/RiotClientServices.exe", ""], "rc_live": null}')],
      expect: 'out',
    },
    {
      id: 'associated-null',
      origin: fixture(INSTALLS, 'associated_client null'),
      args: [text('{"associated_client": null, "rc_default": "D:/x.exe"}')],
      expect: 'out',
    },
    {
      id: 'adv-json-duplicates',
      origin: adversarial('json', 'duplicate keys at both levels: JSON.parse keeps the last, and a re-set key keeps its first position'),
      args: [
        text(
          '{"rc_default": "D:/first.exe", "associated_client": {"D:/a/": "D:/1.exe", "D:/b/": "D:/2.exe", "D:/a/": "D:/3.exe"}, "rc_default": "D:/second.exe"}',
        ),
      ],
      expect: 'out',
    },
    {
      id: 'adv-json-integer-keys',
      origin: adversarial(
        'json',
        'integer-like folder keys come first in Object.entries, in ascending order, whatever the file order; "01" and "4294967295" are not array indices and stay in place',
      ),
      args: [
        text(
          '{"associated_client": {"D:/z/": "D:/z.exe", "10": "D:/10.exe", "01": "D:/01.exe", "2": "D:/2.exe", "4294967295": "D:/max.exe", "4294967294": "D:/idx.exe"}}',
        ),
      ],
      expect: 'out',
    },
    {
      id: 'adv-json-proto',
      origin: adversarial(
        'json',
        'a __proto__ key: JSON.parse makes it an own property, so it is one more associated folder; at the top it is just an unknown key',
      ),
      args: [text('{"__proto__": {"rc_default": "D:/inherited.exe"}, "associated_client": {"__proto__": "D:/proto.exe", "D:/a/": "D:/a.exe"}}')],
      expect: 'out',
    },
    {
      id: 'adv-json-lone-surrogate',
      origin: adversarial(
        'lone-surrogate',
        'a \\ud800 escape in a value and in a key: JSON.parse accepts it and the strings carry a lone surrogate; serde_json refuses the document',
      ),
      args: [text('{"rc_default": "D:/Riot\\ud800.exe", "associated_client": {"D:/\\udc00/": "D:/x.exe"}}')],
      expect: 'out',
    },
    {
      id: 'adv-json-escapes',
      origin: adversarial('json', 'escaped slashes, a \\u0041 escape and an escaped astral pair'),
      args: [text('{"rc_default": "D:\\/Games\\/\\u0041\\ud83c\\udfae.exe"}')],
      expect: 'out',
    },
    {
      id: 'adv-trim-bom-only',
      origin: adversarial('unicode-space', 'a value of U+FEFF alone: JS trim removes it, so it counts as blank (null); Rust str::trim keeps U+FEFF'),
      args: [text('{"rc_default": "\\ufeff", "rc_live": "\\u3000\\u00a0", "associated_client": {"D:/a/": "\\u2028"}}')],
      expect: 'out',
    },
    {
      id: 'adv-trim-nel-only',
      origin: adversarial('unicode-space', 'a value of U+0085 alone: JS trim keeps it (not JS whitespace), so it is returned; Rust str::trim removes U+0085'),
      args: [text('{"rc_default": "\\u0085", "rc_live": "\\u180e"}')],
      expect: 'out',
    },
    {
      id: 'adv-invalid-utf8',
      origin: adversarial('utf8-decode', `${INSTALLS} with a lone 0xC0 inside a path; Node decodes it to U+FFFD and JSON.parse keeps it`),
      args: [bytes(Buffer.concat([Buffer.from('{"rc_default": "D:/Riot'), Buffer.from([0xc0]), Buffer.from(' Games/RiotClientServices.exe"}')]))],
      expect: 'out',
    },
    {
      id: 'adv-big-number-value',
      origin: adversarial('json', 'a number too large for a double as a value, and leading whitespace JSON allows'),
      args: [text(' \r\n\t{"rc_default": 123456789012345678901234567890, "rc_live": "D:/x.exe"}')],
      expect: 'out',
    },
  ],
});

const LAUNCH_TEST = 'names the game’s launch arguments in the start step when a launch follows the switch';

vectorFile({
  area: 'riot',
  function: 'launchArgs',
  source: 'src/main/launchers/riot/products.ts',
  note: [
    'arg0 is a RiotProductId as parseProductId makes it from a metadata folder name (product and patchline already lower-cased); the function only formats it and validates nothing.',
    'The id field is not read.',
  ].join('\n'),
  call: launchArgs,
  cases: [
    {
      id: 'valorant-live',
      origin: fromTest(ADAPTER_TESTS, 'Riot switch plan (dry run)', LAUNCH_TEST),
      args: [{ id: 'valorant.live', product: 'valorant', patchline: 'live' }],
      expect: 'out',
    },
    {
      id: 'valorant-pbe',
      origin: fromTest(ADAPTER_TESTS, 'Riot launch', 'stops watching when the signal aborts, with the client already started'),
      args: [{ id: 'valorant.pbe', product: 'valorant', patchline: 'pbe' }],
      expect: 'out',
    },
    {
      id: 'league-live',
      origin: fixture(LEAGUE, 'the product of this settings file'),
      args: [{ id: 'league_of_legends.live', product: 'league_of_legends', patchline: 'live' }],
      expect: 'out',
    },
    {
      id: 'id-not-read',
      origin: fromTest(ADAPTER_TESTS, 'Riot switch plan (dry run)', `${LAUNCH_TEST} | the id field disagrees with the parts`),
      args: [{ id: 'Riot Client', product: 'bacon', patchline: 'live' }],
      expect: 'out',
    },
    {
      id: 'unvalidated-parts',
      origin: fixture(VALORANT, 'parts with a space, an equals sign and an empty patchline, which launchArgs passes through as they are'),
      args: [{ id: 'x', product: 'a b=c', patchline: '' }],
      expect: 'out',
    },
    {
      id: 'adv-astral',
      origin: adversarial('utf16-length', 'an astral character in the product goes through unchanged'),
      args: [{ id: 'x', product: 'lion\u{1F3AE}', patchline: 'live' }],
      expect: 'out',
    },
    {
      id: 'adv-lone-surrogate',
      origin: adversarial('lone-surrogate', 'a lone surrogate in the patchline goes into the argument as it is; a Rust String cannot hold one'),
      args: [{ id: 'x', product: 'valorant', patchline: 'live\ud800' }],
      expect: 'out',
    },
  ],
});
