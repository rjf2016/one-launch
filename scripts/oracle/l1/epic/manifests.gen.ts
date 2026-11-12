import { adversarial, bundleBytes, bytes, type Case, file, fixture, fromTest, text, vectorFile } from '../lib/index';
import { launchUri, parseItemManifest, parseLauncherInstalled } from '../../../../src/main/launchers/epic/manifests';

const SOURCE = 'src/main/launchers/epic/manifests.ts';
const ITEM = 'fixtures/launchers/epic/A0000000000000000000000000000001.item';
const DAT = 'fixtures/launchers/epic/LauncherInstalled.dat';
const TESTS = 'test/epic-files.test.ts';
const T_PARSE = ['Epic .item manifests', 'parses the sanitized Rocket League manifest and normalizes its mixed separators'] as const;
const T_LIBRARY = ['Epic .item manifests', 'keeps DLC, incomplete installs, and engine installs out of the library'] as const;
const T_REJECT = ['Epic .item manifests', 'rejects manifests without an AppName or InstallLocation, and non-JSON'] as const;
const T_DAT = ['Epic .item manifests', 'parses LauncherInstalled.dat as a cross-check list'] as const;
const T_URI = ['Epic .item manifests', 'builds both launch URI forms and falls back to the app name without catalog ids'] as const;

const itemText = (): string => bundleBytes(ITEM).toString('utf8');
const datText = (): string => bundleBytes(DAT).toString('utf8');
const editItem = (edit: (o: Record<string, unknown>) => void): string => {
  const o = JSON.parse(itemText()) as Record<string, unknown>;
  edit(o);
  return JSON.stringify(o, null, '\t');
};
const minimal = (fields: Record<string, unknown>): string => JSON.stringify({ AppName: 'Sugar', InstallLocation: 'D:\\Games\\Sugar', ...fields });
const READ_NOTE =
  'arg0 is the file as the Epic adapter reads it (src/main/launchers/epic/adapter.ts readLauncherText: readLauncherBytes, then toString utf8, so a BOM is kept and invalid bytes become U+FFFD); the function strips one leading U+FEFF itself.';
const PATH_NOTE =
  'Paths go through normalizeLauncherPath (src/main/platform/fs-path.ts): trim, a doubled backslash made single, separators unified to \\ by path.win32.normalize (which also resolves . and ..), a trailing separator dropped except on a drive root.';
const JSON_NOTE =
  "A JSON.parse failure is recorded with V8's message inside the function's own text, exactly as Node prints it; the error is EpicManifestError with the own property code MANIFEST_FORMAT.";
const CAP_NOTE = 'No size cap in the function: it relies on readLauncherBytes (MAX_LAUNCHER_FILE_BYTES, 4 MiB) in the adapter.';

vectorFile({
  area: 'epic',
  function: 'parseItemManifest',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    READ_NOTE,
    PATH_NOTE,
    JSON_NOTE,
    CAP_NOTE,
    'gap: src/main/launchers/epic/manifests.ts:53:89 ?: false arm, JSON.parse only ever throws a SyntaxError (an Error), so String(err) is never reached.',
  ].join('\n'),
  call: parseItemManifest,
  cases: () => {
    const c = (id: string, origin: Case['origin'], arg: unknown, expect: 'out' | 'error'): Case => ({ id, origin, args: [arg], expect });
    const f = (change: string) => fixture(ITEM, change);
    const base = itemText();
    return [
      c('test-fixture', fromTest(TESTS, ...T_PARSE), file(ITEM), 'out'),
      c('test-incomplete', fromTest(TESTS, ...T_LIBRARY), text(base.replace('"bIsIncompleteInstall": false', '"bIsIncompleteInstall": true')), 'out'),
      c('test-dlc', fromTest(TESTS, ...T_LIBRARY), text(base.replace('"MainGameAppName": "Sugar"', '"MainGameAppName": "OtherGame"')), 'out'),
      c('test-engines', fromTest(TESTS, ...T_LIBRARY), text(base.replace('"public",\n\t\t"games",\n\t\t"applications"', '"public",\n\t\t"engines"')), 'out'),
      c('test-no-categories', fromTest(TESTS, ...T_LIBRARY), text(base.replace('"public",\n\t\t"games",\n\t\t"applications"', '')), 'out'),
      c('test-no-appname', fromTest(TESTS, ...T_REJECT), text('{"DisplayName":"x","InstallLocation":"C:\\\\x"}'), 'error'),
      c('test-no-install-location', fromTest(TESTS, ...T_REJECT), text('{"AppName":"x"}'), 'error'),
      c('test-not-json', fromTest(TESTS, ...T_REJECT), text('not json'), 'error'),
      c('bom', f('UTF-8 BOM added'), bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bundleBytes(ITEM)])), 'out'),
      c(
        'double-bom',
        f('two UTF-8 BOMs: only one is stripped'),
        bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), bundleBytes(ITEM)])),
        'error',
      ),
      c('crlf', f('LF made CRLF'), text(base.replace(/\n/g, '\r\n')), 'out'),
      c('empty', f('an empty file'), text(''), 'error'),
      c('json-null', f('the JSON null'), text('null'), 'error'),
      c('json-array', f('a JSON array'), text('[{"AppName":"Sugar"}]'), 'error'),
      c('json-number', f('a JSON number'), text('0'), 'error'),
      c('json-string', f('a JSON string'), text('"Sugar"'), 'error'),
      c('json-true', f('the JSON true'), text('true'), 'error'),
      c('json-false', f('the JSON false'), text('false'), 'error'),
      c('truncated', f('cut in half'), text(base.slice(0, Math.floor(base.length / 2))), 'error'),
      c('appname-blank', f('AppName only spaces'), text(minimal({ AppName: '   ' })), 'error'),
      c('appname-number', f('AppName a number'), text(minimal({ AppName: 7 })), 'error'),
      c('appname-trimmed', f('AppName with spaces and tabs around it'), text(minimal({ AppName: ' \tSugar\n ' })), 'out'),
      c('install-location-blank', f('InstallLocation only spaces'), text(minimal({ InstallLocation: ' ' })), 'error'),
      c('install-location-array', f('InstallLocation an array'), text(minimal({ InstallLocation: ['D:\\x'] })), 'error'),
      c('minimal', f('only AppName and InstallLocation'), text(minimal({})), 'out'),
      c('display-name-blank', f('DisplayName blank falls back to AppName'), text(minimal({ DisplayName: '  ' })), 'out'),
      c('guid-number', f('InstallationGuid a number gives an empty guid'), text(minimal({ InstallationGuid: 1 })), 'out'),
      c('catalog-blank', f('catalog ids blank'), text(minimal({ CatalogNamespace: '', CatalogItemId: ' ' })), 'out'),
      c('launch-exe-blank', f('LaunchExecutable blank'), text(minimal({ LaunchExecutable: ' ' })), 'out'),
      c(
        'launch-exe-dot-segments',
        f('LaunchExecutable with . and .. segments'),
        text(minimal({ LaunchExecutable: './Binaries/../Binaries//Win64/Game.exe' })),
        'out',
      ),
      c('launch-exe-above-root', f('LaunchExecutable climbing above its folder'), text(minimal({ LaunchExecutable: '../../Other/x.exe' })), 'out'),
      c('location-trailing-slash', f('InstallLocation with a trailing slash'), text(minimal({ InstallLocation: 'D:/Games/Sugar/' })), 'out'),
      c('location-drive-root', f('InstallLocation a drive root'), text(minimal({ InstallLocation: 'D:/' })), 'out'),
      c('location-bare-drive', f('InstallLocation a bare drive letter'), text(minimal({ InstallLocation: 'D:' })), 'out'),
      c(
        'location-unc',
        f('InstallLocation a UNC path: the doubled leading backslash is made single'),
        text(minimal({ InstallLocation: '\\\\server\\share\\Sugar' })),
        'out',
      ),
      c('location-escaped-backslashes', f('InstallLocation with doubled backslashes'), text(minimal({ InstallLocation: 'D:\\\\Games\\\\Sugar' })), 'out'),
      c('location-relative', f('InstallLocation relative'), text(minimal({ InstallLocation: 'Games/Sugar' })), 'out'),
      c('location-dotdot', f('InstallLocation with ..'), text(minimal({ InstallLocation: 'D:/Games/Other/../Sugar' })), 'out'),
      c('size-zero', f('InstallSize 0'), text(minimal({ InstallSize: 0 })), 'out'),
      c('size-negative', f('InstallSize negative'), text(minimal({ InstallSize: -1 })), 'out'),
      c('size-float', f('InstallSize a fraction'), text(minimal({ InstallSize: 1.5 })), 'out'),
      c('size-string', f('InstallSize a string'), text(minimal({ InstallSize: '123' })), 'out'),
      c('incomplete-string', f('bIsIncompleteInstall the string "true"'), text(minimal({ bIsIncompleteInstall: 'true' })), 'out'),
      c('incomplete-one', f('bIsIncompleteInstall 1'), text(minimal({ bIsIncompleteInstall: 1 })), 'out'),
      c('categories-mixed', f('AppCategories holding non-strings'), text(minimal({ AppCategories: ['games', 1, null, 'x', ['y'], { z: 1 }] })), 'out'),
      c('categories-string', f('AppCategories a string'), text(minimal({ AppCategories: 'games' })), 'out'),
      c('categories-untrimmed', f('AppCategories strings are not trimmed'), text(minimal({ AppCategories: [' games ', ''] })), 'out'),
      c('main-game-blank', f('MainGameAppName blank'), text(minimal({ MainGameAppName: ' ' })), 'out'),
      c('appname-uri-chars', f('AppName holding URI-reserved characters'), text(minimal({ AppName: 'a b/c?d#e&f%g' })), 'out'),
      c(
        'every-field',
        f('every string field set'),
        text(editItem((o) => Object.assign(o, { InstallationGuid: ' A1 ', CatalogNamespace: ' ns ', CatalogItemId: ' item ' }))),
        'out',
      ),
      c(
        'adv-trim-feff',
        adversarial('unicode-space', 'AppName wrapped in U+FEFF: JS trim() removes it; Rust str::trim does not'),
        text(minimal({ AppName: '\u{FEFF}Sugar\u{FEFF}' })),
        'out',
      ),
      c(
        'adv-trim-feff-only',
        adversarial('unicode-space', 'AppName only U+FEFF: JS trim() empties it, so there is no AppName; Rust str::trim keeps it'),
        text(minimal({ AppName: '\u{FEFF}' })),
        'error',
      ),
      c(
        'adv-trim-nel',
        adversarial('unicode-space', 'AppName wrapped in U+0085: JS trim() keeps it; Rust str::trim removes it'),
        text(minimal({ AppName: '\u{85}Sugar\u{85}' })),
        'out',
      ),
      c(
        'adv-trim-unicode-spaces',
        adversarial('unicode-space', 'AppName wrapped in U+00A0, U+2007, U+3000 and U+2028: both trims remove them'),
        text(minimal({ AppName: '\u{A0}\u{2007}Sugar\u{3000}\u{2028}' })),
        'out',
      ),
      c(
        'adv-trim-zwsp',
        adversarial('unicode-space', 'AppName wrapped in U+200B and U+180E: neither trim removes them'),
        text(minimal({ AppName: '\u{200B}Sugar\u{180E}' })),
        'out',
      ),
      c(
        'adv-path-trim-feff',
        adversarial('unicode-space', 'InstallLocation ending in U+FEFF: str() trims it in JS before the path is normalised'),
        text(minimal({ InstallLocation: 'D:\\Games\\Sugar\u{FEFF}' })),
        'out',
      ),
      c(
        'adv-duplicate-keys',
        adversarial('json', 'AppName twice: JSON.parse keeps the last'),
        text('{"AppName":"First","AppName":"Second","InstallLocation":"D:\\\\x"}'),
        'out',
      ),
      c(
        'adv-proto-key',
        adversarial('json', 'a __proto__ key holding AppName: an own property of the parsed object, never its prototype, so AppName is not seen'),
        text('{"__proto__":{"AppName":"Sugar"},"InstallLocation":"D:\\\\x"}'),
        'error',
      ),
      c(
        'adv-size-max-safe',
        adversarial('json', 'InstallSize 2^53 + 1 parses to the double 2^53'),
        text('{"AppName":"Sugar","InstallLocation":"D:\\\\x","InstallSize":9007199254740993}'),
        'out',
      ),
      c(
        'adv-size-huge',
        adversarial('json', 'InstallSize 1e400 parses to Infinity and is dropped as not finite; serde_json refuses the number'),
        text('{"AppName":"Sugar","InstallLocation":"D:\\\\x","InstallSize":1e400}'),
        'out',
      ),
      c(
        'adv-size-negative-zero',
        adversarial('number', 'InstallSize -0 passes v >= 0 and is kept as -0'),
        text('{"AppName":"Sugar","InstallLocation":"D:\\\\x","InstallSize":-0}'),
        'out',
      ),
      c(
        'adv-size-exponent',
        adversarial('json', 'InstallSize written 4.2e10 is the integer 42000000000'),
        text('{"AppName":"Sugar","InstallLocation":"D:\\\\x","InstallSize":4.2e10}'),
        'out',
      ),
      c(
        'adv-lone-surrogate',
        adversarial('lone-surrogate', 'DisplayName holding the escape \\ud800: JSON.parse gives a lone surrogate; serde_json refuses the escape'),
        text('{"AppName":"Sugar","InstallLocation":"D:\\\\x","DisplayName":"Rocket \\ud800 League"}'),
        'out',
      ),
      c(
        'adv-invalid-utf8',
        adversarial('utf8-decode', 'an invalid byte in DisplayName of the fixture becomes U+FFFD before JSON.parse'),
        bytes(Buffer.from(bundleBytes(ITEM).toString('latin1').replace('"Rocket League', '"Rocket \u{FF}League'), 'latin1')),
        'out',
      ),
      c(
        'adv-depth-200',
        adversarial('json', 'an ignored field nested 200 arrays deep: JSON.parse accepts it; serde_json stops at 128 by default'),
        text(minimal({ Deep: JSON.parse(`${'['.repeat(200)}${']'.repeat(200)}`) })),
        'out',
      ),
      c('adv-nbsp-before', adversarial('unicode-space', 'U+00A0 before the object is not JSON whitespace'), text(`\u{A0}${minimal({})}`), 'error'),
    ];
  },
});

vectorFile({
  area: 'epic',
  function: 'parseLauncherInstalled',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    READ_NOTE,
    PATH_NOTE,
    JSON_NOTE,
    'An entry needs AppName (or, when that is missing or blank, ArtifactId) and InstallLocation; any other entry is skipped without an error.',
    CAP_NOTE,
    'gap: src/main/launchers/epic/manifests.ts:102:114 ?: false arm, JSON.parse only ever throws a SyntaxError (an Error), so String(err) is never reached.',
    'not measured: src/main/launchers/epic/manifests.ts:104:49 ?: true arm (no source mapping); the cases with an object, an array, a string and null reach both arms.',
  ].join('\n'),
  call: parseLauncherInstalled,
  cases: () => {
    const c = (id: string, origin: Case['origin'], arg: unknown, expect: 'out' | 'error'): Case => ({ id, origin, args: [arg], expect });
    const f = (change: string) => fixture(DAT, change);
    const list = (items: unknown[]): string => JSON.stringify({ InstallationList: items });
    const entry = (fields: Record<string, unknown>) => ({ InstallLocation: 'D:\\Games\\Sugar', AppName: 'Sugar', ...fields });
    return [
      c('test-fixture', fromTest(TESTS, ...T_DAT), file(DAT), 'out'),
      c('test-empty-object', fromTest(TESTS, ...T_DAT), text('{}'), 'error'),
      c('bom', f('UTF-8 BOM added'), bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bundleBytes(DAT)])), 'out'),
      c('double-bom', f('two UTF-8 BOMs'), bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), bundleBytes(DAT)])), 'error'),
      c('not-json', f('not JSON'), text('not json'), 'error'),
      c('empty', f('an empty file'), text(''), 'error'),
      c('truncated', f('cut in half'), text(datText().slice(0, 100)), 'error'),
      c('json-null', f('the JSON null'), text('null'), 'error'),
      c('json-array', f('a JSON array'), text('[]'), 'error'),
      c('json-string', f('a JSON string'), text('"InstallationList"'), 'error'),
      c('json-number', f('a JSON number'), text('1'), 'error'),
      c('list-object', f('InstallationList an object'), text('{"InstallationList":{}}'), 'error'),
      c('list-null', f('InstallationList null'), text('{"InstallationList":null}'), 'error'),
      c('list-empty', f('InstallationList empty'), text('{"InstallationList":[]}'), 'out'),
      c('items-not-objects', f('entries that are not objects are skipped'), text(list([null, 1, 'x', true, false, [], [entry({})]])), 'out'),
      c('artifact-fallback', f('no AppName: ArtifactId is used'), text(list([{ InstallLocation: 'D:\\x', ArtifactId: 'Art' }])), 'out'),
      c('artifact-fallback-blank', f('blank AppName: ArtifactId is used'), text(list([entry({ AppName: ' ', ArtifactId: 'Art' })])), 'out'),
      c('no-names', f('neither AppName nor ArtifactId: skipped'), text(list([{ InstallLocation: 'D:\\x' }])), 'out'),
      c('no-location', f('no InstallLocation: skipped'), text(list([{ AppName: 'Sugar' }])), 'out'),
      c('blank-location', f('blank InstallLocation: skipped'), text(list([entry({ InstallLocation: '  ' })])), 'out'),
      c('location-number', f('InstallLocation a number: skipped'), text(list([entry({ InstallLocation: 5 })])), 'out'),
      c('ids-missing', f('no NamespaceId or ItemId'), text(list([entry({})])), 'out'),
      c('ids-blank', f('blank NamespaceId and ItemId'), text(list([entry({ NamespaceId: ' ', ItemId: '' })])), 'out'),
      c('ids-trimmed', f('ids and names with spaces around them'), text(list([entry({ AppName: ' Sugar ', NamespaceId: ' ns ', ItemId: '\tid\n' })])), 'out'),
      c('duplicates-kept', f('the same entry twice is listed twice'), text(list([entry({}), entry({})])), 'out'),
      c('order-kept', f('three entries keep their order'), text(list([entry({ AppName: 'C' }), entry({ AppName: 'A' }), entry({ AppName: 'B' })])), 'out'),
      c(
        'paths',
        f('entries with paths to normalise'),
        text(
          list([
            entry({ InstallLocation: 'D:/Games//Sugar/' }),
            entry({ AppName: 'U', InstallLocation: '\\\\server\\share' }),
            entry({ AppName: 'R', InstallLocation: 'C:/' }),
          ]),
        ),
        'out',
      ),
      c('crlf', f('LF made CRLF'), text(datText().replace(/\n/g, '\r\n')), 'out'),
      c(
        'adv-trim-feff',
        adversarial('unicode-space', 'AppName only U+FEFF: JS trim() empties it, so ArtifactId is used; Rust str::trim keeps it'),
        text(list([entry({ AppName: '\u{FEFF}', ArtifactId: 'Art' })])),
        'out',
      ),
      c(
        'adv-trim-nel',
        adversarial('unicode-space', 'AppName only U+0085: JS trim() keeps it, so it is the name; Rust str::trim empties it'),
        text(list([entry({ AppName: '\u{85}', ArtifactId: 'Art' })])),
        'out',
      ),
      c(
        'adv-duplicate-list',
        adversarial('json', 'InstallationList twice: the last wins'),
        text('{"InstallationList":[{"AppName":"A","InstallLocation":"D:\\\\a"}],"InstallationList":[]}'),
        'out',
      ),
      c(
        'adv-proto-list',
        adversarial('json', 'InstallationList under __proto__ is an own property of that key and is not seen'),
        text('{"__proto__":{"InstallationList":[]}}'),
        'error',
      ),
      c(
        'adv-lone-surrogate',
        adversarial('lone-surrogate', 'AppName holding the escape \\udc00: JSON.parse gives a lone surrogate'),
        text('{"InstallationList":[{"AppName":"a\\udc00","InstallLocation":"D:\\\\a"}]}'),
        'out',
      ),
    ];
  },
});

vectorFile({
  area: 'epic',
  function: 'launchUri',
  source: SOURCE,
  note: [
    'arg0 is the manifest fields the function reads ({ appName, catalogNamespace, catalogItemId }, or the whole parsed fixture manifest), arg1 the form: catalog or appname (any other string takes the appname branch).',
    'The app name goes through encodeURIComponent: every byte of its UTF-8 encoding is %XX-escaped (upper-case hex) except A-Z a-z 0-9 - _ . ! ~ * \' ( ); a lone surrogate throws URIError "URI malformed". The catalog ids are put in raw, never escaped; an empty catalog id falls back to the appname form.',
  ].join('\n'),
  call: launchUri,
  cases: () => {
    const c = (id: string, origin: Case['origin'], m: unknown, form: string, expect: 'out' | 'error' = 'out'): Case => ({
      id,
      origin,
      args: [m, form],
      expect,
    });
    const parsed = parseItemManifest(itemText());
    const m = (appName: string, catalogNamespace: string | null = 'ns', catalogItemId: string | null = 'item') => ({
      appName,
      catalogNamespace,
      catalogItemId,
    });
    const f = (change: string) => fixture(ITEM, change);
    let printable = '';
    for (let code = 0x20; code < 0x7f; code += 1) printable += String.fromCharCode(code);
    return [
      c('test-catalog', fromTest(TESTS, ...T_URI), parsed, 'catalog'),
      c('test-appname', fromTest(TESTS, ...T_URI), parsed, 'appname'),
      c('test-no-catalog-ids', fromTest(TESTS, ...T_URI), m('Sugar', null, null), 'catalog'),
      c('only-namespace', f('catalog form with only the namespace'), m('Sugar', 'ns', null), 'catalog'),
      c('only-item', f('catalog form with only the item id'), m('Sugar', null, 'item'), 'catalog'),
      c('empty-ids', f('catalog form with empty ids'), m('Sugar', '', ''), 'catalog'),
      c('appname-form-with-ids', f('appname form ignores the catalog ids'), m('Sugar'), 'appname'),
      c('other-form', f('a form that is neither'), m('Sugar'), 'Catalog'),
      c('empty-appname', f('an empty app name'), m(''), 'appname'),
      c('empty-appname-catalog', f('an empty app name, catalog form'), m(''), 'catalog'),
      c('reserved-chars', f('an app name with URI-reserved characters'), m('a b/c?d#e&f=g%h:i@j+k,l;m'), 'catalog'),
      c('reserved-chars-appname', f('an app name with URI-reserved characters, appname form'), m('a b/c?d#e&f=g%h:i@j+k,l;m'), 'appname'),
      c('unreserved-chars', f('every character encodeURIComponent leaves alone'), m("AZaz09-_.!~*'()"), 'appname'),
      c('printable-ascii', f('every printable ASCII character'), m(printable), 'appname'),
      c('control-chars', f('control characters'), m('a\u{0}b\tc\nd\u{7F}'), 'appname'),
      c('ids-not-escaped', f('catalog ids holding reserved characters go in raw'), m('Sugar', 'n s?x', 'i#d&y'), 'catalog'),
      c('fixture-dlc-name', f('a DLC app name with a colon'), m('Sugar:DLC'), 'catalog'),
      c(
        'adv-non-ascii',
        adversarial('utf8-decode', 'non-ASCII app name: escaped as its UTF-8 bytes, upper-case hex'),
        m('R\u{E9}sum\u{E9} \u{4E2D}'),
        'appname',
      ),
      c('adv-astral', adversarial('utf8-decode', 'an astral character is one 4-byte UTF-8 sequence, %F0%9F%98%80'), m('a\u{1F600}b'), 'catalog'),
      c(
        'adv-lone-high-surrogate',
        adversarial('lone-surrogate', 'a lone high surrogate makes encodeURIComponent throw URIError'),
        m('a\uD800b'),
        'appname',
        'error',
      ),
      c(
        'adv-lone-low-surrogate',
        adversarial('lone-surrogate', 'a lone low surrogate in the catalog form makes encodeURIComponent throw URIError'),
        m('\uDC00'),
        'catalog',
        'error',
      ),
      c(
        'adv-lone-surrogate-in-ids',
        adversarial('lone-surrogate', 'a lone surrogate in a catalog id is not encoded, so it is returned raw'),
        m('Sugar', '\uD800', 'item'),
        'catalog',
      ),
    ];
  },
});
