import { adversarial, bundleBytes, bytes, corpus, file, fixture, fromTest, input, text, vectorFile, type Case, type MutationName } from '../lib/index';
import { planSignOut, readSession, spliceSessionBlock } from '../../../../src/main/launchers/riot/session';
import { fakeSessionFile } from '../../../../src/main/launchers/sim/riot';

const SIGNED_IN_PATH = 'fixtures/launchers/riot/RiotGamesPrivateSettings.yaml';
const SIGNED_OUT_PATH = 'fixtures/launchers/riot/RiotGamesPrivateSettings-signed-out.yaml';
const SIGNED_IN = bundleBytes(SIGNED_IN_PATH).toString('utf8');
const SIGNED_OUT = bundleBytes(SIGNED_OUT_PATH).toString('utf8');
const SUB = '11111111-1111-4111-8111-111111111111';
const ID_TOKEN = /^ {12}id_token: "([^"]+)"/m.exec(SIGNED_IN)![1]!;

const TESTS = 'test/riot-session.test.ts';
const READER = 'Riot session file reader';
const WRITES = 'Riot session file writes';
const R_READS = 'reads the account id, the Riot ID and the refresh-token fingerprint from the riot-client block';
const R_IDENTITY = 'takes identity from the id token only, never from the leftover riot-login cookies';
const R_SAME = 'reads the same session through CRLF, LF, a BOM and upper-case ids';
const R_SIGNED_OUT = "recognises the client's own signed-out state and nothing else as signed out";
const R_CLOSED = 'fails closed on a file that is not in the shape seen on a real client';
const R_DIRECT = 'reads only the direct scalars of the block: a deeper id_token or one of another block does not count';
const R_FLAGS = 'reports the device-key flag and the write count, and tolerates their absence';
const R_RIOT_ID = 'leaves the Riot ID out when the token has none, and keeps it out of the log when it has one';
const W_SIGN_OUT = 'signs the file out the way the client does: the block becomes null and every other byte stays';
const W_SPLICE = 'splices a block back in at the field indent, keeping the line endings and a BOM, and puts null over a block of any depth';
const LIMITS = [
  'test/parse-limits.test.ts',
  'launcher files of a size or shape no launcher writes (H16)',
  'reads a Riot session file in linear time, whatever one long line or a deep pile of lines holds',
] as const;
const reader = (title: string, change?: string) => fromTest(TESTS, READER, change ? `${title} | ${change}` : title);
const writes = (title: string, change?: string) => fromTest(TESTS, WRITES, change ? `${title} | ${change}` : title);

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');
const token = (payload: unknown, middle?: string): string =>
  `${b64url('{"alg":"RS256","typ":"JWT"}')}.${middle ?? b64url(JSON.stringify(payload))}.sig-placeholder`;
const withLine = (key: string, to: string | null): string => {
  const line = new RegExp(`^ {12}${key}: .*\\r\\n`, 'm');
  if (!line.test(SIGNED_IN)) throw new Error(`no ${key} line in the fixture`);
  return SIGNED_IN.replace(line, to === null ? '' : `            ${key}: ${to}\r\n`);
};
const idTokenLine = (value: string): string => withLine('id_token', `"${value}"`);
const acctToken = (acct: unknown): string => token({ sub: SUB, acct });

const PLACEHOLDER_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** A token the secret scan does not read as a JWT (no eyJ header, a one-letter signature), with a payload the reader decodes. */
const compactToken = (payload: object): string => `placeholder.${b64url(JSON.stringify(payload))}.s`;
const COMPACT_SIGNED_IN = [
  'psl:',
  '    authorization:',
  '        riot-client:',
  '            claims: {}',
  `            id_token: "${compactToken({ sub: PLACEHOLDER_SUB, acct: { game_name: 'Placeholder', tag_line: '0000' } })}"`,
  '            is_dpop_bound: false',
  '            refresh_token: "placeholder-refresh-1"',
  '            refresh_token_write_count: 3',
  '            scopes:',
  '            - "openid"',
  '            - "account"',
  'riot-login:',
  '    persist:',
  '        region: "NA"',
  '        scopes:',
  '        - "openid"',
  'rso-authenticator:',
  '    tdid:',
  '        expiryTime: 1790000000',
  '        name: "tdid"',
  '        value: "placeholder-tdid"',
  '',
].join('\r\n');
const COMPACT_SIGNED_OUT_BOM = `﻿${[
  'psl:',
  '    authorization:',
  '        riot-client: null',
  'riot-login:',
  '    persist:',
  '        region: "NA"',
  'rso-authenticator:',
  '    tdid:',
  '        value: "placeholder-tdid"',
  '',
].join('\n')}`;
const COMPACT_TWO_SPACE = [
  'psl:',
  '  authorization:',
  '    riot-client:',
  `      id_token: "${compactToken({ sub: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB' })}"`,
  '      claims:',
  '        nested: 1',
  '',
  "      refresh_token: 'placeholder-refresh-2-placeholder'",
  '      refresh_token_write_count: 999999999',
  '    other: x',
  'riot-login: null',
  '',
  '',
].join('\n');
const TEST_LF = `﻿psl:\n    authorization:\n        riot-client:\n            id_token: "a"\n            nested:\n                deep: 1\n\n            refresh_token: "b"\nother: 1\n`;

const BASE = (name: string) => `spliceSessionBlock/${name}`;
const BASES = [
  {
    name: 'compact-signed-in.yaml',
    text: COMPACT_SIGNED_IN,
    origin: fixture(SIGNED_IN_PATH, 'cut down to a few lines of each block, with short placeholder tokens (stored as a generated input)'),
  },
  {
    name: 'compact-signed-out-bom.yaml',
    text: COMPACT_SIGNED_OUT_BOM,
    origin: fixture(SIGNED_OUT_PATH, 'cut down, LF line ends and a UTF-8 BOM (stored as a generated input)'),
  },
  {
    name: 'compact-two-space.yaml',
    text: COMPACT_TWO_SPACE,
    origin: fixture(
      SIGNED_IN_PATH,
      'two-space indent, a nested block and a blank line inside riot-client, blank lines at the end (stored as a generated input)',
    ),
  },
  { name: 'test-lf-literal.yaml', text: TEST_LF, origin: writes(W_SPLICE, 'the LF literal with a BOM, stored as a generated input') },
];
const baseInput = (name: string, value: string) => input('riot', BASE(name), Buffer.from(value, 'utf8'));
const SYNTHETIC = BASES.map((base) => ({ path: `l1/riot/files/${BASE(base.name)}`, bytes: Buffer.from(base.text, 'utf8') }));
const SIGNED_IN_SYNTHETIC = SYNTHETIC.filter((_, i) => i !== 3);
const FIXTURES = [{ path: SIGNED_IN_PATH }, { path: SIGNED_OUT_PATH }];
const LINE_OPS: MutationName[] = ['line-duplicate', 'line-delete', 'line-swap', 'eol', 'bom'];
const baseCases = (args: (value: unknown) => unknown[], expectFor: (name: string) => 'out' | 'error'): Case[] =>
  BASES.map((base) => ({
    id: `base-${base.name.replace(/\.yaml$/, '')}`,
    origin: base.origin,
    args: args(baseInput(base.name, base.text)),
    expect: expectFor(base.name),
  }));

const DECODE_NOTE =
  'arg0 is RiotGamesPrivateSettings.yaml as src/main/launchers/riot/adapter.ts reads it (readSessionFile: readLauncherText, readFileSync then toString utf8; a BOM stays as U+FEFF and is handled by the function, invalid bytes become U+FFFD). The adapter also hands it the file text stored in a session blob (sessionOfBlob), which is the same text.';
const SHAPE_NOTE =
  'Lines split on \\r?\\n; a line counts as blank by JS String.prototype.trim (U+FEFF is blank, U+0085 is not); indent counts U+0020 only; KEY_LINE has no u flag, so its `.` stops at a lone CR, U+2028 and U+2029 and such a line is no key.\nCoverage: every block ran; the BOM arm of splitLines (session.ts:149, the U+FEFF literal) is listed as not measured because the transform rewrites the literal, and the bom cases run it.';
const SPLICE_BODY = ['id_token: "x.y.z"', 'refresh_token: "r"', 'scopes:', '- "openid"'];
const CORPUS_NOTE =
  "The corpus (corpus-*): seeds on the generated bases under l1/riot/files/spliceSessionBlock/ take every mutation; seeds on the two fixtures take line mutations, EOL and BOM only, so that every token in an output is the fixture's own placeholder.";

const LIMIT_TOKEN = `${b64url('{"alg":"none"}')}.${b64url('{"sub":"11111111-1111-4111-8111-111111111111"}')}.sig`;
const limitBlock = (refresh: string, extra = ''): string =>
  `psl:\n    authorization:\n        riot-client:\n            id_token: "${LIMIT_TOKEN}"\n            refresh_token: "${refresh}"\n${extra}`;
const big = (name: string, value: string) => input('riot', `readSession/${name}`, Buffer.from(value, 'utf8'));

const payloadOfLength = (base: Record<string, unknown>, mod: number, want: number): string => {
  for (let pad = 0; pad < 8; pad++) {
    const json = `${JSON.stringify(base).slice(0, -1)}${' '.repeat(pad)}}`;
    if (Buffer.byteLength(json) % mod === want) return json;
  }
  throw new Error('no padding found');
};
const extraCharPayload = `${b64url(payloadOfLength({ sub: SUB }, 3, 0))}A`;
const nonCanonicalPayload = (() => {
  const encoded = b64url(payloadOfLength({ sub: SUB }, 3, 1));
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(encoded.at(-1)!);
  return `${encoded.slice(0, -1)}${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[last + 1]}`;
})();

vectorFile({
  area: 'riot',
  function: 'readSession',
  source: 'src/main/launchers/riot/session.ts',
  decode: { 0: 'utf8' },
  note: [
    DECODE_NOTE,
    SHAPE_NOTE,
    'Global state: a session whose token names a Riot ID registers the name with the logger (redactAccountNames, a module-level list); the result does not depend on it.',
    'fingerprint is the SHA-256 hex of the refresh token as the function computes it (fingerprintOf), under the key the app gives it.',
    "The id token's middle part is decoded with Node's lenient base64url (an extra last character and non-zero trailing bits are ignored) and read with JSON.parse; adv-* cases aim at both.",
    "Caps the function enforces: a Riot ID part is at most 64 UTF-16 code units after trim (cap-name-*), and refresh_token_write_count at most nine ASCII digits (cap-write-count-*). The size cap is readLauncherText's (4 MiB); the parse-limits cases (limits-*) are the linear-time test's inputs, stored as generated files.",
    CORPUS_NOTE,
  ].join('\n'),
  call: readSession,
  cases: () => [
    { id: 'fixture-signed-in', origin: reader(R_READS), args: [file(SIGNED_IN_PATH)], expect: 'out' },
    { id: 'fixture-signed-out', origin: reader(R_SIGNED_OUT), args: [file(SIGNED_OUT_PATH)], expect: 'out' },
    ...baseCases(
      (value) => [value],
      () => 'out',
    ),
    {
      id: 'no-dpop-flag-and-times',
      origin: reader(R_IDENTITY),
      args: [text(SIGNED_IN.replace(/^ {12}is_dpop_bound: false\r\n[\s\S]*?(?=^ {12}refresh_token: )/m, ''))],
      expect: 'out',
    },
    { id: 'lf', origin: reader(R_SAME), args: [text(SIGNED_IN.replace(/\r\n/g, '\n'))], expect: 'out' },
    { id: 'bom', origin: reader(R_SAME), args: [text(`﻿${SIGNED_IN}`)], expect: 'out' },
    {
      id: 'upper-case-sub',
      origin: reader(R_SAME),
      args: [text(idTokenLine(token({ sub: SUB.toUpperCase(), acct: { game_name: 'Placeholder', tag_line: '0000' } })))],
      expect: 'out',
    },
    { id: 'tilde', origin: reader(R_SIGNED_OUT), args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: ~'))], expect: 'out' },
    { id: 'quoted-x', origin: reader(R_SIGNED_OUT), args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: "x"'))], expect: 'out' },
    { id: 'empty-block', origin: reader(R_SIGNED_OUT), args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client:'))], expect: 'out' },
    { id: 'quoted-empty', origin: reader(R_SIGNED_OUT), args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: ""'))], expect: 'out' },
    { id: 'empty', origin: reader(R_CLOSED), args: [text('')], expect: 'out' },
    { id: 'no-psl', origin: reader(R_CLOSED), args: [text('riot-login:\n    persist:\n        region: "NA"\n')], expect: 'out' },
    { id: 'psl-null', origin: reader(R_CLOSED), args: [text('psl: null\nriot-login:\n    persist:\n')], expect: 'out' },
    { id: 'no-riot-client', origin: reader(R_CLOSED), args: [text('psl:\n    authorization:\n        other: 1\n')], expect: 'out' },
    { id: 'authorization-inline', origin: reader(R_CLOSED), args: [text('psl:\n    authorization: {}\n')], expect: 'out' },
    { id: 'no-id-token', origin: reader(R_CLOSED), args: [text(withLine('id_token', null))], expect: 'out' },
    { id: 'id-token-empty', origin: reader(R_CLOSED), args: [text(withLine('id_token', '""'))], expect: 'out' },
    { id: 'no-refresh-token', origin: reader(R_CLOSED), args: [text(withLine('refresh_token', null))], expect: 'out' },
    { id: 'id-token-not-a-token', origin: reader(R_CLOSED), args: [text(idTokenLine('not-a-token'))], expect: 'out' },
    { id: 'id-token-two-parts', origin: reader(R_CLOSED), args: [text(idTokenLine('a.b'))], expect: 'out' },
    { id: 'id-token-not-json', origin: reader(R_CLOSED), args: [text(idTokenLine(token(null, b64url('not json'))))], expect: 'out' },
    { id: 'id-token-array', origin: reader(R_CLOSED), args: [text(idTokenLine(token([1, 2])))], expect: 'out' },
    { id: 'id-token-no-sub', origin: reader(R_CLOSED), args: [text(idTokenLine(token({ acct: {} })))], expect: 'out' },
    { id: 'id-token-sub-not-uuid', origin: reader(R_CLOSED), args: [text(idTokenLine(token({ sub: 'someone' })))], expect: 'out' },
    { id: 'id-token-sub-number', origin: reader(R_CLOSED), args: [text(idTokenLine(token({ sub: 12345 })))], expect: 'out' },
    {
      id: 'nested-id-token',
      origin: reader(R_DIRECT),
      args: [text(withLine('id_token', null).replace(/^ {12}claims: \{\}\r\n/m, `            claims:\r\n                id_token: "${ID_TOKEN}"\r\n`))],
      expect: 'out',
    },
    {
      id: 'id-token-elsewhere',
      origin: reader(R_DIRECT),
      args: [text(withLine('id_token', null).replace(/^riot-login:\r\n/m, `riot-login:\r\n    id_token: "${ID_TOKEN}"\r\n`))],
      expect: 'out',
    },
    { id: 'dpop-true', origin: reader(R_FLAGS), args: [text(withLine('is_dpop_bound', 'true'))], expect: 'out' },
    { id: 'dpop-absent', origin: reader(R_FLAGS), args: [text(withLine('is_dpop_bound', null))], expect: 'out' },
    { id: 'dpop-maybe', origin: reader(R_FLAGS), args: [text(withLine('is_dpop_bound', 'maybe'))], expect: 'out' },
    { id: 'write-count-12', origin: reader(R_FLAGS), args: [text(withLine('refresh_token_write_count', '12'))], expect: 'out' },
    { id: 'write-count-absent', origin: reader(R_FLAGS), args: [text(withLine('refresh_token_write_count', null))], expect: 'out' },
    { id: 'write-count-lots', origin: reader(R_FLAGS), args: [text(withLine('refresh_token_write_count', 'lots'))], expect: 'out' },
    { id: 'riot-id-absent', origin: reader(R_RIOT_ID), args: [text(idTokenLine(token({ sub: SUB })))], expect: 'out' },
    { id: 'riot-id-empty-tag', origin: reader(R_RIOT_ID), args: [text(idTokenLine(acctToken({ game_name: 'Only', tag_line: '' })))], expect: 'out' },
    { id: 'cap-name-over', origin: reader(R_RIOT_ID), args: [text(idTokenLine(acctToken({ game_name: 'x'.repeat(65), tag_line: 'NA1' })))], expect: 'out' },
    { id: 'riot-id-spaced', origin: reader(R_RIOT_ID), args: [text(idTokenLine(acctToken({ game_name: ' Spaced Name ', tag_line: 'EUW' })))], expect: 'out' },
    { id: 'limits-empty', origin: fromTest(...LIMITS), args: [text('')], expect: 'out' },
    { id: 'limits-long-refresh', origin: fromTest(...LIMITS), args: [big('limits-long-refresh.yaml', limitBlock('r'.repeat(1_000_000)))], expect: 'out' },
    {
      id: 'limits-long-lines',
      origin: fromTest(...LIMITS),
      args: [big('limits-long-lines.yaml', limitBlock('short', `${' '.repeat(200_000)}\n${'a'.repeat(200_000)}\n${'-'.repeat(200_000)}: x\n`))],
      expect: 'out',
    },
    {
      id: 'limits-many-keys',
      origin: fromTest(...LIMITS),
      args: [big('limits-many-keys.yaml', `${'key: value\n'.repeat(100_000)}${limitBlock('short')}`)],
      expect: 'out',
    },
    {
      id: 'limits-deep-pile',
      origin: fromTest(...LIMITS),
      args: [big('limits-deep-pile.yaml', `psl:\n    authorization:\n        riot-client:\n${'            nested:\n'.repeat(100_000)}`)],
      expect: 'out',
    },
    {
      id: 'sim-session-file',
      origin: fromTest(
        'test/launcher-sim.test.ts',
        'RiotSim',
        'runningAs begins the run with the client running and signed in, and a fresh file for an account the file does not name',
      ),
      args: [text(fakeSessionFile(SUB, 'placeholder-refresh-x'))],
      expect: 'out',
    },
    {
      id: 'null-forms',
      origin: fixture(SIGNED_OUT_PATH, 'riot-client: Null'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: Null'))],
      expect: 'out',
    },
    {
      id: 'null-upper',
      origin: fixture(SIGNED_OUT_PATH, 'riot-client: NULL'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: NULL'))],
      expect: 'out',
    },
    {
      id: 'null-quoted',
      origin: fixture(SIGNED_OUT_PATH, "riot-client: 'null'"),
      args: [text(SIGNED_OUT.replace('riot-client: null', "riot-client: 'null'"))],
      expect: 'out',
    },
    {
      id: 'null-comment',
      origin: fixture(SIGNED_OUT_PATH, 'riot-client: null # signed out'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: null # signed out'))],
      expect: 'out',
    },
    {
      id: 'null-no-space',
      origin: fixture(SIGNED_OUT_PATH, 'riot-client:null, which is no key line at all'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client:null'))],
      expect: 'out',
    },
    {
      id: 'null-tab-and-trailing',
      origin: fixture(SIGNED_OUT_PATH, 'a tab before null and spaces after it'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client:\tnull  '))],
      expect: 'out',
    },
    {
      id: 'inline-map',
      origin: fixture(SIGNED_OUT_PATH, 'riot-client: {}'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: {}'))],
      expect: 'out',
    },
    {
      id: 'trailing-space-key',
      origin: fixture(SIGNED_OUT_PATH, 'spaces after riot-client:, so a block follows and it is empty'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client:   '))],
      expect: 'out',
    },
    {
      id: 'list-only-block',
      origin: fixture(SIGNED_OUT_PATH, 'a riot-client block holding list items only'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client:\r\n            - "openid"\r\n            - x: 1'))],
      expect: 'out',
    },
    {
      id: 'riot-client-misindented',
      origin: fixture(SIGNED_OUT_PATH, 'riot-client deeper than the first key of authorization, so it is passed over'),
      args: [text(SIGNED_OUT.replace('        riot-client: null', '        other: 1\r\n          riot-client: null'))],
      expect: 'out',
    },
    {
      id: 'riot-client-after-shallower',
      origin: fixture(SIGNED_OUT_PATH, 'a key at a shallower but still nested indent before riot-client sets the block indent'),
      args: [text(SIGNED_OUT.replace('        riot-client: null', '      first: 1\r\n        riot-client: null'))],
      expect: 'out',
    },
    {
      id: 'tab-indented',
      origin: fixture(SIGNED_OUT_PATH, 'authorization indented by a tab'),
      args: [text(SIGNED_OUT.replace('    authorization:', '\tauthorization:'))],
      expect: 'out',
    },
    {
      id: 'duplicate-id-token',
      origin: fixture(SIGNED_IN_PATH, 'a second id_token line naming no account, after the first'),
      args: [text(SIGNED_IN.replace(/^( {12}is_dpop_bound: false\r\n)/m, `$1            id_token: "${token({ sub: 'someone' })}"\r\n`))],
      expect: 'out',
    },
    {
      id: 'duplicate-id-token-first-bad',
      origin: fixture(SIGNED_IN_PATH, 'an id_token line naming no account before the real one'),
      args: [text(SIGNED_IN.replace(/^( {12}claims: \{\}\r\n)/m, `$1            id_token: "${token({ sub: 'someone' })}"\r\n`))],
      expect: 'out',
    },
    {
      id: 'single-quoted-tokens',
      origin: fixture(SIGNED_IN_PATH, 'the id token in single quotes'),
      args: [text(withLine('id_token', `'${ID_TOKEN}'`))],
      expect: 'out',
    },
    { id: 'bare-tokens', origin: fixture(SIGNED_IN_PATH, 'the id token unquoted'), args: [text(withLine('id_token', ID_TOKEN))], expect: 'out' },
    { id: 'dpop-quoted', origin: fixture(SIGNED_IN_PATH, 'is_dpop_bound: "true", quoted'), args: [text(withLine('is_dpop_bound', '"true"'))], expect: 'out' },
    { id: 'dpop-capital', origin: fixture(SIGNED_IN_PATH, 'is_dpop_bound: True'), args: [text(withLine('is_dpop_bound', 'True'))], expect: 'out' },
    {
      id: 'write-count-zero',
      origin: fixture(SIGNED_IN_PATH, 'refresh_token_write_count: 0'),
      args: [text(withLine('refresh_token_write_count', '0'))],
      expect: 'out',
    },
    {
      id: 'write-count-leading-zeros',
      origin: fixture(SIGNED_IN_PATH, 'refresh_token_write_count: 007'),
      args: [text(withLine('refresh_token_write_count', '007'))],
      expect: 'out',
    },
    {
      id: 'cap-write-count-at',
      origin: fixture(SIGNED_IN_PATH, 'refresh_token_write_count of nine digits'),
      args: [text(withLine('refresh_token_write_count', '999999999'))],
      expect: 'out',
    },
    {
      id: 'cap-write-count-over',
      origin: fixture(SIGNED_IN_PATH, 'refresh_token_write_count of ten digits'),
      args: [text(withLine('refresh_token_write_count', '1000000000'))],
      expect: 'out',
    },
    {
      id: 'write-count-quoted',
      origin: fixture(SIGNED_IN_PATH, 'refresh_token_write_count: "3", quoted'),
      args: [text(withLine('refresh_token_write_count', '"3"'))],
      expect: 'out',
    },
    {
      id: 'adv-write-count-signs',
      origin: adversarial('parseint', 'refresh_token_write_count of +3: Number would take it, the digit check refuses it'),
      args: [text(withLine('refresh_token_write_count', '+3'))],
      expect: 'out',
    },
    {
      id: 'adv-write-count-exponent',
      origin: adversarial('parseint', 'refresh_token_write_count of 1e3: Number would read 1000, the digit check refuses it'),
      args: [text(withLine('refresh_token_write_count', '1e3'))],
      expect: 'out',
    },
    {
      id: 'adv-write-count-arabic-indic',
      origin: adversarial(
        'unicode-digit',
        'refresh_token_write_count in Arabic-Indic digits: JS \\d refuses them; a Unicode \\d would pass them to Number, which gives NaN',
      ),
      args: [text(withLine('refresh_token_write_count', '١٢'))],
      expect: 'out',
    },
    {
      id: 'cap-name-at',
      origin: fixture(SIGNED_IN_PATH, 'a game name of 64 characters'),
      args: [text(idTokenLine(acctToken({ game_name: 'x'.repeat(64), tag_line: 'NA1' })))],
      expect: 'out',
    },
    {
      id: 'cap-name-trimmed-at',
      origin: fixture(SIGNED_IN_PATH, 'a game name of 64 characters after ten spaces each side: trimmed first'),
      args: [text(idTokenLine(acctToken({ game_name: `${' '.repeat(10)}${'x'.repeat(64)}${' '.repeat(10)}`, tag_line: 'x'.repeat(64) })))],
      expect: 'out',
    },
    {
      id: 'cap-name-astral-at',
      origin: adversarial('utf16-length', 'a game name of 32 astral characters: 64 code units, kept'),
      args: [text(idTokenLine(acctToken({ game_name: '\u{1F600}'.repeat(32), tag_line: 'NA1' })))],
      expect: 'out',
    },
    {
      id: 'cap-name-astral-over',
      origin: adversarial('utf16-length', 'a game name of 63 ASCII and one astral character: 64 chars, 65 code units, refused in JS'),
      args: [text(idTokenLine(acctToken({ game_name: `${'x'.repeat(63)}\u{1F600}`, tag_line: 'NA1' })))],
      expect: 'out',
    },
    {
      id: 'adv-name-trim-bom',
      origin: adversarial('unicode-space', 'a game name wrapped in U+FEFF and U+3000: JS trim removes both; Rust str::trim keeps U+FEFF'),
      args: [text(idTokenLine(acctToken({ game_name: '﻿　Placeholder﻿', tag_line: ' 0000' })))],
      expect: 'out',
    },
    {
      id: 'adv-name-trim-nel',
      origin: adversarial('unicode-space', 'a game name of U+0085 alone and a tag of U+0085 around text: JS trim keeps U+0085; Rust str::trim removes it'),
      args: [text(idTokenLine(acctToken({ game_name: '\u0085', tag_line: '\u00850000\u0085' })))],
      expect: 'out',
    },
    {
      id: 'adv-name-lone-surrogate',
      origin: adversarial(
        'lone-surrogate',
        'a \\ud800 escape in the game name: JSON.parse accepts it and the Riot ID carries a lone surrogate; serde_json refuses the payload',
      ),
      args: [text(idTokenLine(token(null, b64url(`{"sub":"${SUB}","acct":{"game_name":"Pl\\ud800ce","tag_line":"0000"}}`))))],
      expect: 'out',
    },
    {
      id: 'adv-payload-invalid-utf8',
      origin: adversarial('utf8-decode', 'a lone 0xFF byte inside the payload game name: Node decodes the payload to U+FFFD before JSON.parse'),
      args: [
        text(
          idTokenLine(
            token(
              null,
              b64url(
                Buffer.concat([Buffer.from(`{"sub":"${SUB}","acct":{"game_name":"Place`), Buffer.from([0xff]), Buffer.from('holder","tag_line":"0000"}}')]),
              ),
            ),
          ),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'adv-payload-bom',
      origin: adversarial('json', 'a payload that starts with a UTF-8 BOM: JSON.parse refuses U+FEFF, so the token is not readable'),
      args: [text(idTokenLine(token(null, b64url(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`{"sub":"${SUB}"}`)])))))],
      expect: 'out',
    },
    {
      id: 'adv-payload-duplicate-sub',
      origin: adversarial('json', 'the payload names sub twice, someone first: JSON.parse keeps the last'),
      args: [text(idTokenLine(token(null, b64url(`{"sub":"someone","sub":"${SUB}"}`))))],
      expect: 'out',
    },
    {
      id: 'adv-payload-proto-sub',
      origin: adversarial('json', 'a sub only inside __proto__: JSON.parse makes __proto__ an own key, so the payload has no sub'),
      args: [text(idTokenLine(token(null, b64url(`{"__proto__":{"sub":"${SUB}"}}`))))],
      expect: 'out',
    },
    {
      id: 'adv-payload-proto-acct',
      origin: adversarial('json', 'a __proto__ key next to sub and inside acct: an own key that changes nothing'),
      args: [
        text(
          idTokenLine(
            token(null, b64url(`{"sub":"${SUB}","__proto__":null,"acct":{"__proto__":{"game_name":"x"},"game_name":"Placeholder","tag_line":"0000"}}`)),
          ),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'adv-payload-escaped-sub',
      origin: adversarial('json', 'the sub written with \\u0031 escapes and upper-case hex: decoded, then lower-cased'),
      args: [text(idTokenLine(token(null, b64url('{"sub":"\\u0031111111A-1111-4111-8111-11111111111F"}'))))],
      expect: 'out',
    },
    {
      id: 'adv-payload-string',
      origin: adversarial('json', 'a payload that is a JSON string, then null: not an object'),
      args: [text(idTokenLine(token(null, b64url('"x"'))))],
      expect: 'out',
    },
    { id: 'payload-null', origin: fixture(SIGNED_IN_PATH, 'an id token whose payload is null'), args: [text(idTokenLine(token(null)))], expect: 'out' },
    {
      id: 'adv-base64-extra-char',
      origin: adversarial(
        'other',
        'a payload of 4n+1 base64url characters: Node drops the last one and reads the session; a strict base64 decoder refuses the length',
      ),
      args: [text(idTokenLine(`${b64url('{"alg":"RS256","typ":"JWT"}')}.${extraCharPayload}.sig-placeholder`))],
      expect: 'out',
    },
    {
      id: 'adv-base64-trailing-bits',
      origin: adversarial(
        'other',
        'a payload whose last base64url character carries non-zero unused bits: Node ignores them; a strict decoder refuses the non-canonical form',
      ),
      args: [text(idTokenLine(`${b64url('{"alg":"RS256","typ":"JWT"}')}.${nonCanonicalPayload}.sig-placeholder`))],
      expect: 'out',
    },
    {
      id: 'base64-padding',
      origin: fixture(SIGNED_IN_PATH, 'a payload with = padding and one in standard base64 (+ and /): the part pattern refuses both'),
      args: [text(idTokenLine(`${b64url('{"alg":"RS256","typ":"JWT"}')}.${Buffer.from(`{"sub":"${SUB}"}`).toString('base64')}.sig-placeholder`))],
      expect: 'out',
    },
    {
      id: 'id-token-four-parts',
      origin: fixture(SIGNED_IN_PATH, 'an id token of four parts'),
      args: [text(idTokenLine(`${token({ sub: SUB })}.x`))],
      expect: 'out',
    },
    {
      id: 'id-token-empty-part',
      origin: fixture(SIGNED_IN_PATH, 'an id token with an empty signature'),
      args: [text(idTokenLine(token({ sub: SUB }).replace(/sig-placeholder$/, '')))],
      expect: 'out',
    },
    {
      id: 'sub-not-hex',
      origin: fixture(SIGNED_IN_PATH, 'a sub with a g where a hex digit goes'),
      args: [text(idTokenLine(token({ sub: 'g1111111-1111-4111-8111-111111111111' })))],
      expect: 'out',
    },
    { id: 'sub-braced', origin: fixture(SIGNED_IN_PATH, 'a sub in braces'), args: [text(idTokenLine(token({ sub: `{${SUB}}` })))], expect: 'out' },
    {
      id: 'acct-array',
      origin: fixture(SIGNED_IN_PATH, 'acct as an array, and as null'),
      args: [text(idTokenLine(acctToken(['Placeholder', '0000'])))],
      expect: 'out',
    },
    { id: 'acct-null', origin: fixture(SIGNED_IN_PATH, 'acct null'), args: [text(idTokenLine(acctToken(null)))], expect: 'out' },
    {
      id: 'acct-number-name',
      origin: fixture(SIGNED_IN_PATH, 'a game name that is a number'),
      args: [text(idTokenLine(acctToken({ game_name: 1234, tag_line: '0000' })))],
      expect: 'out',
    },
    {
      id: 'adv-blank-line-bom',
      origin: adversarial(
        'unicode-space',
        'a line of U+FEFF alone between psl: and authorization: JS trim makes it blank and the file reads; Rust str::trim keeps it, and at indent 0 it would end the psl block',
      ),
      args: [text(SIGNED_IN.replace('psl:\r\n', 'psl:\r\n﻿\r\n'))],
      expect: 'out',
    },
    {
      id: 'adv-blank-line-nel',
      origin: adversarial(
        'unicode-space',
        'a line of U+0085 alone between psl: and authorization: not blank to JS trim, so at indent 0 it ends the psl block; Rust str::trim makes it blank',
      ),
      args: [text(SIGNED_IN.replace('psl:\r\n', 'psl:\r\n\u0085\r\n'))],
      expect: 'out',
    },
    {
      id: 'adv-blank-line-ideographic',
      origin: adversarial('unicode-space', 'a line of U+3000 and U+00A0 inside the riot-client block: blank to both trims'),
      args: [text(SIGNED_IN.replace('            claims: {}\r\n', '            claims: {}\r\n　 \r\n'))],
      expect: 'out',
    },
    {
      id: 'adv-line-separator-in-value',
      origin: adversarial(
        'regex',
        'U+2028 inside the refresh token: the JS `.` of KEY_LINE stops there, so the line is no key and the block has no refresh_token; a Rust `.` matches it',
      ),
      args: [text(withLine('refresh_token', '"placeholder refresh"'))],
      expect: 'out',
    },
    {
      id: 'adv-lone-cr-in-value',
      origin: adversarial('regex', 'a lone CR inside the refresh token line: one line to the split, no key to the JS `.`'),
      args: [text(withLine('refresh_token', '"placeholder\rrefresh"'))],
      expect: 'out',
    },
    {
      id: 'adv-invalid-utf8-refresh',
      origin: adversarial('utf8-decode', `${SIGNED_IN_PATH} with a lone 0xFF in a placeholder refresh token: the fingerprint is of the U+FFFD text`),
      args: [
        bytes(
          Buffer.concat(
            withLine('refresh_token', '"placeholder-<cut>-1"')
              .split('<cut>')
              .flatMap((part, i) => (i === 0 ? [Buffer.from(part)] : [Buffer.from([0xff]), Buffer.from(part)])),
          ),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'mixed-eol',
      origin: fixture(SIGNED_IN_PATH, 'the psl block in CRLF and the rest in LF'),
      args: [text(SIGNED_IN.slice(0, SIGNED_IN.indexOf('riot-login:')) + SIGNED_IN.slice(SIGNED_IN.indexOf('riot-login:')).replace(/\r\n/g, '\n'))],
      expect: 'out',
    },
    {
      id: 'double-bom',
      origin: fixture(SIGNED_OUT_PATH, 'two BOMs: one is taken off, the second sits before psl'),
      args: [text(`﻿﻿${SIGNED_OUT}`)],
      expect: 'out',
    },
    { id: 'cr-only', origin: fixture(SIGNED_OUT_PATH, 'CRLF made CR: one line'), args: [text(SIGNED_OUT.replace(/\r\n/g, '\r'))], expect: 'out' },
    ...corpus({ seed: 61, count: 70, from: SIGNED_IN_SYNTHETIC, args: (mutated) => [mutated] }),
    ...corpus({ seed: 62, count: 50, from: FIXTURES, ops: LINE_OPS, args: (mutated) => [mutated] }),
  ],
});

vectorFile({
  area: 'riot',
  function: 'spliceSessionBlock',
  source: 'src/main/launchers/riot/session.ts',
  decode: { 0: 'utf8' },
  note: [
    DECODE_NOTE.replace(
      'The adapter also hands it the file text stored in a session blob (sessionOfBlob), which is the same text.',
      'In the app it is called by planSignOut on that text, and by the fake client (sim/riot.ts fakeSessionFile) on its template.',
    ),
    'arg1 is the block body: null for the signed-out state, else the lines to put under riot-client: (each indented four spaces past it). It is not file text.',
    SHAPE_NOTE,
    'The output keeps a leading BOM and every untouched line as it was, but joins all lines with one line end: CRLF when the input holds any CRLF, else LF; so a mixed file comes back all CRLF (mixed-eol).',
    'Errors: "no <path> block" for the first missing key on psl.authorization.riot-client.',
    CORPUS_NOTE,
  ].join('\n'),
  call: spliceSessionBlock,
  cases: () => {
    const spliced = spliceSessionBlock(SIGNED_OUT, SPLICE_BODY);
    return [
      { id: 'body-into-signed-out', origin: writes(W_SPLICE), args: [file(SIGNED_OUT_PATH), SPLICE_BODY], expect: 'out' },
      { id: 'null-over-spliced', origin: writes(W_SPLICE), args: [text(spliced), null], expect: 'out' },
      { id: 'null-over-deep-lf-bom', origin: writes(W_SPLICE), args: [text(TEST_LF), null], expect: 'out' },
      { id: 'no-authorization', origin: writes(W_SPLICE), args: [text('psl:\n    other: 1\n'), null], expect: 'error' },
      {
        id: 'fixture-signed-in-null',
        origin: fromTest(
          'test/riot-adapter.test.ts',
          'Riot hand-over',
          'runs the sign-out path: writes null and nothing else, waits for the sign-in, links the id, stores the file',
        ),
        args: [file(SIGNED_IN_PATH), null],
        expect: 'out',
      },
      {
        id: 'fixture-signed-in-body',
        origin: fixture(SIGNED_IN_PATH, 'the test body spliced over the signed-in block'),
        args: [file(SIGNED_IN_PATH), SPLICE_BODY],
        expect: 'out',
      },
      { id: 'fixture-signed-out-null', origin: fixture(SIGNED_OUT_PATH, 'null over null'), args: [file(SIGNED_OUT_PATH), null], expect: 'out' },
      ...baseCases(
        (value) => [value, null],
        () => 'out',
      ),
      {
        id: 'empty-body',
        origin: fixture(SIGNED_OUT_PATH, 'an empty body: riot-client: with nothing under it'),
        args: [file(SIGNED_OUT_PATH), []],
        expect: 'out',
      },
      {
        id: 'body-blank-and-indented',
        origin: fixture(SIGNED_OUT_PATH, 'a body with an empty line and an already indented line'),
        args: [file(SIGNED_OUT_PATH), ['', '    deep: 1', 'id_token: "x.y.z"']],
        expect: 'out',
      },
      {
        id: 'body-with-line-ends',
        origin: fixture(SIGNED_OUT_PATH, 'a body line holding LF and CRLF, put in as it is'),
        args: [file(SIGNED_OUT_PATH), ['a: 1\nb: 2', 'c: 3\r\nd: 4']],
        expect: 'out',
      },
      { id: 'empty-text', origin: fixture(SIGNED_OUT_PATH, 'emptied'), args: [text(''), null], expect: 'error' },
      { id: 'no-psl', origin: fixture(SIGNED_OUT_PATH, 'psl renamed'), args: [text(SIGNED_OUT.replace('psl:', 'pls:')), null], expect: 'error' },
      {
        id: 'no-riot-client',
        origin: fixture(SIGNED_OUT_PATH, 'riot-client renamed'),
        args: [text(SIGNED_OUT.replace('riot-client:', 'riot-clients:')), null],
        expect: 'error',
      },
      {
        id: 'no-final-newline',
        origin: fixture(SIGNED_OUT_PATH, 'cut after riot-client: null, with no line end'),
        args: [text('psl:\r\n    authorization:\r\n        riot-client: null'), SPLICE_BODY],
        expect: 'out',
      },
      {
        id: 'block-at-end-with-blank-lines',
        origin: fixture(SIGNED_IN_PATH, 'the block last in the file, blank lines inside it and after it'),
        args: [text('psl:\n    authorization:\n        other: 1\n        riot-client:\n            a: 1\n\n            b: 2\n\n   \n'), null],
        expect: 'out',
      },
      {
        id: 'inline-value-with-deeper-lines',
        origin: fixture(SIGNED_OUT_PATH, 'riot-client: null followed by lines deeper than it, which the splice takes as its block'),
        args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: null\r\n            stray: 1\r\n              deeper: 2')), SPLICE_BODY],
        expect: 'out',
      },
      {
        id: 'tab-line-ends-block',
        origin: fixture(SIGNED_IN_PATH, 'a tab-indented line inside the block: its indent is 0, so the block ends there'),
        args: [text(SIGNED_IN.replace('            is_dpop_bound: false\r\n', '\tis_dpop_bound: false\r\n')), null],
        expect: 'out',
      },
      { id: 'lf-fixture', origin: fixture(SIGNED_IN_PATH, 'CRLF made LF'), args: [text(SIGNED_IN.replace(/\r\n/g, '\n')), null], expect: 'out' },
      { id: 'bom-crlf', origin: fixture(SIGNED_IN_PATH, 'UTF-8 BOM added'), args: [text(`﻿${SIGNED_IN}`), SPLICE_BODY], expect: 'out' },
      { id: 'double-bom', origin: fixture(SIGNED_OUT_PATH, 'two BOMs'), args: [text(`﻿﻿${SIGNED_OUT}`), null], expect: 'error' },
      {
        id: 'mixed-eol',
        origin: fixture(SIGNED_IN_PATH, 'the psl block in CRLF and the rest in LF: the output joins every line with CRLF'),
        args: [text(SIGNED_IN.slice(0, SIGNED_IN.indexOf('riot-login:')) + SIGNED_IN.slice(SIGNED_IN.indexOf('riot-login:')).replace(/\r\n/g, '\n')), null],
        expect: 'out',
      },
      {
        id: 'lone-cr-kept',
        origin: fixture(SIGNED_OUT_PATH, 'a lone CR inside a riot-login line stays where it is'),
        args: [text(SIGNED_OUT.replace('region: "NA"', 'region: "N\rA"')), SPLICE_BODY],
        expect: 'out',
      },
      {
        id: 'cr-only',
        origin: fixture(SIGNED_OUT_PATH, 'CRLF made CR: one line, no psl block'),
        args: [text(SIGNED_OUT.replace(/\r\n/g, '\r')), null],
        expect: 'error',
      },
      {
        id: 'adv-blank-line-bom',
        origin: adversarial(
          'unicode-space',
          'a line of U+FEFF alone inside the block and one after it: JS trim makes both blank, so the first is replaced with the block and the second stays; Rust str::trim keeps U+FEFF, and at indent 0 it would end the block early',
        ),
        args: [text(SIGNED_IN.replace('            is_dpop_bound: false\r\n', '﻿\r\n            is_dpop_bound: false\r\n')), null],
        expect: 'out',
      },
      {
        id: 'adv-blank-line-nel',
        origin: adversarial(
          'unicode-space',
          'a line of U+0085 alone inside the block: not blank to JS trim, so at indent 0 it ends the block and the rest of the block stays; Rust str::trim makes it blank',
        ),
        args: [text(SIGNED_IN.replace('            is_dpop_bound: false\r\n', '\u0085\r\n            is_dpop_bound: false\r\n')), null],
        expect: 'out',
      },
      {
        id: 'adv-line-separator-key',
        origin: adversarial('regex', 'U+2028 in the riot-client key line itself: the JS `.` of KEY_LINE refuses the line, so there is no riot-client block'),
        args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: null ')), null],
        expect: 'error',
      },
      {
        id: 'adv-lone-surrogate-body',
        origin: adversarial('lone-surrogate', 'a body line with a lone surrogate: it goes into the output string as it is, which a Rust String cannot hold'),
        args: [file(SIGNED_OUT_PATH), ['id_token: "x\ud800"']],
        expect: 'out',
      },
      {
        id: 'adv-invalid-utf8-elsewhere',
        origin: adversarial('utf8-decode', `${SIGNED_OUT_PATH} with a lone 0xFF in the region: the output carries U+FFFD there, not the byte`),
        args: [bytes(Buffer.from(SIGNED_OUT.replace('region: "NA"', 'region: "NÿA"'), 'latin1')), null],
        expect: 'out',
      },
      {
        id: 'adv-astral-body',
        origin: adversarial('utf16-length', 'an astral character in a body line and in the file'),
        args: [text(SIGNED_OUT.replace('region: "NA"', 'region: "\u{1F600}"')), ['id_token: "\u{1F511}"']],
        expect: 'out',
      },
      ...corpus({ seed: 41, count: 40, from: SYNTHETIC, args: (mutated) => [mutated, null] }),
      ...corpus({ seed: 42, count: 30, from: SYNTHETIC, args: (mutated) => [mutated, SPLICE_BODY] }),
      ...corpus({ seed: 43, count: 30, from: FIXTURES, ops: LINE_OPS, args: (mutated) => [mutated, null] }),
      ...corpus({ seed: 44, count: 20, from: FIXTURES, ops: LINE_OPS, args: (mutated) => [mutated, SPLICE_BODY] }),
    ];
  },
});

vectorFile({
  area: 'riot',
  function: 'planSignOut',
  source: 'src/main/launchers/riot/session.ts',
  decode: { 0: 'utf8' },
  note: [
    DECODE_NOTE.replace(
      ' The adapter also hands it the file text stored in a session blob (sessionOfBlob), which is the same text.',
      ' The caller is runSwitch, on the sign-out path.',
    ),
    SHAPE_NOTE,
    'It is readSession, then spliceSessionBlock(text, null) for a session; a signed-out file comes back as the same string with noop true.',
    'Errors: "<readSession reason>; the file is left alone" for every unexpected file.',
    CORPUS_NOTE,
  ].join('\n'),
  call: planSignOut,
  cases: [
    { id: 'fixture-signed-in', origin: writes(W_SIGN_OUT), args: [file(SIGNED_IN_PATH)], expect: 'out' },
    { id: 'fixture-signed-out', origin: writes(W_SIGN_OUT), args: [file(SIGNED_OUT_PATH)], expect: 'out' },
    { id: 'nothing-here', origin: writes(W_SIGN_OUT), args: [text('nothing: here\n')], expect: 'error' },
    ...baseCases(
      (value) => [value],
      (name) => (name === 'test-lf-literal.yaml' ? 'error' : 'out'),
    ),
    { id: 'empty', origin: fixture(SIGNED_IN_PATH, 'emptied'), args: [text('')], expect: 'error' },
    { id: 'no-id-token', origin: fixture(SIGNED_IN_PATH, 'the id_token line dropped'), args: [text(withLine('id_token', null))], expect: 'error' },
    {
      id: 'no-refresh-token',
      origin: fixture(SIGNED_IN_PATH, 'the refresh_token line dropped'),
      args: [text(withLine('refresh_token', null))],
      expect: 'error',
    },
    { id: 'bad-token', origin: fixture(SIGNED_IN_PATH, 'an id token that is not one'), args: [text(idTokenLine('not-a-token'))], expect: 'error' },
    {
      id: 'no-account-id',
      origin: fixture(SIGNED_IN_PATH, 'an id token naming no account'),
      args: [text(idTokenLine(token({ sub: 'someone' })))],
      expect: 'error',
    },
    {
      id: 'neither',
      origin: fixture(SIGNED_OUT_PATH, 'riot-client: "x"'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: "x"'))],
      expect: 'error',
    },
    {
      id: 'empty-block',
      origin: fixture(SIGNED_OUT_PATH, 'riot-client: with nothing under it'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client:'))],
      expect: 'error',
    },
    {
      id: 'tilde-noop',
      origin: fixture(SIGNED_OUT_PATH, 'riot-client: ~, the same string back'),
      args: [text(SIGNED_OUT.replace('riot-client: null', 'riot-client: ~'))],
      expect: 'out',
    },
    { id: 'lf', origin: fixture(SIGNED_IN_PATH, 'CRLF made LF'), args: [text(SIGNED_IN.replace(/\r\n/g, '\n'))], expect: 'out' },
    { id: 'bom', origin: fixture(SIGNED_IN_PATH, 'UTF-8 BOM added'), args: [text(`﻿${SIGNED_IN}`)], expect: 'out' },
    {
      id: 'mixed-eol',
      origin: fixture(SIGNED_IN_PATH, 'the psl block in CRLF and the rest in LF: the written file is all CRLF'),
      args: [text(SIGNED_IN.slice(0, SIGNED_IN.indexOf('riot-login:')) + SIGNED_IN.slice(SIGNED_IN.indexOf('riot-login:')).replace(/\r\n/g, '\n'))],
      expect: 'out',
    },
    {
      id: 'mixed-eol-noop',
      origin: fixture(SIGNED_OUT_PATH, 'signed out with mixed line ends: noop, and the text comes back untouched'),
      args: [text(SIGNED_OUT.slice(0, SIGNED_OUT.indexOf('riot-login:')) + SIGNED_OUT.slice(SIGNED_OUT.indexOf('riot-login:')).replace(/\r\n/g, '\n'))],
      expect: 'out',
    },
    {
      id: 'sim-session-file',
      origin: fromTest(
        'test/launcher-sim.test.ts',
        'RiotSim',
        'runningAs begins the run with the client running and signed in, and a fresh file for an account the file does not name | signed out',
      ),
      args: [text(fakeSessionFile(SUB, 'placeholder-refresh-x'))],
      expect: 'out',
    },
    {
      id: 'adv-blank-line-nel',
      origin: adversarial(
        'unicode-space',
        'a line of U+0085 alone after psl: in JS it ends the psl block, so the read fails and nothing is written; Rust str::trim would make it blank and sign the file out',
      ),
      args: [text(SIGNED_IN.replace('psl:\r\n', 'psl:\r\n\u0085\r\n'))],
      expect: 'error',
    },
    {
      id: 'adv-blank-line-bom',
      origin: adversarial('unicode-space', 'a line of U+FEFF alone inside the block: blank in JS, so the block is replaced whole'),
      args: [text(SIGNED_IN.replace('            is_dpop_bound: false\r\n', '﻿\r\n            is_dpop_bound: false\r\n'))],
      expect: 'out',
    },
    {
      id: 'adv-base64-extra-char',
      origin: adversarial(
        'other',
        'an id token payload of 4n+1 base64url characters: Node reads it, so the file is signed out; a strict decoder would refuse it and leave the file alone',
      ),
      args: [text(idTokenLine(`${b64url('{"alg":"RS256","typ":"JWT"}')}.${extraCharPayload}.sig-placeholder`))],
      expect: 'out',
    },
    ...corpus({ seed: 51, count: 70, from: SYNTHETIC, args: (mutated) => [mutated] }),
    ...corpus({ seed: 52, count: 50, from: FIXTURES, ops: LINE_OPS, args: (mutated) => [mutated] }),
  ],
});
