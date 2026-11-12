import { adversarial, type Case, corpus, file, fixture, fromTest, input, text, vectorFile } from '../lib/index';
import { ADAPTER_TEST, FILES_TEST, fixtureText, GUS, iniBases, placeholderData } from './ini-bases';
import { parseBlob, planSessionWrite, serializeBlob, sessionBlobFromIni, type EpicSessionBlob } from '../../../../src/main/launchers/epic/session';

const SOURCE = 'src/main/launchers/epic/session.ts';
const BASE_PREFIX = 'planSessionWrite';
const bases = iniBases().map((base) => ({ ...base, path: `l1/epic/files/${BASE_PREFIX}/${base.file}` }));
const baseInput = (index: number) => input('epic', `${BASE_PREFIX}/${bases[index]!.file}`, bases[index]!.bytes);
const corpusFrom = [{ path: GUS }, ...bases.map((base) => ({ path: base.path, bytes: base.bytes }))];

const T_BLOBS = ['Epic session blobs', 'reads the remembered session with a fingerprint and never echoes the blob in change descriptions'] as const;
const T_SIGNOUT = ['Epic session blobs', 'signs the launcher out by dropping both Data values while keeping Enable=True'] as const;
const T_STATE = [
  'EpicAdapter.listRememberedAccounts and sessionState',
  'reports what the launcher remembers and whose it is, by fingerprint first and the log second',
] as const;
const T_STRANGER = ['EpicAdapter: a session that no One Launch account owns (B23)'] as const;
const T_CAPTURE = [
  'EpicAdapter.captureSession',
  'stores the current session for its owner, refuses it for another account, and needs a remembered session',
] as const;

const blob = (data: string, offline: string | null, enable = 'True'): EpicSessionBlob => ({
  v: 1,
  rememberMe: { enable, data },
  offline: offline === null ? null : { data: offline },
});
const fixtureBlob = (): EpicSessionBlob => sessionBlobFromIni(fixtureText())!;
const QUJD = 'QUJD'.repeat(40);
const FRESH = Buffer.from(`fresh-blob-1-${'x'.repeat(40)}`).toString('base64');
const STRANGERS = Buffer.from(`blob-of-a-stranger-${'s'.repeat(60)}`).toString('base64');
const DATA_B = Buffer.from(`blob-for-alt-${'b'.repeat(60)}`).toString('base64');
const OFFLINE_B = Buffer.from('offline-for-alt'.repeat(4)).toString('base64');
const ALT_ORIGIN = () => fromTest(ADAPTER_TEST, T_STATE[0], `${T_STATE[1]} | the B account blob of the top-level beforeEach`);
const PH_A = placeholderData('a');
const PH_A_OFFLINE = placeholderData('a-offline', 20);
const PH_B = placeholderData('b', 60);

vectorFile({
  area: 'epic',
  function: 'planSessionWrite',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    'arg0 is GameUserSettings.ini as writeSession in src/main/launchers/epic/adapter.ts reads it (readFileSync utf8: BOM kept, invalid bytes become U+FFFD). arg1 is the stored session blob as parseBlob returns it, or null to sign the launcher out. Every Data value is a placeholder.',
    'The result is { text, changes, noop }. Each change is masked: a Data value matching /^[A-Za-z0-9+/=]{16,}$/ shows as "(<length> characters, fingerprint <first 8 hex of its SHA-256>)", any other Data value of at most 8 UTF-16 units shows as it is, a longer one as "(<length> characters)"; lengths are UTF-16 code units. Other keys show their raw value, a missing before as (absent) and a removal as (removed).',
    'No size cap in the function: the adapter reads the file whole.',
    "gap: src/main/launchers/epic/session.ts:38:50 ?: false arm of the helper shortFingerprint, describe() only passes it a computed fingerprint, never null, so '(none)' is not reachable from planSessionWrite.",
  ].join('\n'),
  call: planSessionWrite,
  cases: () => {
    const g = file(GUS);
    const lit = (value: string) => text(value);
    const c = (id: string, origin: Case['origin'], arg0: unknown, arg1: EpicSessionBlob | null): Case => ({ id, origin, args: [arg0, arg1], expect: 'out' });
    const f = (change: string) => fixture(GUS, change);
    const enableFalse = lit(fixtureText().replace('Enable=True', 'Enable=False'));
    const signedOut = planSessionWrite(fixtureText(), null).text;
    const remember = (data: string) => lit(`[RememberMe]\nEnable=True\nData=${data}\n`);
    return [
      c('test-other-blob-no-offline', fromTest(FILES_TEST, ...T_BLOBS), g, blob(QUJD, null)),
      c('test-sign-out', fromTest(FILES_TEST, ...T_SIGNOUT), g, null),
      c('test-sign-out-enable-false', fromTest(FILES_TEST, ...T_SIGNOUT), enableFalse, null),
      c('test-restore-enable-false', fromTest(FILES_TEST, ...T_SIGNOUT), enableFalse, fixtureBlob()),
      c('test-sign-out-again-noop', fromTest(FILES_TEST, ...T_SIGNOUT), lit(signedOut), null),
      c('test-fresh-blob', fromTest(ADAPTER_TEST, ...T_STATE), g, blob(FRESH, null)),
      c('test-stranger-blob', fromTest(ADAPTER_TEST, ...T_STRANGER), g, blob(STRANGERS, null)),
      c('test-capture-sign-out', fromTest(ADAPTER_TEST, ...T_CAPTURE), g, null),
      c('fixture-own-blob-noop', f('the blob read from the file put back'), g, fixtureBlob()),
      c('fixture-blob-with-offline', f('a placeholder blob with offline data'), g, blob(PH_A, PH_A_OFFLINE)),
      c('fixture-alt-blob', ALT_ORIGIN(), g, blob(DATA_B, OFFLINE_B)),
      c('fixture-lf-blob', fixture(GUS, 'CRLF made LF, a placeholder blob'), baseInput(0), blob(PH_A, PH_A_OFFLINE)),
      c('fixture-bom-blob', fixture(GUS, 'BOM added, a placeholder blob'), baseInput(1), blob(PH_A, null)),
      c('fixture-signed-out-blob', fixture(GUS, 'both Data lines removed, a placeholder blob'), baseInput(2), blob(PH_B, PH_A_OFFLINE)),
      c('fixture-signed-out-sign-out-noop', fixture(GUS, 'both Data lines removed, signed out again'), baseInput(2), null),
      c('fixture-small-sign-out', fixture(GUS, 'only two sections, signed out'), baseInput(3), null),
      c('fixture-small-blob', fixture(GUS, 'only two sections, a placeholder blob'), baseInput(3), blob(PH_B, null)),
      c('fixture-enable-kept-not-blob-enable', f('the blob says Enable=False; the write still puts True'), g, blob(PH_A, null, 'False')),
      c('no-sections-sign-out', f('no [RememberMe] or [Offline]: signing out adds [RememberMe] Enable=True'), lit('[Launcher]\r\nx=1\r\n'), null),
      c('no-sections-blob', f('no [RememberMe] or [Offline]: both are added'), lit('[Launcher]\r\nx=1\r\n'), blob(PH_A, PH_A_OFFLINE)),
      c('empty-text-sign-out', f('an empty file, signed out'), lit(''), null),
      c('empty-text-blob', f('an empty file, a placeholder blob'), lit(''), blob(PH_A, PH_A_OFFLINE)),
      c('enable-lowercase', f('Enable=true in lower case is rewritten to True'), lit('[RememberMe]\nEnable=true\nData=old\n'), null),
      c('data-short-plain', f('a Data value of 3 characters is shown as it is'), remember('abc'), blob(PH_A, null)),
      c('describe-plain-at-8', f('a non-base64 Data value of 8 characters is shown as it is'), remember('a b c d '), blob('e f g h ', null)),
      c('describe-plain-over-8', f('a non-base64 Data value of 9 characters shows its length'), remember('a b c d e'), blob('e f g h i', null)),
      c('describe-base64-at-16', f('a base64 Data value of 16 characters gets a fingerprint'), remember('QUJDREVGR0hJSktM'), blob('TU5PUFFSU1RVVldY', null)),
      c(
        'describe-base64-under-16',
        f('a base64 Data value of 15 characters is not base64 to describe()'),
        remember('QUJDREVGR0hJSktM'.slice(0, 15)),
        blob('TU5PUFFSU1RVVldY'.slice(0, 15), null),
      ),
      c('describe-base64-short', f('a base64 Data value of 8 characters is shown as it is'), remember('QUJDREVG'), blob('R0hJSktM', null)),
      c('describe-empty-before', f('an empty Data value before'), remember(''), blob(PH_A, null)),
      c(
        'adv-astral-length-over',
        adversarial(
          'utf16-length',
          'five astral characters are 10 UTF-16 units, so describe() shows "(10 characters)"; a char count of 5 would show the value',
        ),
        remember('abc'),
        blob('\u{1F600}'.repeat(5), null),
      ),
      c(
        'adv-astral-length-at',
        adversarial('utf16-length', 'four astral characters are 8 UTF-16 units, so describe() shows the value itself'),
        remember('abc'),
        blob('\u{1F600}'.repeat(4), null),
      ),
      c(
        'adv-astral-length-straddle',
        adversarial('utf16-length', 'seven ASCII characters and one astral are 9 UTF-16 units but 8 chars'),
        remember('abc'),
        blob('abcdefg\u{1F600}', null),
      ),
      c(
        'adv-lone-surrogate-data',
        adversarial('lone-surrogate', 'a Data value holding a lone high surrogate: written as it is, and its masked length counts the surrogate as one unit'),
        remember('abc'),
        blob('abcdefgh\uD800', null),
      ),
      c(
        'adv-fingerprint-non-ascii',
        adversarial('utf8-decode', 'a base64-looking Data value is hashed as UTF-8; a fullwidth letter makes it not base64 to describe()'),
        remember('abc'),
        blob(`${'QUJD'.repeat(4)}\u{FF21}`, null),
      ),
      ...corpus({ seed: 5, count: 40, from: corpusFrom, args: (mutated) => [mutated, blob(PH_A, PH_A_OFFLINE)] }),
      ...corpus({ seed: 6, count: 40, from: corpusFrom, args: (mutated) => [mutated, null] }),
      ...corpus({ seed: 7, count: 40, from: corpusFrom, args: (mutated) => [mutated, blob(PH_B, null)] }),
    ];
  },
});

vectorFile({
  area: 'epic',
  function: 'serializeBlob',
  source: SOURCE,
  note: [
    'arg0 is an EpicSessionBlob as a plain value; the function is JSON.stringify of it, so the key order of the recorded argument is the order of the output. Every Data value is a placeholder.',
    'JSON.stringify escapes a lone surrogate as \\uXXXX and leaves U+2028, U+2029 and other non-ASCII characters raw; control characters below U+0020 become \\b \\f \\n \\r \\t or \\u00XX.',
  ].join('\n'),
  call: serializeBlob,
  cases: () => {
    const c = (id: string, origin: Case['origin'], value: unknown): Case => ({ id, origin, args: [value], expect: 'out' });
    return [
      c('test-fixture-blob', fromTest(FILES_TEST, ...T_BLOBS), fixtureBlob()),
      c('test-alt-blob', ALT_ORIGIN(), blob(DATA_B, OFFLINE_B)),
      c('test-other-blob', fromTest(FILES_TEST, ...T_BLOBS), blob(QUJD, null)),
      c('placeholder-no-offline', fixture(GUS, 'a placeholder blob without offline data'), blob(PH_A, null)),
      c('placeholder-enable-false', fixture(GUS, 'a placeholder blob with Enable False'), blob(PH_A, PH_A_OFFLINE, 'False')),
      c('key-order-as-given', fixture(GUS, 'the same blob built offline first'), { offline: null, rememberMe: { data: PH_A, enable: 'True' }, v: 1 }),
      c('escapes', fixture(GUS, 'a Data value holding quotes, backslash, slash and control characters'), blob('a"b\\c/d\b\f\n\r\t\u0001\u001f\u007f', null)),
      c(
        'adv-line-separators',
        adversarial('json', 'U+2028 and U+2029 stay raw in JSON.stringify; serde_json also leaves them raw'),
        blob('a\u{2028}b\u{2029}c', null),
      ),
      c('adv-non-ascii', adversarial('json', 'non-ASCII and astral characters stay raw, never \\u-escaped'), blob('\u{00E9}\u{4E2D}\u{1F600}', null)),
      c(
        'adv-lone-surrogate',
        adversarial('lone-surrogate', 'a lone surrogate is written as the escape \\ud800 (well-formed JSON.stringify); a Rust String cannot hold it'),
        blob('ab\uD800cd', null),
      ),
    ];
  },
});

vectorFile({
  area: 'epic',
  function: 'parseBlob',
  source: SOURCE,
  note: [
    'arg0 is the blob JSON as LauncherSessionStore.decrypt (src/main/services/sessions.ts) hands it to the Epic adapter: a string from the vault, not file bytes, so it is a plain value. Every Data value is a placeholder.',
    'Refusals: JSON.parse errors are recorded with V8\'s SyntaxError message exactly as Node prints it (a Rust port must map its parser errors to these texts or to the same name and message); every shape refusal is Error "Stored Epic session has an unexpected shape".',
    'No size or depth cap in the function. JSON.parse has no nesting limit at these depths; see adv-depth-200 (serde_json stops at 128 by default).',
  ].join('\n'),
  call: parseBlob,
  cases: () => {
    const c = (id: string, origin: Case['origin'], json: unknown, expect: 'out' | 'error'): Case => ({ id, origin, args: [json], expect });
    const f = (change: string) => fixture(GUS, change);
    const rm = `{"enable":"True","data":"${PH_A}"}`;
    const nest = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
    return [
      c('test-round-trip-fixture', fromTest(FILES_TEST, ...T_BLOBS), serializeBlob(fixtureBlob()), 'out'),
      c('test-v2', fromTest(FILES_TEST, ...T_BLOBS), '{"v":2}', 'error'),
      c('round-trip-alt', ALT_ORIGIN(), serializeBlob(blob(DATA_B, OFFLINE_B)), 'out'),
      c('round-trip-no-offline', f('a placeholder blob without offline data'), serializeBlob(blob(PH_A, null)), 'out'),
      c('round-trip-enable-false', f('a placeholder blob with Enable False'), serializeBlob(blob(PH_A, PH_A_OFFLINE, 'False')), 'out'),
      c('enable-missing', f('rememberMe without enable gets True'), `{"v":1,"rememberMe":{"data":"${PH_A}"}}`, 'out'),
      c('enable-not-string', f('enable false (a boolean) gets True'), `{"v":1,"rememberMe":{"enable":false,"data":"${PH_A}"}}`, 'out'),
      c('enable-empty', f('an empty enable string is kept'), `{"v":1,"rememberMe":{"enable":"","data":"${PH_A}"}}`, 'out'),
      c('offline-missing', f('no offline key'), `{"v":1,"rememberMe":${rm}}`, 'out'),
      c('offline-empty-data', f('offline data empty'), `{"v":1,"rememberMe":${rm},"offline":{"data":""}}`, 'out'),
      c('offline-data-number', f('offline data a number'), `{"v":1,"rememberMe":${rm},"offline":{"data":5}}`, 'out'),
      c('offline-string', f('offline a string'), `{"v":1,"rememberMe":${rm},"offline":"x"}`, 'out'),
      c('offline-array', f('offline an array'), `{"v":1,"rememberMe":${rm},"offline":[]}`, 'out'),
      c('offline-false', f('offline false'), `{"v":1,"rememberMe":${rm},"offline":false}`, 'out'),
      c('offline-extra-keys', f('offline with an extra key'), `{"v":1,"rememberMe":${rm},"offline":{"data":"${PH_A_OFFLINE}","x":1}}`, 'out'),
      c(
        'extra-keys-dropped',
        f('unknown keys everywhere'),
        `{"x":0,"v":1,"rememberMe":{"enable":"True","data":"${PH_A}","y":2},"offline":null,"z":[1]}`,
        'out',
      ),
      c('whitespace-around', f('JSON whitespace around the value'), ` \t\r\n{"v":1,"rememberMe":${rm}}\n `, 'out'),
      c('v-float-one', f('v written 1.0'), `{"v":1.0,"rememberMe":${rm}}`, 'out'),
      c('v-exponent-one', f('v written 1e0'), `{"v":1e0,"rememberMe":${rm}}`, 'out'),
      c('v-string', f('v the string "1"'), `{"v":"1","rememberMe":${rm}}`, 'error'),
      c('v-true', f('v true'), `{"v":true,"rememberMe":${rm}}`, 'error'),
      c('v-missing', f('no v'), `{"rememberMe":${rm}}`, 'error'),
      c('v-zero', f('v 0'), `{"v":0,"rememberMe":${rm}}`, 'error'),
      c('remember-missing', f('no rememberMe'), '{"v":1}', 'error'),
      c('remember-null', f('rememberMe null'), '{"v":1,"rememberMe":null}', 'error'),
      c('remember-string', f('rememberMe a string'), '{"v":1,"rememberMe":"abc"}', 'error'),
      c('remember-true', f('rememberMe true'), '{"v":1,"rememberMe":true}', 'error'),
      c('remember-array', f('rememberMe an array'), `{"v":1,"rememberMe":["${PH_A}"]}`, 'error'),
      c('remember-empty-object', f('rememberMe empty'), '{"v":1,"rememberMe":{}}', 'error'),
      c('data-empty', f('rememberMe data empty'), '{"v":1,"rememberMe":{"enable":"True","data":""}}', 'error'),
      c('data-number', f('rememberMe data a number'), '{"v":1,"rememberMe":{"enable":"True","data":12345}}', 'error'),
      c('data-null', f('rememberMe data null'), '{"v":1,"rememberMe":{"enable":"True","data":null}}', 'error'),
      c('json-null', f('the JSON null'), 'null', 'error'),
      c('json-number', f('the JSON 1'), '1', 'error'),
      c('json-string', f('a JSON string'), '"x"', 'error'),
      c('json-true', f('the JSON true'), 'true', 'error'),
      c('json-false', f('the JSON false'), 'false', 'error'),
      c('json-array', f('an empty JSON array'), '[]', 'error'),
      c('json-empty-object', f('an empty JSON object'), '{}', 'error'),
      c('syntax-empty', f('an empty string'), '', 'error'),
      c('syntax-not-json', f('not JSON'), 'not json', 'error'),
      c('syntax-trailing-comma', f('a trailing comma'), `{"v":1,"rememberMe":${rm},}`, 'error'),
      c('syntax-truncated', f('cut short'), `{"v":1,"rememberMe":{"enable":"True","data":"${PH_A}`, 'error'),
      c('syntax-single-quotes', f('single quotes'), "{'v':1}", 'error'),
      c('syntax-trailing-junk', f('a second value after the object'), `{"v":1,"rememberMe":${rm}} x`, 'error'),
      c('syntax-bom', f('a BOM before the object'), `\u{FEFF}{"v":1,"rememberMe":${rm}}`, 'error'),
      c(
        'adv-nbsp-around',
        adversarial('unicode-space', 'U+00A0 before the object is not JSON whitespace: JSON.parse refuses it, as serde_json must'),
        `\u{00A0}{"v":1,"rememberMe":${rm}}`,
        'error',
      ),
      c(
        'adv-duplicate-v',
        adversarial('json', 'duplicate keys: JSON.parse keeps the last, so v 2 then v 1 is accepted'),
        `{"v":2,"v":1,"rememberMe":${rm}}`,
        'out',
      ),
      c(
        'adv-duplicate-data',
        adversarial('json', 'duplicate data keys inside rememberMe: the last one wins'),
        `{"v":1,"rememberMe":{"enable":"True","data":"first-placeholder","data":"${PH_A}"}}`,
        'out',
      ),
      c('adv-duplicate-v-last-bad', adversarial('json', 'duplicate keys: v 1 then v 2 is refused, the last wins'), `{"v":1,"v":2,"rememberMe":${rm}}`, 'error'),
      c(
        'adv-proto-key',
        adversarial('json', 'a __proto__ key from JSON.parse is an own property, never the prototype, so its v and rememberMe are not seen'),
        `{"__proto__":{"v":1,"rememberMe":${rm}}}`,
        'error',
      ),
      c(
        'adv-proto-key-ignored',
        adversarial('json', 'a __proto__ key beside a valid blob is ignored'),
        `{"__proto__":{"v":2},"v":1,"rememberMe":${rm}}`,
        'out',
      ),
      c(
        'adv-v-near-one',
        adversarial('number', 'v 1.0000000000000001 parses to the double 1, so it is accepted; an integer-only check would refuse it'),
        `{"v":1.0000000000000001,"rememberMe":${rm}}`,
        'out',
      ),
      c(
        'adv-v-big-exponent',
        adversarial('json', 'v 1e400 parses to Infinity in JSON.parse and is refused; serde_json refuses the number itself'),
        `{"v":1e400,"rememberMe":${rm}}`,
        'error',
      ),
      c('adv-v-negative-zero', adversarial('number', 'v -0 is not 1'), `{"v":-0,"rememberMe":${rm}}`, 'error'),
      c(
        'adv-lone-surrogate-escape',
        adversarial('lone-surrogate', 'a \\ud800 escape in data: JSON.parse gives a lone surrogate and the blob is accepted; serde_json refuses the escape'),
        '{"v":1,"rememberMe":{"enable":"True","data":"abc\\ud800def"}}',
        'out',
      ),
      c(
        'adv-escaped-astral',
        adversarial('json', 'an escaped surrogate pair \\ud83d\\ude00 decodes to one astral character'),
        '{"v":1,"rememberMe":{"enable":"True","data":"abc\\ud83d\\ude00def"}}',
        'out',
      ),
      c(
        'adv-depth-129',
        adversarial('json', 'an ignored key nested 129 arrays deep: JSON.parse accepts it; serde_json stops at 128 by default'),
        `{"x":${nest(129)},"v":1,"rememberMe":${rm}}`,
        'out',
      ),
      c(
        'adv-depth-200',
        adversarial('json', 'an ignored key nested 200 arrays deep: JSON.parse accepts it'),
        `{"x":${nest(200)},"v":1,"rememberMe":${rm}}`,
        'out',
      ),
      c(
        'adv-depth-5000',
        adversarial('json', 'an ignored key nested 5000 arrays deep: JSON.parse accepts it'),
        `{"x":${nest(5000)},"v":1,"rememberMe":${rm}}`,
        'out',
      ),
      c(
        'adv-big-integer',
        adversarial('json', 'an ignored integer beyond 2^64 is parsed as a double and the blob accepted'),
        `{"x":123456789012345678901234567890,"v":1,"rememberMe":${rm}}`,
        'out',
      ),
      c(
        'adv-control-char',
        adversarial('json', 'a raw tab inside a JSON string is refused by JSON.parse'),
        '{"v":1,"rememberMe":{"enable":"True","data":"a\tb"}}',
        'error',
      ),
    ];
  },
});
