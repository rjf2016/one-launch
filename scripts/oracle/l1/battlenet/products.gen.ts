import { adversarial, bytes, fixture, input, text, vectorFile, type Case, type Origin } from '../lib/index';
import { launchCommand, parseAggregate, parseProductDb, productCodes, PRODUCTS } from '../../../../src/main/launchers/battlenet/products';
import { testOrigin, D_LIMITS, D_PRODUCTS, FILES_TEST, LIMITS_TEST } from './shared';

const SOURCE = 'src/main/launchers/battlenet/products.ts';
const T = testOrigin(FILES_TEST, D_PRODUCTS);
const CODES = 'resolves launch codes from the table and from product.db, and builds both launch forms';
const DB = 'pulls codename, TACT code, and install path triples out of product.db';
const AGG = 'reads aggregate.json';
const LIMIT = 'takes a bounded number of products from product.db, each codename once';
const L = (change?: string): Origin => testOrigin(LIMITS_TEST, D_LIMITS)(LIMIT, change);

vectorFile({
  area: 'battlenet',
  function: 'PRODUCTS',
  source: SOURCE,
  note: 'A constant: call takes no argument and returns the table as it is (plain data, nothing projected). A product without a steamAppId has no such key.',
  call: () => PRODUCTS,
  cases: [{ id: 'table', origin: T(CODES), args: [], expect: 'out' }],
});

vectorFile({
  area: 'battlenet',
  function: 'productCodes',
  source: SOURCE,
  note: [
    'arg0 is a product codename (from the Uninstall --uid), arg1 the TACT code product.db gave for it or null/undefined; in memory.',
    'PRODUCTS is a plain object, so a codename that names an Object.prototype member finds that member: __proto__ returns Object.prototype itself (recorded as {}), and constructor, toString and the like return a function.',
    'call projects a function result to { function: <its name> } because a function cannot be recorded; every other result is recorded as returned.',
  ].join('\n'),
  call: (codename: string, tact?: string | null) => {
    const result = productCodes(codename, tact) as unknown;
    return typeof result === 'function' ? { function: (result as { name: string }).name } : result;
  },
  cases: [
    { id: 'test-prometheus', origin: T(CODES), args: ['prometheus'], expect: 'out' },
    { id: 'test-hs-beta-same-tact', origin: T(CODES), args: ['hs_beta', 'hsb'], expect: 'out' },
    { id: 'test-new-game', origin: T(CODES), args: ['newgame', 'ngm'], expect: 'out' },
    { id: 'test-unknown', origin: T(CODES), args: ['newgame'], expect: 'out' },
    ...Object.keys(PRODUCTS).map((c) => ({
      id: `table-${c.replace(/_/g, '-')}`,
      origin: T(CODES, `every table codename, ${c}`),
      args: [c, null],
      expect: 'out' as const,
    })),
    { id: 'tact-differs', origin: T(CODES, 'product.db names another TACT code for a known product'), args: ['prometheus', 'prot'], expect: 'out' },
    { id: 'tact-empty-known', origin: T(CODES, 'an empty TACT code is ignored'), args: ['prometheus', ''], expect: 'out' },
    { id: 'tact-empty-unknown', origin: T(CODES, 'an unknown product with an empty TACT code'), args: ['newgame', ''], expect: 'out' },
    { id: 'tact-undefined', origin: T(CODES, 'the TACT code left out'), args: ['wow', undefined], expect: 'out' },
    { id: 'case-differs', origin: T(CODES, 'the table is keyed case-sensitively'), args: ['Prometheus', null], expect: 'out' },
    { id: 'tact-upper-program-code', origin: T(CODES, 'the program code is the TACT code upper-cased'), args: ['newgame', 'w3_classic'], expect: 'out' },
    {
      id: 'tact-sharp-s',
      origin: adversarial('case-mapping', 'toUpperCase maps \u00DF to SS, two characters, and \uFB01 to FI'),
      args: ['newgame', 'stra\u00dfe\uFB01'],
      expect: 'out',
    },
    {
      id: 'tact-dotless-i',
      origin: adversarial('case-mapping', 'toUpperCase maps the dotless \u0131 to an ASCII I'),
      args: ['newgame', '\u0131x'],
      expect: 'out',
    },
    {
      id: 'proto',
      origin: adversarial('other', 'the codename __proto__ finds Object.prototype in the table and returns it'),
      args: ['__proto__', null],
      expect: 'out',
    },
    {
      id: 'proto-tact',
      origin: adversarial('other', 'the codename __proto__ with a TACT code: a copy of Object.prototype (no own keys) plus the TACT code'),
      args: ['__proto__', 'x'],
      expect: 'out',
    },
    {
      id: 'constructor',
      origin: adversarial('other', 'the codename constructor finds the Object function in the table'),
      args: ['constructor', null],
      expect: 'out',
    },
    {
      id: 'constructor-tact',
      origin: adversarial('other', 'the codename constructor with a TACT code: a spread of the Object function (no own enumerable keys) plus the TACT code'),
      args: ['constructor', 'x'],
      expect: 'out',
    },
    { id: 'to-string', origin: adversarial('other', 'the codename toString finds Object.prototype.toString'), args: ['toString', null], expect: 'out' },
    { id: 'has-own-property-unknown', origin: adversarial('other', 'hasOwnProperty is found the same way'), args: ['hasOwnProperty', null], expect: 'out' },
  ],
});

const LAUNCH_NOTE = 'arg0 is a ProductCodes (only programCode and tactCode are read), arg1 the form, in memory. The result holds no path.';
vectorFile({
  area: 'battlenet',
  function: 'launchCommand',
  source: SOURCE,
  note: LAUNCH_NOTE,
  call: launchCommand,
  cases: [
    { id: 'test-uri', origin: T(CODES), args: [PRODUCTS['prometheus'], 'uri'], expect: 'out' },
    { id: 'test-exec', origin: T(CODES), args: [PRODUCTS['prometheus'], 'exec'], expect: 'out' },
    ...Object.entries(PRODUCTS).flatMap(([c, codes]) =>
      (['uri', 'exec'] as const).map((form) => ({
        id: `table-${c.replace(/_/g, '-')}-${form}`,
        origin: T(CODES, `every table product, ${c}, ${form}`),
        args: [{ programCode: codes.programCode, tactCode: codes.tactCode }, form],
        expect: 'out' as const,
      })),
    ),
    {
      id: 'learned-codes',
      origin: T(CODES, 'the codes productCodes builds for an unknown product'),
      args: [productCodes('newgame', 'ngm'), 'exec'],
      expect: 'out',
    },
    { id: 'form-unknown', origin: T(CODES, 'any form but exec gives the URI'), args: [PRODUCTS['prometheus'], 'URI'], expect: 'out' },
    { id: 'form-exec-upper', origin: T(CODES, 'EXEC in upper case is not exec'), args: [PRODUCTS['prometheus'], 'EXEC'], expect: 'out' },
    { id: 'form-undefined', origin: T(CODES, 'the form left out'), args: [PRODUCTS['prometheus'], undefined], expect: 'out' },
    {
      id: 'codes-with-spaces',
      origin: T(CODES, 'codes holding spaces, quotes and a slash are copied as they are'),
      args: [{ programCode: 'A "B', tactCode: 'x/y z' }, 'exec'],
      expect: 'out',
    },
    {
      id: 'codes-with-spaces-uri',
      origin: T(CODES, 'the same codes in the URI form, not escaped'),
      args: [{ programCode: 'A "B', tactCode: 'x/y z' }, 'uri'],
      expect: 'out',
    },
    { id: 'codes-empty', origin: T(CODES, 'empty codes'), args: [{ programCode: '', tactCode: '' }, 'exec'], expect: 'out' },
    {
      id: 'codes-lone-surrogate',
      origin: adversarial('lone-surrogate', 'a lone surrogate in the codes is copied into the command'),
      args: [{ programCode: 'P\ud800', tactCode: '\udc00t' }, 'uri'],
      expect: 'out',
    },
    {
      id: 'codes-lone-surrogate-exec',
      origin: adversarial('lone-surrogate', 'a lone surrogate in the program code, exec form'),
      args: [{ programCode: 'P\ud800', tactCode: '\udc00t' }, 'exec'],
      expect: 'out',
    },
  ],
});

const rec = (s: string): Buffer => Buffer.concat([Buffer.from([0x0a, s.length]), Buffer.from(s, 'latin1')]);
const varintRec = (s: string): Buffer => {
  const len: number[] = [];
  let n = s.length;
  while (n >= 0x80) {
    len.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  len.push(n);
  return Buffer.concat([Buffer.from([0x0a, ...len]), Buffer.from(s, 'latin1')]);
};
const triple = (codename: string, tact: string, path: string): Buffer => Buffer.concat([rec(codename), rec(tact), rec(path)]);
const TEST_DB = Buffer.concat([
  rec('agent'),
  rec('agent'),
  rec('C:/ProgramData/Battle.net/Agent'),
  Buffer.from([0x12, 0x03, 0x01, 0x02, 0x03]),
  rec('battle.net'),
  rec('bna'),
  rec('C:/Program Files (x86)/Battle.net'),
  rec('hs_beta'),
  rec('hsb'),
  rec('D:/Games/BattleNet/Hearthstone'),
  rec('prometheus'),
  rec('pro'),
  rec('C:/Users/someone/Games/Overwatch'),
  rec('enUS'),
]);
const nulTriple = (i: number): Buffer => Buffer.from(`prod${i}\0tact\0C:\\Games\\P${i}\0`, 'latin1');
const nulTriples = (n: number, mod = n): Buffer => Buffer.concat(Array.from({ length: n }, (_, i) => nulTriple(i % mod)));
const OW = triple('prometheus', 'pro', 'C:/Users/someone/Games/Overwatch');
const HS = triple('hs_beta', 'hsb', 'D:/Games/BattleNet/Hearthstone');
const DBF = (what: string): Origin => T(DB, what);

vectorFile({
  area: 'battlenet',
  function: 'parseProductDb',
  source: SOURCE,
  decode: { 0: 'bytes' },
  note: [
    'arg0 is product.db as src/main/launchers/battlenet/adapter.ts reads it (readLauncherBytes: the raw bytes).',
    'The function does not decode the protobuf: it takes runs of printable ASCII (0x20 to 0x7E) of two or more bytes and looks for codename, TACT code, path in three consecutive runs. Tags, lengths and varints matter only as separators, or as a printable byte glued to a run.',
    'Install paths go through normalizeLauncherPath (node:path win32 normalize: separators, dot segments, a trailing separator).',
    "Caps: MAX_PRODUCTS (512 entries), the codename pattern (2 to 32 characters) and the TACT pattern (2 to 16), each with an at and an over case. The 4 MiB file cap is readLauncherBytes', not this function's.",
    'The 5000-triple literal of test/parse-limits.test.ts is over the inline limit and is a generated input file.',
  ].join('\n'),
  call: parseProductDb,
  cases: [
    { id: 'test-triples', origin: T(DB), args: [bytes(TEST_DB)], expect: 'out' },
    { id: 'test-nothing', origin: T(DB, 'the second literal'), args: [text('nothing here')], expect: 'out' },
    { id: 'test-limit-5000', origin: L(), args: [input('battlenet', 'parseProductDb/limits-5000-triples.db', nulTriples(5000, 4000))], expect: 'out' },
    { id: 'test-limit-dedupe', origin: L('the second literal'), args: [bytes(Buffer.concat([nulTriple(1), nulTriple(1), nulTriple(2)]))], expect: 'out' },
    { id: 'cap-products-at', origin: L('512 distinct triples'), args: [bytes(nulTriples(512))], expect: 'out' },
    { id: 'cap-products-over', origin: L('513 distinct triples'), args: [bytes(nulTriples(513))], expect: 'out' },
    {
      id: 'cap-products-over-late-duplicates',
      origin: L('512 distinct, then duplicates and one more'),
      args: [bytes(Buffer.concat([nulTriples(512), nulTriple(3), nulTriple(9999)]))],
      expect: 'out',
    },
    { id: 'empty', origin: DBF('an empty file'), args: [bytes(Buffer.alloc(0))], expect: 'out' },
    {
      id: 'cap-codename-at',
      origin: DBF('a 32-character codename between NUL bytes'),
      args: [bytes(Buffer.from(`${'c'.repeat(32)}\0tact\0C:/x\0`, 'latin1'))],
      expect: 'out',
    },
    { id: 'cap-codename-over', origin: DBF('a 33-character codename'), args: [bytes(Buffer.from(`${'c'.repeat(33)}\0tact\0C:/x\0`, 'latin1'))], expect: 'out' },
    { id: 'cap-tact-at', origin: DBF('a 16-character TACT code'), args: [bytes(Buffer.from(`codename\0${'t'.repeat(16)}\0C:/x\0`, 'latin1'))], expect: 'out' },
    {
      id: 'cap-tact-over',
      origin: DBF('a 17-character TACT code'),
      args: [bytes(Buffer.from(`codename\0${'t'.repeat(17)}\0C:/x\0`, 'latin1'))],
      expect: 'out',
    },
    { id: 'codename-two-chars', origin: DBF('a two-character codename and TACT code, the shortest'), args: [bytes(triple('ab', 'cd', 'C:/x'))], expect: 'out' },
    {
      id: 'codename-one-char',
      origin: DBF('a one-character run is no string, so the next runs shift into place'),
      args: [bytes(Buffer.concat([rec('a'), OW]))],
      expect: 'out',
    },
    {
      id: 'length-byte-glued-codename',
      origin: DBF('a 32-character codename written with a length byte: 0x20 is printable and glues a space to its front'),
      args: [bytes(triple('c'.repeat(32), 'pro', 'C:/x'))],
      expect: 'out',
    },
    {
      id: 'length-byte-glued-codename-31',
      origin: DBF('a 31-character codename: its length byte 0x1F is no printable'),
      args: [bytes(triple('c'.repeat(31), 'pro', 'C:/x'))],
      expect: 'out',
    },
    {
      id: 'length-byte-glued-path',
      origin: DBF('a 68-character path: its length byte is D, glued in front, and the lenient path match skips it'),
      args: [bytes(triple('prometheus', 'pro', `C:/${'p'.repeat(65)}`))],
      expect: 'out',
    },
    {
      id: 'length-byte-glued-tact',
      origin: DBF('a TACT code whose length byte is printable: the glued byte fails the TACT pattern'),
      args: [bytes(Buffer.concat([rec('prometheus'), Buffer.from([0x0a, 0x21]), Buffer.from('p'.repeat(0x21), 'latin1'), rec('C:/x')]))],
      expect: 'out',
    },
    {
      id: 'varint-length',
      origin: DBF('a 200-character path with a two-byte varint length'),
      args: [bytes(Buffer.concat([rec('prometheus'), rec('pro'), varintRec(`C:/${'q'.repeat(197)}`)]))],
      expect: 'out',
    },
    {
      id: 'varint-length-printable-high',
      origin: DBF('a 300-character path: its varint length is AC 02, no printable byte'),
      args: [bytes(Buffer.concat([rec('prometheus'), rec('pro'), varintRec(`C:/${'q'.repeat(297)}`)]))],
      expect: 'out',
    },
    {
      id: 'unknown-field-between',
      origin: DBF('an unknown length-delimited field with printable bytes between codename and TACT code breaks the triple'),
      args: [bytes(Buffer.concat([rec('prometheus'), Buffer.from([0x7a, 0x04]), Buffer.from('abcd'), rec('pro'), rec('C:/x'), HS]))],
      expect: 'out',
    },
    {
      id: 'unknown-field-binary',
      origin: DBF('an unknown field with binary bytes between the strings changes nothing'),
      args: [bytes(Buffer.concat([rec('prometheus'), Buffer.from([0x1a, 0x03, 0x00, 0x01, 0xff]), rec('pro'), rec('C:/x')]))],
      expect: 'out',
    },
    {
      id: 'wrong-wire-varint',
      origin: DBF('a varint field (wire type 0) whose one value byte is printable: a one-byte run, dropped'),
      args: [bytes(Buffer.concat([rec('prometheus'), Buffer.from([0x08, 0x2a]), rec('pro'), rec('C:/x')]))],
      expect: 'out',
    },
    {
      id: 'wrong-wire-fixed64',
      origin: DBF('a fixed64 field (wire type 1) of eight printable bytes between TACT code and path breaks the triple'),
      args: [bytes(Buffer.concat([rec('prometheus'), rec('pro'), Buffer.from([0x09]), Buffer.from('ABCDEFGH'), rec('C:/x')]))],
      expect: 'out',
    },
    {
      id: 'wrong-wire-fixed32-glued',
      origin: DBF('a fixed32 tag 0x0D then four printable bytes glued to the codename'),
      args: [bytes(Buffer.concat([Buffer.from([0x0d]), Buffer.from('wxyz'), Buffer.from('prometheus'), rec('pro'), rec('C:/x')]))],
      expect: 'out',
    },
    {
      id: 'truncated-in-path',
      origin: DBF('the file cut inside the last path: the cut path is taken'),
      args: [bytes(Buffer.concat([HS, OW]).subarray(0, HS.length + OW.length - 10))],
      expect: 'out',
    },
    {
      id: 'truncated-in-tact',
      origin: DBF('the file cut inside the TACT code'),
      args: [bytes(Buffer.concat([HS, rec('prometheus'), rec('pro')]).subarray(0, HS.length + 14))],
      expect: 'out',
    },
    {
      id: 'truncated-in-length',
      origin: DBF('the file cut after a tag and before its length'),
      args: [bytes(Buffer.concat([HS, Buffer.from([0x0a])]))],
      expect: 'out',
    },
    {
      id: 'truncated-varint',
      origin: DBF('a varint length cut after its continuation byte'),
      args: [bytes(Buffer.concat([HS, Buffer.from([0x0a, 0x82])]))],
      expect: 'out',
    },
    {
      id: 'non-ascii-path',
      origin: DBF('a UTF-8 path: the bytes of \u00C9 and \u00E9 end the run, so the path is cut before them'),
      args: [bytes(Buffer.concat([rec('prometheus'), rec('pro'), Buffer.from([0x0a, 0x0d]), Buffer.from('D:/Jeux/\u00c9t\u00e9', 'utf8')]))],
      expect: 'out',
    },
    {
      id: 'del-separator',
      origin: DBF('0x7F ends a run like any control byte'),
      args: [bytes(Buffer.from('prometheus\x7fpro\x7fC:/x\x7f', 'latin1'))],
      expect: 'out',
    },
    {
      id: 'skips-agent-and-client',
      origin: DBF('agent and battle.net triples are skipped'),
      args: [bytes(Buffer.concat([triple('agent', 'agent', 'C:/a'), triple('battle.net', 'bna', 'C:/b'), OW]))],
      expect: 'out',
    },
    {
      id: 'duplicate-codename',
      origin: DBF('the same codename twice: the first wins'),
      args: [bytes(Buffer.concat([OW, triple('prometheus', 'prt', 'E:/Other')]))],
      expect: 'out',
    },
    { id: 'codename-upper', origin: DBF('an upper-case codename fails the pattern'), args: [bytes(triple('Prometheus', 'pro', 'C:/x'))], expect: 'out' },
    { id: 'codename-digit-first', origin: DBF('a codename starting with a digit fails'), args: [bytes(triple('1wow', 'wow', 'C:/x'))], expect: 'out' },
    {
      id: 'codename-dotted',
      origin: DBF('a dot is allowed in a codename, not in a TACT code'),
      args: [bytes(Buffer.concat([triple('wow.ptr', 'wowt', 'C:/x'), triple('wowz', 'wow.t', 'C:/y')]))],
      expect: 'out',
    },
    {
      id: 'path-not-drive',
      origin: DBF('a third run without a drive letter is no path'),
      args: [bytes(triple('prometheus', 'pro', '/usr/games'))],
      expect: 'out',
    },
    {
      id: 'path-drive-inside',
      origin: DBF('a drive letter inside the run: the path starts at the first X:/ or X:\\'),
      args: [bytes(triple('prometheus', 'pro', 'junk C:\\Games\\Overwatch D:/x'))],
      expect: 'out',
    },
    { id: 'path-drive-only', origin: DBF('a drive root with a trailing slash'), args: [bytes(triple('prometheus', 'pro', 'C:/'))], expect: 'out' },
    {
      id: 'path-drive-no-slash',
      origin: DBF('a drive letter without a separator after it is no path'),
      args: [bytes(triple('prometheus', 'pro', 'C:Games'))],
      expect: 'out',
    },
    {
      id: 'path-dots',
      origin: DBF('dot segments, doubled separators and a trailing separator are normalised'),
      args: [bytes(triple('prometheus', 'pro', 'C://Games/./a/../Overwatch//'))],
      expect: 'out',
    },
    {
      id: 'path-up-past-root',
      origin: DBF('more .. segments than the path has'),
      args: [bytes(triple('prometheus', 'pro', 'C:/a/../../../b'))],
      expect: 'out',
    },
    {
      id: 'path-trailing-spaces',
      origin: DBF('spaces after the path are trimmed'),
      args: [bytes(triple('prometheus', 'pro', 'D:/Games/Overwatch   '))],
      expect: 'out',
    },
    {
      id: 'path-escaped-backslashes',
      origin: DBF('doubled backslashes collapse'),
      args: [bytes(triple('prometheus', 'pro', 'D:\\\\Games\\\\Overwatch'))],
      expect: 'out',
    },
    { id: 'path-lower-drive', origin: DBF('a lower-case drive letter is kept'), args: [bytes(triple('prometheus', 'pro', 'd:/games'))], expect: 'out' },
    {
      id: 'sliding-window',
      origin: DBF('the window moves one run at a time: a codename-like run before a real triple'),
      args: [bytes(Buffer.concat([rec('enus'), rec('xx'), OW, rec('enUS'), HS]))],
      expect: 'out',
    },
    { id: 'all-printable', origin: DBF('one long printable run is one string'), args: [text('prometheus pro C:/Games/Overwatch')], expect: 'out' },
  ],
});

const OW_ENTRY = {
  name: 'Overwatch',
  product_id: 'pro',
  launch_uri: 'battlenet://game/pro',
  icon_path: 'C:/Users/someone/Games/Overwatch/Overwatch Launcher.exe',
  last_played_timestamp: 1771729603000,
};
const agg = (installed: unknown): string => JSON.stringify({ installed });
const A = (what: string): Origin => T(AGG, what);

vectorFile({
  area: 'battlenet',
  function: 'parseAggregate',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    'arg0 is aggregate.json as src/main/launchers/battlenet/adapter.ts reads it (readLauncherText: toString utf8; the function strips one leading BOM itself).',
    'Any JSON.parse failure gives []. last_played_timestamp is milliseconds; a value that new Date cannot print (over 8.64e15, or Infinity from 1e400) throws RangeError out of the function, which the adapter catches and shows as a warning.',
    "icon_path goes through normalizeLauncherPath. The 4 MiB file cap is readLauncherText', not this function's.",
    'not measured: src/main/launchers/battlenet/products.ts:155:49 ?: true arm (raw.installed), which the coverage tool cannot map; every case with an object at the top runs it.',
  ].join('\n'),
  call: parseAggregate,
  cases: [
    { id: 'test-aggregate', origin: T(AGG), args: [text(agg([OW_ENTRY, { name: 'Broken' }]))], expect: 'out' },
    { id: 'test-not-json', origin: T(AGG), args: [text('not json')], expect: 'out' },
    {
      id: 'pretty-crlf',
      origin: A('the literal pretty-printed with CRLF'),
      args: [text(JSON.stringify({ installed: [OW_ENTRY] }, null, 4).replace(/\n/g, '\r\n'))],
      expect: 'out',
    },
    {
      id: 'bom',
      origin: A('the literal behind a UTF-8 BOM'),
      args: [bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(agg([OW_ENTRY]))]))],
      expect: 'out',
    },
    {
      id: 'double-bom',
      origin: A('two BOMs: only one is stripped'),
      args: [bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from(agg([OW_ENTRY]))]))],
      expect: 'out',
    },
    {
      id: 'utf16le',
      origin: adversarial('utf8-decode', 'the literal in UTF-16LE with its BOM decodes as UTF-8 to junk, which JSON.parse refuses'),
      args: [bytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(agg([OW_ENTRY]), 'utf16le')]))],
      expect: 'out',
    },
    { id: 'empty', origin: A('an empty file'), args: [text('')], expect: 'out' },
    { id: 'null', origin: A('the JSON null'), args: [text('null')], expect: 'out' },
    { id: 'array', origin: A('a top-level array'), args: [text(JSON.stringify([OW_ENTRY]))], expect: 'out' },
    { id: 'string', origin: A('a top-level string'), args: [text('"installed"')], expect: 'out' },
    { id: 'no-installed', origin: A('an object without installed'), args: [text('{"products":[]}')], expect: 'out' },
    { id: 'installed-object', origin: A('installed is an object'), args: [text('{"installed":{"0":{"product_id":"pro"}}}')], expect: 'out' },
    { id: 'installed-empty', origin: A('installed is empty'), args: [text(agg([]))], expect: 'out' },
    {
      id: 'items-not-objects',
      origin: A('null, numbers, strings, booleans and arrays as items'),
      args: [text(agg([null, 1, 'pro', true, ['pro'], { product_id: 'wow' }]))],
      expect: 'out',
    },
    {
      id: 'product-id-types',
      origin: A('product_id empty, a number, null, missing'),
      args: [text(agg([{ product_id: '' }, { product_id: 7 }, { product_id: null }, {}, { product_id: 'hsb' }]))],
      expect: 'out',
    },
    {
      id: 'name-types',
      origin: A('name missing, a number, an empty string'),
      args: [text(agg([{ product_id: 'a1' }, { product_id: 'a2', name: 5 }, { product_id: 'a3', name: '' }]))],
      expect: 'out',
    },
    {
      id: 'uri-types',
      origin: A('launch_uri a number, null, empty'),
      args: [
        text(
          agg([
            { product_id: 'b1', launch_uri: 1 },
            { product_id: 'b2', launch_uri: null },
            { product_id: 'b3', launch_uri: '' },
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'icon-path-forms',
      origin: A('icon_path with backslashes, doubled separators, dot segments, an empty string and a number'),
      args: [
        text(
          agg([
            { product_id: 'c1', icon_path: 'D:\\Games\\\\Hearthstone\\.\\Hearthstone.exe' },
            { product_id: 'c2', icon_path: 'C:/a/../b/' },
            { product_id: 'c3', icon_path: '' },
            { product_id: 'c4', icon_path: 3 },
            { product_id: 'c5', icon_path: '  E:/x  ' },
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'timestamps',
      origin: adversarial('date', 'last_played_timestamp of 0, negative, a string, a fraction, 1 and the largest time a Date can print'),
      args: [
        text(
          agg([
            { product_id: 'd1', last_played_timestamp: 0 },
            { product_id: 'd2', last_played_timestamp: -5 },
            { product_id: 'd3', last_played_timestamp: '1771729603000' },
            { product_id: 'd4', last_played_timestamp: 1.9 },
            { product_id: 'd5', last_played_timestamp: 1 },
            { product_id: 'd6', last_played_timestamp: 8.64e15 },
            { product_id: 'd7', last_played_timestamp: null },
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'cap-timestamp-at',
      origin: adversarial('date', 'the largest time value a Date holds, 8.64e15 ms, prints with a +275760 year'),
      args: [text(agg([{ product_id: 'e1', last_played_timestamp: 8.64e15 }]))],
      expect: 'out',
    },
    {
      id: 'cap-timestamp-over',
      origin: adversarial('date', 'one millisecond over 8.64e15: new Date gives an invalid date and toISOString throws RangeError'),
      args: [text(agg([{ product_id: 'e1', last_played_timestamp: 8.64e15 + 1 }]))],
      expect: 'error',
    },
    {
      id: 'timestamp-infinity',
      origin: adversarial('json', 'the JSON number 1e400 parses to Infinity, which is over 0 and throws RangeError'),
      args: [text('{"installed":[{"product_id":"e2","last_played_timestamp":1e400}]}')],
      expect: 'error',
    },
    {
      id: 'timestamp-seconds',
      origin: adversarial('date', 'a time in seconds is read as milliseconds: early 1970'),
      args: [text(agg([{ product_id: 'e3', last_played_timestamp: 1771729603 }]))],
      expect: 'out',
    },
    {
      id: 'timestamp-precision',
      origin: adversarial('number', 'a timestamp of 17 significant digits rounds to the nearest double before the Date'),
      args: [text('{"installed":[{"product_id":"e4","last_played_timestamp":1771729603000.9999}]}')],
      expect: 'out',
    },
    {
      id: 'duplicate-keys',
      origin: adversarial('json', 'installed and product_id given twice: JSON.parse keeps the last of each'),
      args: [text('{"installed":[{"product_id":"x"}],"installed":[{"product_id":"a","product_id":"b"}]}')],
      expect: 'out',
    },
    {
      id: 'proto-top',
      origin: adversarial('json', 'installed only under an own __proto__ key: JSON.parse makes __proto__ an ordinary property, so there is no installed'),
      args: [text('{"__proto__":{"installed":[{"product_id":"pro"}]}}')],
      expect: 'out',
    },
    {
      id: 'proto-item',
      origin: adversarial('json', 'product_id only under __proto__ inside an item is not read'),
      args: [text('{"installed":[{"__proto__":{"product_id":"pro"}},{"product_id":"wow","__proto__":1}]}')],
      expect: 'out',
    },
    {
      id: 'lone-surrogate-name',
      origin: adversarial('lone-surrogate', 'a \\ud800 escape in a name is kept as a lone surrogate'),
      args: [text('{"installed":[{"product_id":"f1","name":"Over\\ud800watch"}]}')],
      expect: 'out',
    },
    {
      id: 'invalid-utf8-name',
      origin: adversarial('utf8-decode', 'a lone 0xFF in a name becomes U+FFFD before JSON.parse'),
      args: [bytes(Buffer.from('{"installed":[{"product_id":"f2","name":"Over\xffwatch"}]}', 'latin1'))],
      expect: 'out',
    },
    {
      id: 'non-ascii',
      origin: A('non-ASCII and astral characters in name and path'),
      args: [text(agg([{ product_id: 'f3', name: 'Diablo\u00ae \u{1F600}', icon_path: 'D:/Jeux/\u00c9t\u00e9/x.exe' }]))],
      expect: 'out',
    },
    { id: 'many-items', origin: A('the literal entry repeated 200 times'), args: [text(agg(Array.from({ length: 200 }, () => OW_ENTRY)))], expect: 'out' },
    {
      id: 'nested-deep',
      origin: A('installed nested inside deep arrays elsewhere in the file'),
      args: [text(`{"x":${'['.repeat(500)}${']'.repeat(500)},"installed":[{"product_id":"g1"}]}`)],
      expect: 'out',
    },
  ] satisfies Case[],
});
