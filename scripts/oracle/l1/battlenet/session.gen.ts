import { adversarial, vectorFile, type Origin } from '../lib/index';
import { parseBlob, serializeBlob } from '../../../../src/main/launchers/battlenet/session';
import { testOrigin, D_SESSION, FILES_TEST } from './shared';

const SOURCE = 'src/main/launchers/battlenet/session.ts';
const ROUND = 'keeps REG_BINARY values only, fingerprints them, and round-trips the stored shape';
const T = (what?: string): Origin => testOrigin(FILES_TEST, D_SESSION)(ROUND, what);
const NAME = 'AA11BB22';
const HEX = '01000000d08c9ddf';
const V1 = { v: 1, unifiedAuth: { name: NAME, hex: HEX } } as const;
const V1_JSON = serializeBlob(V1);
const VAULT_LINE =
  'The vault line: sessions.decrypt (DPAPI through Electron safeStorage.decryptString) yields this JSON string and sessions.encrypt takes it; that step is not pure and is not recorded. Everything here is the layout on the clear side of it. Token values are placeholders.';

vectorFile({
  area: 'battlenet',
  function: 'serializeBlob',
  source: SOURCE,
  note: [
    'arg0 is the session blob object, in memory. The output is JSON.stringify of it, keys in the order the object was built.',
    VAULT_LINE,
    'The app writes v1 only (the capture in adapter.ts and src/main/launchers/sim/seed.ts); the v2 cases record that serializeBlob does not check the shape and writes a v2 object as it is.',
  ].join('\n'),
  call: serializeBlob,
  cases: [
    { id: 'v1', origin: T(), args: [V1], expect: 'out' },
    {
      id: 'v2-with-cookies',
      origin: T('the v2 literal as an object'),
      args: [{ v: 2, unifiedAuth: { name: NAME, hex: '01ff' }, cookies: 'abcd' }],
      expect: 'out',
    },
    { id: 'v2-without-cookies', origin: T('a v2 object without its cookie store'), args: [{ v: 2, unifiedAuth: { name: NAME, hex: HEX } }], expect: 'out' },
    { id: 'key-order', origin: T('keys built in another order'), args: [{ unifiedAuth: { hex: HEX, name: NAME }, v: 1 }], expect: 'out' },
    { id: 'upper-hex', origin: T('upper-case hex is written as it is'), args: [{ v: 1, unifiedAuth: { name: NAME, hex: '01000000D08C9DDF' } }], expect: 'out' },
    {
      id: 'undefined-member',
      origin: T('an undefined member is left out'),
      args: [{ v: 1, unifiedAuth: { name: NAME, hex: HEX }, extra: undefined }],
      expect: 'out',
    },
    {
      id: 'name-escapes',
      origin: adversarial(
        'json',
        'a value name with a quote, a backslash, a control character, U+2028 and non-ASCII: JSON.stringify escapes the first three only',
      ),
      args: [{ v: 1, unifiedAuth: { name: 'a"b\\c\u0001d\u2028\u00E9\u{1F600}', hex: HEX } }],
      expect: 'out',
    },
    {
      id: 'name-lone-surrogate',
      origin: adversarial('lone-surrogate', 'a lone surrogate in the value name is written as a lower-case \\ud800 escape'),
      args: [{ v: 1, unifiedAuth: { name: 'x\ud800', hex: HEX } }],
      expect: 'out',
    },
  ],
});

vectorFile({
  area: 'battlenet',
  function: 'parseBlob',
  source: SOURCE,
  note: [
    'arg0 is the stored JSON string, in memory (no decode: it comes from the vault, not a file).',
    VAULT_LINE,
    'Accepts v 1 and v 2 and always returns a v1 blob with the hex lower-cased; drops every other field (the v2 cookie store). The adapter shows the shape error to the user when a switch reads the blob. Invalid JSON throws the SyntaxError of V8 JSON.parse with its own message.',
  ].join('\n'),
  call: parseBlob,
  cases: [
    { id: 'test-v1', origin: T(), args: [V1_JSON], expect: 'out' },
    { id: 'test-v2', origin: T(), args: ['{"v":2,"unifiedAuth":{"name":"AA11BB22","hex":"01FF"},"cookies":"abcd"}'], expect: 'out' },
    { id: 'test-no-unified-auth', origin: T(), args: ['{"v":1}'], expect: 'error' },
    { id: 'test-bad-hex', origin: T(), args: ['{"v":1,"unifiedAuth":{"name":"x","hex":"zz"}}'], expect: 'error' },
    { id: 'pretty', origin: T('the v1 blob pretty-printed with CRLF'), args: [JSON.stringify(V1, null, 2).replace(/\n/g, '\r\n')], expect: 'out' },
    {
      id: 'upper-hex',
      origin: T('upper-case hex is lower-cased'),
      args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"01000000D08C9DDF"}}'],
      expect: 'out',
    },
    {
      id: 'extra-fields',
      origin: T('fields other than v and unifiedAuth are dropped'),
      args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"00","type":"REG_BINARY"},"at":"x"}'],
      expect: 'out',
    },
    { id: 'not-json', origin: T('not JSON'), args: ['not json'], expect: 'error' },
    { id: 'empty', origin: T('an empty string'), args: [''], expect: 'error' },
    { id: 'truncated', origin: T('the v1 blob cut short'), args: [V1_JSON.slice(0, 20)], expect: 'error' },
    { id: 'bom', origin: adversarial('unicode-space', 'a leading U+FEFF is no JSON whitespace'), args: [`\uFEFF${V1_JSON}`], expect: 'error' },
    { id: 'json-null', origin: T('the JSON null'), args: ['null'], expect: 'error' },
    { id: 'json-number', origin: T('a JSON number'), args: ['1'], expect: 'error' },
    { id: 'json-array', origin: T('a JSON array'), args: ['[]'], expect: 'error' },
    { id: 'json-string', origin: T('a JSON string'), args: ['"v"'], expect: 'error' },
    { id: 'v-missing', origin: T('no v'), args: ['{"unifiedAuth":{"name":"AA11BB22","hex":"00"}}'], expect: 'error' },
    { id: 'v-3', origin: T('v 3'), args: ['{"v":3,"unifiedAuth":{"name":"AA11BB22","hex":"00"}}'], expect: 'error' },
    { id: 'v-0', origin: T('v 0'), args: ['{"v":0,"unifiedAuth":{"name":"AA11BB22","hex":"00"}}'], expect: 'error' },
    { id: 'v-string', origin: T('v as the string "1"'), args: ['{"v":"1","unifiedAuth":{"name":"AA11BB22","hex":"00"}}'], expect: 'error' },
    { id: 'v-true', origin: T('v true'), args: ['{"v":true,"unifiedAuth":{"name":"AA11BB22","hex":"00"}}'], expect: 'error' },
    {
      id: 'v-float-forms',
      origin: adversarial('json', 'v written 1.0: JSON.parse gives the number 1, accepted'),
      args: ['{"v":1.0,"unifiedAuth":{"name":"AA11BB22","hex":"00"}}'],
      expect: 'out',
    },
    {
      id: 'v-exponent',
      origin: adversarial('json', 'v written 2e0, accepted as 2'),
      args: ['{"v":2e0,"unifiedAuth":{"name":"AA11BB22","hex":"00"}}'],
      expect: 'out',
    },
    {
      id: 'v-rounds-to-one',
      origin: adversarial('number', 'v written 1.0000000000000001 rounds to the double 1 and is accepted'),
      args: ['{"v":1.0000000000000001,"unifiedAuth":{"name":"AA11BB22","hex":"00"}}'],
      expect: 'out',
    },
    {
      id: 'v-near-one',
      origin: adversarial('number', 'v written 1.000000000000001 is a different double and is refused'),
      args: ['{"v":1.000000000000001,"unifiedAuth":{"name":"AA11BB22","hex":"00"}}'],
      expect: 'error',
    },
    {
      id: 'v-duplicate',
      origin: adversarial('json', 'v given twice: JSON.parse keeps the last, so 3 then 1 is accepted'),
      args: ['{"v":3,"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"00"}}'],
      expect: 'out',
    },
    {
      id: 'proto-top',
      origin: adversarial('json', 'the whole blob under an own __proto__ key: no v of its own, refused'),
      args: ['{"__proto__":{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"00"}}}'],
      expect: 'error',
    },
    {
      id: 'proto-unified-auth',
      origin: adversarial('json', 'name and hex only under __proto__ inside unifiedAuth: refused'),
      args: ['{"v":1,"unifiedAuth":{"__proto__":{"name":"AA11BB22","hex":"00"}}}'],
      expect: 'error',
    },
    { id: 'ua-null', origin: T('unifiedAuth null'), args: ['{"v":1,"unifiedAuth":null}'], expect: 'error' },
    { id: 'ua-string', origin: T('unifiedAuth a string'), args: ['{"v":1,"unifiedAuth":"AA11BB22"}'], expect: 'error' },
    { id: 'ua-array', origin: T('unifiedAuth an array'), args: ['{"v":1,"unifiedAuth":["AA11BB22","00"]}'], expect: 'error' },
    { id: 'name-missing', origin: T('no name'), args: ['{"v":1,"unifiedAuth":{"hex":"00"}}'], expect: 'error' },
    { id: 'name-empty', origin: T('an empty name'), args: ['{"v":1,"unifiedAuth":{"name":"","hex":"00"}}'], expect: 'error' },
    { id: 'name-number', origin: T('a numeric name'), args: ['{"v":1,"unifiedAuth":{"name":11,"hex":"00"}}'], expect: 'error' },
    {
      id: 'name-lone-surrogate',
      origin: adversarial('lone-surrogate', 'a \\ud800 escape in the name is kept as a lone surrogate'),
      args: ['{"v":1,"unifiedAuth":{"name":"x\\ud800","hex":"00"}}'],
      expect: 'out',
    },
    { id: 'name-spaces', origin: T('a name of one space is accepted'), args: ['{"v":1,"unifiedAuth":{"name":" ","hex":"00"}}'], expect: 'out' },
    { id: 'hex-missing', origin: T('no hex'), args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22"}}'], expect: 'error' },
    { id: 'hex-empty', origin: T('an empty hex'), args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":""}}'], expect: 'error' },
    { id: 'hex-odd', origin: T('an odd number of hex digits'), args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"abc"}}'], expect: 'error' },
    { id: 'hex-number', origin: T('hex as a number'), args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":10}}'], expect: 'error' },
    { id: 'hex-spaces', origin: T('hex with a space'), args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"01 ff"}}'], expect: 'error' },
    {
      id: 'hex-0x',
      origin: adversarial('parseint', 'hex with a 0x prefix is refused (the x is no hex digit)'),
      args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"0x01"}}'],
      expect: 'error',
    },
    {
      id: 'hex-trailing-newline',
      origin: adversarial('regex', 'hex followed by a newline: JS $ without the m flag matches only at the very end, so it is refused'),
      args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"01ff\\n"}}'],
      expect: 'error',
    },
    {
      id: 'hex-fullwidth',
      origin: adversarial('unicode-digit', 'full-width digits are no [0-9a-fA-F]'),
      args: ['{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"\uFF10\uFF11"}}'],
      expect: 'error',
    },
    {
      id: 'hex-long',
      origin: T('a long hex value of 62 digits'),
      args: [`{"v":1,"unifiedAuth":{"name":"AA11BB22","hex":"${'0A'.repeat(31)}"}}`],
      expect: 'out',
    },
  ],
});
