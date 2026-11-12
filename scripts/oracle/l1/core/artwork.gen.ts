import { adversarial, bytes, file, fixture, fromTest, listBundle, vectorFile, type Case } from '../lib/index';
import { resolveArtworkPath, sniffImage } from '../../../../src/main/services/artwork-url';

const TESTS = 'test/artwork-url.test.ts';
const DIR = 'D:\\data\\OneLaunch\\artwork';
const ID = '3f2c9b1e-6d4a-4f0b-9c1d-2a7e8b5c4d3f';
const RESOLVES = 'resolves only <uuid>/<kind>.<ext> inside the artwork folder';
const REJECTS = 'rejects traversal, other schemes, other hosts, and anything not on the allowlist';
const ARTWORK = 'fixtures/data-folder/artwork';

const fixtures = listBundle(ARTWORK).sort();

const urlCases: Case[] = [
  ...[
    `onelaunch-art://art/${ID}/grid.jpg?v=1`,
    `onelaunch-art://art/${ID}/hero.webp`,
    `onelaunch-art://art/${ID}/logo.png`,
    `onelaunch-art://art/${ID}/grid.ico?v=2`,
  ].map((url, i) => ({
    id: `resolves-${['grid-jpg-query', 'hero-webp', 'logo-png', 'grid-ico-query'][i]}`,
    origin: fromTest(TESTS, 'artwork urls', RESOLVES),
    args: [url, DIR],
    expect: 'out' as const,
  })),
  ...(
    [
      ['traversal-root', `onelaunch-art://art/../onelaunch.db`],
      ['traversal-up-two', `onelaunch-art://art/${ID}/../../onelaunch.db`],
      ['encoded-slash', `onelaunch-art://art/${ID}/..%2F..%2Fonelaunch.db`],
      ['encoded-dots', `onelaunch-art://art/%2E%2E/%2E%2E/onelaunch.db`],
      ['extra-segment', `onelaunch-art://art/${ID}/grid.jpg/extra`],
      ['bad-extension', `onelaunch-art://art/${ID}/grid.exe`],
      ['double-extension', `onelaunch-art://art/${ID}/grid.jpg.tmp`],
      ['upper-file', `onelaunch-art://art/${ID}/GRID.JPG`],
      ['no-file', `onelaunch-art://art/${ID}`],
      ['not-a-uuid', `onelaunch-art://art/not-a-uuid/grid.jpg`],
      ['drive-path', `onelaunch-art://art/C:/Windows/grid.jpg`],
      ['other-host', `onelaunch-art://other/${ID}/grid.jpg`],
      ['file-scheme', `file:///${ID}/grid.jpg`],
      ['https-scheme', `https://art/${ID}/grid.jpg`],
      ['not-a-url', 'not a url'],
    ] as const
  ).map(([id, url]) => ({ id, origin: fromTest(TESTS, 'artwork urls', REJECTS), args: [url, DIR], expect: 'out' as const })),
  ...fixtures.map((path) => {
    const rel = path.slice(ARTWORK.length + 1);
    return {
      id: `fixture-${rel.replace(/[^a-z0-9.]+/gi, '-').toLowerCase()}`,
      origin: fixture(path, 'its url under the fixture data folder'),
      args: [`onelaunch-art://art/${rel}`, 'C:\\Users\\someone\\AppData\\Roaming\\OneLaunch\\artwork'],
      expect: 'out' as const,
    };
  }),
  {
    id: 'every-kind-and-ext',
    origin: adversarial('other', 'logo.ico and hero.ico are on the allowlist too'),
    args: [`onelaunch-art://art/${ID}/hero.ico`, DIR],
    expect: 'out',
  },
  {
    id: 'scheme-upper',
    origin: adversarial('case-mapping', 'the URL parser lowercases the scheme'),
    args: [`ONELAUNCH-ART://art/${ID}/grid.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'host-upper',
    origin: adversarial('case-mapping', 'a non-special URL keeps an opaque host as written, so ART is not art'),
    args: [`onelaunch-art://ART/${ID}/grid.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'host-percent',
    origin: adversarial('other', 'an opaque host is not percent-decoded: %61rt is not art'),
    args: [`onelaunch-art://%61rt/${ID}/grid.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'credentials-and-port',
    origin: adversarial('other', 'user info and a port do not change the hostname'),
    args: [`onelaunch-art://u:p@art:8080/${ID}/grid.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'dot-segment',
    origin: adversarial('other', 'the URL parser removes "." and ".." segments before the check'),
    args: [`onelaunch-art://art/x/../${ID}/./grid.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'encoded-dot-segment',
    origin: adversarial('other', 'the URL parser treats %2e and %2E%2e as dot segments'),
    args: [`onelaunch-art://art/%2e/x/%2E%2e/${ID}/grid.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'empty-segments',
    origin: adversarial('other', 'empty segments are dropped before counting'),
    args: [`onelaunch-art://art//${ID}//grid.jpg/`, DIR],
    expect: 'out',
  },
  {
    id: 'backslash-separator',
    origin: adversarial('other', 'a backslash is not a separator in a non-special URL'),
    args: [`onelaunch-art://art/${ID}\\grid.jpg`, DIR],
    expect: 'out',
  },
  { id: 'hash', origin: adversarial('other', 'a fragment is ignored'), args: [`onelaunch-art://art/${ID}/grid.jpg#x`, DIR], expect: 'out' },
  {
    id: 'outer-spaces',
    origin: adversarial('unicode-space', 'the URL parser strips leading and trailing C0 controls and spaces'),
    args: [` \t onelaunch-art://art/${ID}/grid.jpg \n`, DIR],
    expect: 'out',
  },
  {
    id: 'inner-tab-newline',
    origin: adversarial('unicode-space', 'the URL parser removes tabs and newlines anywhere'),
    args: [`onelaunch-art://art/${ID}/gr\tid.j\npg`, DIR],
    expect: 'out',
  },
  {
    id: 'nbsp-not-stripped',
    origin: adversarial('unicode-space', 'U+00A0 is not stripped by the URL parser'),
    args: [`\u00a0onelaunch-art://art/${ID}/grid.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'upper-uuid',
    origin: adversarial('case-mapping', 'an upper-case game id is refused (a synthetic id: the bundle scan refuses the upper-case form of the test id)'),
    args: [`onelaunch-art://art/8F3C1A2B-0000-4000-8000-00000000ABCD/grid.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'encoded-file-name',
    origin: adversarial('other', 'a percent-encoded letter in the file name is not decoded'),
    args: [`onelaunch-art://art/${ID}/gr%69d.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'non-ascii-path',
    origin: adversarial('other', 'a non-ASCII file name is percent-encoded by the parser and refused'),
    args: [`onelaunch-art://art/${ID}/grïd.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'opaque-path',
    origin: adversarial('other', 'onelaunch-art:art/... without // has no host'),
    args: [`onelaunch-art:art/${ID}/grid.jpg`, DIR],
    expect: 'out',
  },
  {
    id: 'dir-trailing-separator',
    origin: adversarial('other', 'a trailing separator on the artwork folder is resolved away'),
    args: [`onelaunch-art://art/${ID}/grid.jpg`, `${DIR}\\`],
    expect: 'out',
  },
  {
    id: 'dir-forward-slashes',
    origin: adversarial('other', 'an artwork folder with forward slashes and dot segments'),
    args: [`onelaunch-art://art/${ID}/grid.jpg`, 'D:/data/./OneLaunch/x/../artwork'],
    expect: 'out',
  },
  {
    id: 'dir-drive-root',
    origin: adversarial('other', 'an artwork folder at a drive root never resolves: root + sep is C:\\\\, which the file path does not start with'),
    args: [`onelaunch-art://art/${ID}/grid.jpg`, 'C:\\'],
    expect: 'out',
  },
  {
    id: 'dir-unc',
    origin: adversarial('other', 'an artwork folder on a UNC share'),
    args: [`onelaunch-art://art/${ID}/grid.jpg`, '\\\\server\\share\\artwork'],
    expect: 'out',
  },
  { id: 'empty-url', origin: adversarial('other', 'the empty string is not a URL'), args: ['', DIR], expect: 'out' },
];

vectorFile({
  area: 'core',
  function: 'resolveArtworkPath',
  source: 'src/main/services/artwork-url.ts',
  note: [
    'arg0 is the request URL the onelaunch-art protocol handler receives, arg1 the artwork folder (getAppPaths().artworkDir). URL is the WHATWG parser of Node (as in the Electron main process): onelaunch-art is not a special scheme there, so its host is opaque. path.resolve is win32 on Windows.',
    'Every artwork folder given is absolute: a relative one would be resolved against the working directory, which is not part of a vector.',
  ].join('\n'),
  call: resolveArtworkPath,
  cases: urlCases,
});

const pad = (head: number[], length = head.length + 16) => bytes(Buffer.from([...head, ...new Array(Math.max(0, length - head.length)).fill(0)]));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const riff = (tag: string, length = 16) =>
  bytes(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(tag, 'latin1'), Buffer.alloc(Math.max(0, length - 12))]).subarray(0, length));
const ico = (type: number, count: number) => bytes(Buffer.from([0, 0, type, 0, count, 0, ...new Array(16).fill(0)]));

const sniffCases: Case[] = [
  {
    id: 'jpeg',
    origin: fromTest(TESTS, 'sniffImage', 'recognises jpeg, png, and webp and nothing else'),
    args: [pad([0xff, 0xd8, 0xff, 0xe0])],
    expect: 'out',
  },
  { id: 'png', origin: fromTest(TESTS, 'sniffImage', 'recognises jpeg, png, and webp and nothing else'), args: [pad(PNG)], expect: 'out' },
  {
    id: 'webp',
    origin: fromTest(TESTS, 'sniffImage', 'recognises jpeg, png, and webp and nothing else'),
    args: [bytes(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(4)]))],
    expect: 'out',
  },
  { id: 'gif', origin: fromTest(TESTS, 'sniffImage', 'recognises jpeg, png, and webp and nothing else'), args: [pad([0x47, 0x49, 0x46, 0x38])], expect: 'out' },
  {
    id: 'html',
    origin: fromTest(TESTS, 'sniffImage', 'recognises jpeg, png, and webp and nothing else'),
    args: [bytes(Buffer.from('<!doctype html><html></html>'))],
    expect: 'out',
  },
  {
    id: 'two-bytes',
    origin: fromTest(TESTS, 'sniffImage', 'recognises jpeg, png, and webp and nothing else'),
    args: [bytes(Buffer.from([0xff, 0xd8]))],
    expect: 'out',
  },
  {
    id: 'ico',
    origin: fromTest(TESTS, 'sniffImage', 'tells a Windows icon file by its header, which sniffImage never accepts'),
    args: [ico(1, 1)],
    expect: 'out',
  },
  ...fixtures.map((path) => ({
    id: `fixture-${path
      .slice(ARTWORK.length + 1)
      .replace(/[^a-z0-9.]+/gi, '-')
      .toLowerCase()}`,
    origin: fixture(path),
    args: [file(path)],
    expect: 'out' as const,
  })),
  {
    id: 'cap-length-at-jpeg',
    origin: adversarial('other', 'exactly 12 bytes, the minimum, with a JPEG start'),
    args: [pad([0xff, 0xd8, 0xff], 12)],
    expect: 'out',
  },
  { id: 'cap-length-under-jpeg', origin: adversarial('other', '11 bytes with a JPEG start is refused'), args: [pad([0xff, 0xd8, 0xff], 11)], expect: 'out' },
  { id: 'cap-length-at-png', origin: adversarial('other', '12 bytes with the PNG signature'), args: [pad(PNG, 12)], expect: 'out' },
  { id: 'cap-length-under-png', origin: adversarial('other', '11 bytes with the whole PNG signature is still refused'), args: [pad(PNG, 11)], expect: 'out' },
  { id: 'cap-length-at-webp', origin: adversarial('other', 'exactly RIFF....WEBP, 12 bytes'), args: [riff('WEBP', 12)], expect: 'out' },
  { id: 'cap-length-under-webp', origin: adversarial('other', 'RIFF....WEB, 11 bytes'), args: [riff('WEBP', 11)], expect: 'out' },
  { id: 'empty', origin: adversarial('other', 'no bytes'), args: [bytes(Buffer.alloc(0))], expect: 'out' },
  { id: 'jpeg-third-byte', origin: adversarial('other', 'FF D8 FE: the third JPEG byte wrong'), args: [pad([0xff, 0xd8, 0xfe])], expect: 'out' },
  { id: 'jpeg-second-byte', origin: adversarial('other', 'FF D9 FF: the second JPEG byte wrong'), args: [pad([0xff, 0xd9, 0xff])], expect: 'out' },
  { id: 'jpeg-first-byte', origin: adversarial('other', 'FE D8 FF: the first JPEG byte wrong'), args: [pad([0xfe, 0xd8, 0xff])], expect: 'out' },
  ...PNG.map((_, i) => {
    const head = [...PNG];
    head[i] = head[i]! ^ 0x01;
    return { id: `png-byte-${i}-wrong`, origin: adversarial('other', `the PNG signature with byte ${i} changed`), args: [pad(head)], expect: 'out' as const };
  }),
  {
    id: 'webp-lower-riff',
    origin: adversarial('case-mapping', 'riff in lower case is refused'),
    args: [bytes(Buffer.concat([Buffer.from('riff'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]))],
    expect: 'out',
  },
  { id: 'webp-other-form', origin: adversarial('other', 'RIFF....WAVE is not WebP'), args: [riff('WAVE')], expect: 'out' },
  {
    id: 'webp-tag-at-4',
    origin: adversarial('other', 'WEBP at offset 4 instead of 8'),
    args: [bytes(Buffer.concat([Buffer.from('RIFFWEBP'), Buffer.alloc(8)]))],
    expect: 'out',
  },
  {
    id: 'webp-high-bytes',
    origin: adversarial('other', 'bytes over 0x7F in the RIFF size field are read as char codes and do not matter'),
    args: [bytes(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0xff, 0xfe, 0x80, 0x81]), Buffer.from('WEBP'), Buffer.alloc(4)]))],
    expect: 'out',
  },
  {
    id: 'webp-latin1-lookalike',
    origin: adversarial('utf8-decode', 'a byte 0xC5 is the char code 197, never part of a UTF-8 sequence'),
    args: [bytes(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from([0x57, 0x45, 0x42, 0xc5]), Buffer.alloc(4)]))],
    expect: 'out',
  },
  {
    id: 'jpeg-wins-over-webp',
    origin: adversarial('other', 'the checks run JPEG, PNG, WebP in order'),
    args: [bytes(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x46]), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]))],
    expect: 'out',
  },
  {
    id: 'bom-then-png',
    origin: adversarial('other', 'a UTF-8 BOM before a PNG signature is refused'),
    args: [bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PNG), Buffer.alloc(8)]))],
    expect: 'out',
  },
  {
    id: 'svg',
    origin: adversarial('other', 'an SVG document is not stored'),
    args: [bytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))],
    expect: 'out',
  },
  { id: 'bmp', origin: adversarial('other', 'a BMP header is not stored'), args: [pad([0x42, 0x4d])], expect: 'out' },
  {
    id: 'avif',
    origin: adversarial('other', 'an AVIF ftyp box is not stored'),
    args: [bytes(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(8)]))],
    expect: 'out',
  },
];

vectorFile({
  area: 'core',
  function: 'sniffImage',
  source: 'src/main/services/artwork-url.ts',
  decode: { 0: 'bytes' },
  note: [
    'arg0 is the downloaded or picked image as bytes (src/main/services/artwork.ts passes the Buffer it fetched or read).',
    'The function enforces one limit, a minimum of 12 bytes (cap-length-at-*, cap-length-under-*); the download size cap is artwork.ts, not this function.',
  ].join('\n'),
  call: sniffImage,
  cases: sniffCases,
});
