import { adversarial, bundleBytes, bytes, corpus, file, fixture, fromTest, input, text, vectorFile } from '../lib/index';
import { planAutoLoginRewrite } from '../../../../src/main/launchers/steam/loginusers';

const LOGINUSERS = 'fixtures/launchers/steam/loginusers.vdf';
const TESTS = 'test/steam-files.test.ts';
const original = bundleBytes(LOGINUSERS);

vectorFile({
  area: 'example',
  function: 'planAutoLoginRewrite',
  source: 'src/main/launchers/steam/loginusers.ts',
  decode: { 0: 'utf8' },
  note: [
    'The worked example of the l1 library; not part of the bundle.',
    'arg0 is loginusers.vdf as the Steam adapter reads it (readFileSync utf8: BOM kept, invalid bytes become U+FFFD); arg1 is the target SteamID64.',
  ].join('\n'),
  call: planAutoLoginRewrite,
  cases: [
    {
      id: 'flip-to-user-3',
      origin: fromTest(TESTS, 'planAutoLoginRewrite', 'flips AutoLogin to the target and clears it everywhere else, touching nothing else'),
      args: [file(LOGINUSERS), '76561198000000003'],
      expect: 'out',
    },
    {
      id: 'noop-user-1',
      origin: fromTest(TESTS, 'planAutoLoginRewrite', 'is a no-op when the target is already the only most recent account'),
      args: [file(LOGINUSERS), '76561198000000001'],
      expect: 'out',
    },
    {
      id: 'mostrecent-crlf',
      origin: fromTest(TESTS, 'planAutoLoginRewrite', 'rewrites MostRecent on older files, adds AutoLogin where neither key exists, and keeps CRLF'),
      args: [
        text(
          [
            '"users"',
            '{',
            '\t"76561198000000001"',
            '\t{',
            '\t\t"AccountName"\t\t"a"',
            '\t\t"MostRecent"\t\t"1"',
            '\t}',
            '\t"76561198000000002"',
            '\t{',
            '\t\t"AccountName"\t\t"b"',
            '\t\t"Timestamp"\t\t"1"',
            '\t}',
            '}',
            '',
          ].join('\r\n'),
        ),
        '76561198000000002',
      ],
      expect: 'out',
    },
    {
      id: 'unknown-target',
      origin: fromTest(TESTS, 'planAutoLoginRewrite', 'refuses a target that is not in the file'),
      args: [file(LOGINUSERS), '76561198000000099'],
      expect: 'error',
    },
    {
      id: 'undefined-target',
      origin: fixture(LOGINUSERS, 'target left undefined'),
      args: [file(LOGINUSERS), undefined],
      expect: 'error',
    },
    {
      id: 'not-vdf',
      origin: fixture(LOGINUSERS, 'cut after the first block opens'),
      args: [bytes(original.subarray(0, original.indexOf('{'.charCodeAt(0)) + 1)), '76561198000000003'],
      expect: 'error',
    },
    {
      id: 'bom',
      origin: fixture(LOGINUSERS, 'UTF-8 BOM added'),
      args: [bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original])), '76561198000000003'],
      expect: 'out',
    },
    {
      id: 'crlf-file',
      origin: fixture(LOGINUSERS, 'LF made CRLF, stored as a generated input'),
      args: [
        input('example', 'planAutoLoginRewrite/loginusers-crlf.vdf', Buffer.from(original.toString('latin1').replace(/\n/g, '\r\n'), 'latin1')),
        '76561198000000003',
      ],
      expect: 'out',
    },
    {
      id: 'invalid-utf8-in-name',
      origin: adversarial('utf8-decode', 'a lone 0xFF byte in an account name; Node decodes it to U+FFFD, Rust must replace it the same way and keep the rest'),
      args: [bytes(Buffer.from(original.toString('latin1').replace('"user_3"', '"user_\xff3"'), 'latin1')), '76561198000000003'],
      expect: 'out',
    },
    ...corpus({ seed: 1, count: 6, from: [{ path: LOGINUSERS }], args: (mutated) => [mutated, '76561198000000003'] }),
  ],
});
