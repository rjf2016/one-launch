import { adversarial, bytes, fromTest, text, vectorFile } from '../lib/index';
import { parseLockfile } from '../../../../src/main/launchers/riot/local-launch';

const TESTS = 'test/riot-local-launch.test.ts';
const READS = ['Riot lockfile', 'reads the port and the password from the client’s own https lockfile, and nothing else passes'] as const;
const REFUSES = [
  'Riot local launch request',
  'refuses an id that is not a product before reading anything, and a lockfile that is missing or not the client’s',
] as const;
const PASSWORD = 'placeholder-lockfile-password-0123456789';
const LOCKFILE = `Riot Client:4242:51234:${PASSWORD}:https`;
const at = (port: string, password = PASSWORD, pid = '4242'): string => `Riot Client:${pid}:${port}:${password}:https`;
const lit = (change: string) => fromTest(TESTS, READS[0], `${READS[1]} | ${change}`);

vectorFile({
  area: 'riot',
  function: 'parseLockfile',
  source: 'src/main/launchers/riot/local-launch.ts',
  decode: { 0: 'utf8' },
  note: [
    "arg0 is the Riot Client's Config\\lockfile as WindowsRiotLocalLaunch.launch in src/main/launchers/riot/local-launch.ts reads it (readFileSync utf8: a BOM stays as U+FEFF, invalid bytes become U+FFFD).",
    "No lockfile is in the fixtures (a real one is never read here, docs/adapters/riot.md rule 4); every input is the test file's placeholder lockfile or a change to it, and every password is a placeholder.",
    'The text is trimmed with JS String.prototype.trim (which removes U+FEFF and keeps U+0085) before it is split on ":".',
    "The port limits are the function's own: 1 to 65535, at most five ASCII digits; the cases sit at and one past each.",
  ].join('\n'),
  call: parseLockfile,
  cases: [
    { id: 'client-lockfile', origin: fromTest(TESTS, ...READS), args: [text(LOCKFILE)], expect: 'out' },
    { id: 'trailing-crlf', origin: fromTest(TESTS, ...READS), args: [text(`${LOCKFILE}\r\n`)], expect: 'out' },
    { id: 'empty', origin: fromTest(TESTS, ...READS), args: [text('')], expect: 'out' },
    { id: 'four-parts', origin: fromTest(TESTS, ...READS), args: [text('Riot Client:4242:51234:https')], expect: 'out' },
    { id: 'other-name', origin: fromTest(TESTS, ...READS), args: [text(`LeagueClient:4242:51234:${PASSWORD}:https`)], expect: 'out' },
    { id: 'http', origin: fromTest(TESTS, ...READS), args: [text(`Riot Client:4242:51234:${PASSWORD}:http`)], expect: 'out' },
    { id: 'cap-port-low-over', origin: fromTest(TESTS, ...READS), args: [text(at('0'))], expect: 'out' },
    { id: 'port-70000', origin: fromTest(TESTS, ...READS), args: [text(at('70000'))], expect: 'out' },
    { id: 'no-password', origin: fromTest(TESTS, ...READS), args: [text('Riot Client:4242:51234::https')], expect: 'out' },
    { id: 'pid-not-digits', origin: fromTest(TESTS, ...READS), args: [text(at('51234', PASSWORD, 'pid'))], expect: 'out' },
    { id: 'garbage', origin: fromTest(TESTS, ...REFUSES), args: [text('garbage')], expect: 'out' },
    { id: 'cap-port-low-at', origin: lit('port 1, the lowest accepted'), args: [text(at('1'))], expect: 'out' },
    { id: 'cap-port-high-at', origin: lit('port 65535, the highest accepted'), args: [text(at('65535'))], expect: 'out' },
    { id: 'cap-port-high-over', origin: lit('port 65536, one past the highest'), args: [text(at('65536'))], expect: 'out' },
    { id: 'cap-port-digits-at', origin: lit('port 00001: five digits, leading zeros'), args: [text(at('00001'))], expect: 'out' },
    { id: 'cap-port-digits-over', origin: lit('port 000001: six digits'), args: [text(at('000001'))], expect: 'out' },
    { id: 'port-99999', origin: lit('port 99999: five digits, out of range'), args: [text(at('99999'))], expect: 'out' },
    { id: 'port-empty', origin: lit('port empty'), args: [text(at(''))], expect: 'out' },
    { id: 'pid-empty', origin: lit('pid empty'), args: [text(at('51234', PASSWORD, ''))], expect: 'out' },
    {
      id: 'pid-huge',
      origin: lit('a pid of twenty digits: only its digits are checked'),
      args: [text(at('51234', PASSWORD, '99999999999999999999'))],
      expect: 'out',
    },
    { id: 'password-with-colon', origin: lit('a colon in the password makes six parts'), args: [text(at('51234', 'placeholder:password'))], expect: 'out' },
    { id: 'password-with-spaces', origin: lit('spaces inside the password are kept'), args: [text(at('51234', 'placeholder password 1'))], expect: 'out' },
    { id: 'name-lower-case', origin: lit('the name in lower case'), args: [text(`riot client:4242:51234:${PASSWORD}:https`)], expect: 'out' },
    { id: 'protocol-upper-case', origin: lit('the protocol in upper case'), args: [text(`Riot Client:4242:51234:${PASSWORD}:HTTPS`)], expect: 'out' },
    { id: 'outer-whitespace', origin: lit('spaces, tabs and blank lines around the line'), args: [text(`\r\n \t${LOCKFILE}\t \n\n`)], expect: 'out' },
    { id: 'second-line', origin: lit('a second line after the protocol'), args: [text(`${LOCKFILE}\nRiot Client:1:2:${PASSWORD}:https`)], expect: 'out' },
    { id: 'inner-space-in-port', origin: lit('a space before the port'), args: [text(at(' 51234'))], expect: 'out' },
    {
      id: 'adv-bom',
      origin: adversarial('unicode-space', 'a UTF-8 BOM before the lockfile: JS trim removes U+FEFF, so the name matches; Rust str::trim keeps U+FEFF'),
      args: [bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LOCKFILE)]))],
      expect: 'out',
    },
    {
      id: 'adv-nel',
      origin: adversarial('unicode-space', 'a trailing U+0085: JS trim keeps it, so the protocol is not https; Rust str::trim removes U+0085'),
      args: [text(`${LOCKFILE}\u0085`)],
      expect: 'out',
    },
    {
      id: 'adv-unicode-spaces',
      origin: adversarial('unicode-space', 'U+00A0, U+3000, U+2028 and U+205F around the line; both trims remove them'),
      args: [text(` 　${LOCKFILE}  `)],
      expect: 'out',
    },
    {
      id: 'adv-arabic-indic-port',
      origin: adversarial('unicode-digit', 'the port in Arabic-Indic digits: JS \\d is ASCII only and refuses it; a Unicode \\d would take it'),
      args: [text(at('٥١٢٣٤'))],
      expect: 'out',
    },
    {
      id: 'adv-fullwidth-pid',
      origin: adversarial('unicode-digit', 'the pid in fullwidth digits: JS \\d refuses it'),
      args: [text(at('51234', PASSWORD, '４２４２'))],
      expect: 'out',
    },
    {
      id: 'adv-plus-port',
      origin: adversarial('parseint', 'a port of +80: Number would take it, the digit check refuses it first'),
      args: [text(at('+80'))],
      expect: 'out',
    },
    {
      id: 'adv-hex-port',
      origin: adversarial('parseint', 'a port of 0x50: Number would read 80, the digit check refuses it first'),
      args: [text(at('0x50'))],
      expect: 'out',
    },
    {
      id: 'adv-leading-zero-port',
      origin: adversarial('parseint', 'a port of 08080: Number reads it as decimal 8080, never octal'),
      args: [text(at('08080'))],
      expect: 'out',
    },
    {
      id: 'adv-invalid-utf8-password',
      origin: adversarial(
        'utf8-decode',
        'a lone 0xFF and a CESU-encoded surrogate (ED A0 80) in the password; Node gives one U+FFFD for the first and three for the second',
      ),
      args: [
        bytes(
          Buffer.concat([
            Buffer.from('Riot Client:4242:51234:placeholder-'),
            Buffer.from([0xff]),
            Buffer.from('-'),
            Buffer.from([0xed, 0xa0, 0x80]),
            Buffer.from(':https'),
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'adv-astral-password',
      origin: adversarial('utf16-length', 'an astral character in the password is kept whole'),
      args: [text(at('51234', 'placeholder-\u{1F511}'))],
      expect: 'out',
    },
    {
      id: 'adv-truncated-utf8-end',
      origin: adversarial(
        'utf8-decode',
        'the placeholder lockfile ending in a truncated three-byte sequence after the protocol: Node gives one U+FFFD, which trim keeps, so the protocol is not https',
      ),
      args: [bytes(Buffer.concat([Buffer.from(LOCKFILE), Buffer.from([0xe2, 0x82])]))],
      expect: 'out',
    },
  ],
});
