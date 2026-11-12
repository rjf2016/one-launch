import { adversarial, bytes, corpus, fixture, fromTest, input, text, vectorFile, type Case } from '../lib/index';
import { classifyReason, latestOutcome, outcomeSince, parseLoginStates, readLoginLogSince } from '../../../../src/main/launchers/steam/login-log';
import { show, withFile } from './support';

const SOURCE = 'src/main/launchers/steam/login-log.ts';
const TESTS = 'test/steam-login-log.test.ts';
const LIMITS = 'test/parse-limits.test.ts';
const PARSING = 'steamui_login.txt parsing';
const APPENDS = 'reading only what Steam appends';
const MAX_LINE = 16 * 1024;
const MAX_TAIL = 512 * 1024;

const SAMPLE = [
  '[2026-09-12 15:00:43] Client version: 1788652215',
  '[2026-09-12 15:00:43] [ None ] Starting login',
  '[2026-09-12 15:00:43] [ None ] SetLoginState: WaitingForNetwork - OK',
  '[2026-09-12 15:00:43] [ WaitingForNetwork ] SetLoginState: WaitingForServerResponse - OK',
  '[2026-09-12 15:00:45] [ WaitingForServerResponse ] Received logon failure response',
  '[2026-09-12 15:00:45] [ WaitingForServerResponse ] SetLoginState: WaitingForCredentials - Account Logon Denied',
  '[2026-09-12 15:00:45] [ WaitingForCredentials ] UI Request: connect',
].join('\r\n');
const SUCCESS_LINE = '[x] [ WaitingForLibraryReady ] SetLoginState: Success - OK';
const PASSWORD_LINE = '[x] [ WaitingForServerResponse ] SetLoginState: WaitingForCredentials - Invalid Password';
const FILLER = '[x] [ None ] Starting login\n';
const T_EXTRACT = 'extracts state transitions with their reason';
const T_LATEST = 'reports the last decisive state, or null while Steam is still working';
const T_LONG = 'skips a log line longer than any launcher writes and still reads the lines around it';
const LIMITS_TITLE = 'launcher files of a size or shape no launcher writes (H16)';

const stateLine = (reason: string, state = 'WaitingForCredentials'): string => `SetLoginState: ${state} - ${reason}`;
const lineOf = (units: number): string => {
  const head = stateLine('');
  return `${head}${'r'.repeat(units - head.length)}`;
};

const parseCases = (): Case[] => [
  { id: 'sample', origin: fromTest(TESTS, PARSING, T_EXTRACT), args: [text(SAMPLE)], expect: 'out' },
  { id: 'sample-then-success', origin: fromTest(TESTS, PARSING, T_LATEST), args: [text(`${SAMPLE}\n${SUCCESS_LINE}`)], expect: 'out' },
  { id: 'still-working', origin: fromTest(TESTS, PARSING, T_LATEST), args: [text('[x] [ None ] SetLoginState: WaitingForNetwork - OK')], expect: 'out' },
  {
    id: 'limits-long-line',
    origin: fromTest(LIMITS, LIMITS_TITLE, T_LONG),
    args: [text([`SetLoginState: WaitingForCredentials - ${'x'.repeat(MAX_LINE + 1)}`, 'SetLoginState: Success - OK'].join('\n'))],
    expect: 'out',
  },
  { id: 'empty', origin: adversarial('other', 'an empty log has no states'), args: [text('')], expect: 'out' },
  {
    id: 'cap-line-at',
    origin: adversarial('utf16-length', 'a line of exactly MAX_LOG_LINE_LENGTH (16384) UTF-16 units is read'),
    args: [text(lineOf(MAX_LINE))],
    expect: 'out',
  },
  { id: 'cap-line-over', origin: adversarial('utf16-length', 'a line of 16385 UTF-16 units is skipped'), args: [text(lineOf(MAX_LINE + 1))], expect: 'out' },
  {
    id: 'cap-line-astral-at',
    origin: adversarial('utf16-length', 'a line of 16383 code points that is 16384 UTF-16 units (one astral character) is read'),
    args: [text(`${lineOf(MAX_LINE - 2)}\u{1F600}`)],
    expect: 'out',
  },
  {
    id: 'cap-line-astral-over',
    origin: adversarial(
      'utf16-length',
      'a line of 16384 code points that is 16385 UTF-16 units (one astral character) is skipped; a count of characters would read it',
    ),
    args: [text(`${lineOf(MAX_LINE - 1)}\u{1F600}`)],
    expect: 'out',
  },
  {
    id: 'cap-line-crlf-at',
    origin: adversarial('utf16-length', 'the CR of a CRLF is split off before the length is measured, so 16384 units plus CRLF is read'),
    args: [text(`${lineOf(MAX_LINE)}\r\n${stateLine('OK', 'Success')}`)],
    expect: 'out',
  },
  {
    id: 'cap-line-lone-cr-over',
    origin: adversarial('utf16-length', 'a trailing lone CR stays in the line and counts: 16384 units plus CR is skipped'),
    args: [text(`${lineOf(MAX_LINE)}\r\n`.replace('\r\n', '\r\r\n'))],
    expect: 'out',
  },
  {
    id: 'cr-trailing',
    origin: adversarial('regex', 'a CR left at the end of a line (CR CR LF) is eaten by \\s*$'),
    args: [text(`${stateLine('Invalid Password')}\r\r\n`)],
    expect: 'out',
  },
  {
    id: 'cr-inside',
    origin: adversarial('regex', 'a lone CR inside a line stops the match: . does not match CR and $ is the end of the line, so the state is lost'),
    args: [text(`${stateLine('Invalid Password')}\rtrailing\n${stateLine('OK', 'Success')}`)],
    expect: 'out',
  },
  {
    id: 'line-separator-inside',
    origin: adversarial('regex', 'U+2028 and U+2029 inside the reason stop the match (. excludes them in JS; Rust . matches them)'),
    args: [text(`${stateLine('Account Logon Denied')}\n${stateLine('Bad Password')}\n${stateLine('OK', 'Success')}`)],
    expect: 'out',
  },
  {
    id: 'line-separator-trailing',
    origin: adversarial('unicode-space', 'U+2028, NBSP and U+3000 at the end of the reason are trimmed by \\s*$'),
    args: [text(`${stateLine('Invalid Password 　 ')}`)],
    expect: 'out',
  },
  {
    id: 'bom-as-space',
    origin: adversarial('unicode-space', 'U+FEFF matches \\s in JS (not in Rust regex), around the state and the dash'),
    args: [text('SetLoginState:﻿Success﻿-﻿OK﻿')],
    expect: 'out',
  },
  {
    id: 'nel-not-space',
    origin: adversarial('unicode-space', 'U+0085 does not match \\s in JS (it does in Rust regex), so these lines do not match or keep it in the reason'),
    args: [text(`SetLoginState:\u0085Success - OK\n${stateLine('Invalid Password\u0085')}`)],
    expect: 'out',
  },
  { id: 'no-spaces', origin: adversarial('other', 'no spaces around the colon or the dash'), args: [text('SetLoginState:Success-OK')], expect: 'out' },
  {
    id: 'empty-reason',
    origin: adversarial('other', 'a dash and nothing after it is an empty reason'),
    args: [text('SetLoginState: Success -   ')],
    expect: 'out',
  },
  { id: 'no-dash', origin: adversarial('other', 'without a dash the line is not a state line'), args: [text('SetLoginState: Success OK')], expect: 'out' },
  {
    id: 'dash-in-reason',
    origin: adversarial('other', 'the first dash after the state splits; later dashes stay in the reason'),
    args: [text(stateLine('Account - Logon - Denied'))],
    expect: 'out',
  },
  {
    id: 'two-on-one-line',
    origin: adversarial('regex', 'two SetLoginState on one line: the first is taken and the second is part of its reason'),
    args: [text('SetLoginState: Success - x SetLoginState: WaitingForCredentials - Invalid Password')],
    expect: 'out',
  },
  {
    id: 'prefix-glued',
    origin: adversarial('word-boundary', 'the pattern is not anchored and has no \\b, so text glued in front still matches'),
    args: [text('xxSetLoginState: Success - OK')],
    expect: 'out',
  },
  {
    id: 'state-non-ascii',
    origin: adversarial('regex', '[A-Za-z]+ is ASCII: a state with è does not match'),
    args: [text('SetLoginState: Succès - OK')],
    expect: 'out',
  },
  { id: 'state-digits', origin: adversarial('regex', 'a state with a digit does not match'), args: [text('SetLoginState: State2 - OK')], expect: 'out' },
  {
    id: 'case-sensitive-tag',
    origin: adversarial('case-mapping', 'the SetLoginState tag is case-sensitive'),
    args: [text('setloginstate: Success - OK')],
    expect: 'out',
  },
  {
    id: 'bom-start',
    origin: adversarial('other', 'a BOM at the start of the log is part of the first line and harmless'),
    args: [bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(stateLine('OK', 'Success'))]))],
    expect: 'out',
  },
  {
    id: 'invalid-utf8-reason',
    origin: adversarial('utf8-decode', 'a lone 0xFF and a truncated 0xE2 0x82 in the reason become U+FFFD'),
    args: [bytes(Buffer.concat([Buffer.from('SetLoginState: WaitingForCredentials - Bad'), Buffer.from([0xff, 0xe2, 0x82]), Buffer.from(' Password\n')]))],
    expect: 'out',
  },
  {
    id: 'astral-reason',
    origin: adversarial('utf16-length', 'an astral character in the reason is kept'),
    args: [text(stateLine('\u{1F512} Locked'))],
    expect: 'out',
  },
  ...corpus({
    seed: 61,
    count: 40,
    from: [{ path: 'l1/steam/files/parseLoginStates/sample.txt', bytes: Buffer.from(`${SAMPLE}\n${SUCCESS_LINE}\n`) }],
    args: (mutated) => [mutated],
  }),
  {
    id: 'fixture-sample-file',
    origin: fixture('l1/steam/files/parseLoginStates/sample.txt'),
    args: [input('steam', 'parseLoginStates/sample.txt', Buffer.from(`${SAMPLE}\n${SUCCESS_LINE}\n`))],
    expect: 'out',
  },
];

const READ_NOTE =
  'The text is what readLoginLogSince returns: readTail/readRange (src/main/launchers/log-read.ts) read the bytes and decode them with toString(utf8), BOM kept, invalid bytes as U+FFFD.';

vectorFile({
  area: 'steam',
  function: 'parseLoginStates',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    `arg0 is steamui_login.txt text. ${READ_NOTE}`,
    'Caps: MAX_LOG_LINE_LENGTH 16384 UTF-16 units per line, measured after splitting on /\\r?\\n/ (cap-line-*). The 512 KiB tail is the caller’s (readLoginLogSince).',
    'gap: src/main/launchers/steam/login-log.ts:36:53 ?? right side, group 2 (.*?) always takes part in a match, so m[2] is never undefined.',
    'Corpus base: the test SAMPLE plus a Success line, as l1/steam/files/parseLoginStates/sample.txt.',
  ].join('\n'),
  call: parseLoginStates,
  cases: parseCases,
});

const T_MAP = "maps Steam's reason wording to what the user has to do";
const reasons: [string, string][] = [
  ['OK', T_MAP],
  ['', T_MAP],
  ['Account Logon Denied', T_MAP],
  ['Account Login Denied Need Two Factor', T_MAP],
  ['Two Factor Code Mismatch', T_MAP],
  ['Invalid Password', T_MAP],
  ['License expired', T_MAP],
  ['Rate Limit Exceeded', T_MAP],
  ['Service Unavailable', T_MAP],
];
const adversarialReasons: [string, string, string, string][] = [
  ['ok-padded', ' ok \t', 'unicode-space', 'trim then lower-case'],
  ['ok-nbsp', ' OK　', 'unicode-space', 'JS trim strips NBSP and U+3000'],
  ['ok-bom', '﻿OK', 'unicode-space', 'JS trim strips U+FEFF; Rust str::trim does not'],
  ['ok-nel', '\u0085OK', 'unicode-space', 'JS trim keeps U+0085; Rust str::trim strips it'],
  ['ok-zwsp', 'OK​', 'unicode-space', 'U+200B is not whitespace to either'],
  ['ok-kelvin', 'OK', 'case-mapping', 'U+212A KELVIN SIGN lower-cases to k, so this is ok'],
  ['twofactor', 'TwoFactorRequired', 'other', 'twofactor without a space'],
  ['mobile', 'Mobile Authenticator', 'other', 'mobile'],
  ['email', 'Check your EMAIL', 'other', 'email'],
  ['login-denied', 'Login Denied', 'other', 'login denied'],
  ['priority-mobile-over-email', 'Logon Denied, two factor by email', 'other', 'two factor is checked before logon denied'],
  ['priority-email-over-password', 'Logon denied: password', 'other', 'logon denied is checked before password'],
  ['priority-password-over-expired', 'Password expired', 'other', 'password is checked before expired'],
  ['priority-expired-over-rate', 'Expired rate limit', 'other', 'expired is checked before rate limit'],
  ['throttle', 'Throttled', 'other', 'throttle'],
  ['rate-double-space', 'Rate  Limit', 'unicode-space', 'two spaces are not rate limit'],
  ['rate-nbsp', 'Rate Limit', 'unicode-space', 'an NBSP is not the space in rate limit'],
  ['dotted-i-email', 'EMAİL', 'case-mapping', 'İ lower-cases to i plus U+0307, so EMAİL is not email'],
  ['turkish-password', 'PASSWORD İnvalid', 'case-mapping', 'PASSWORD still lower-cases to password'],
  ['long-s', 'PAſſWORD', 'case-mapping', 'ſ (long s) stays ſ under toLowerCase, so this is not password'],
  ['fullwidth', 'ＰＡＳＳＷＯＲＤ', 'case-mapping', 'fullwidth letters lower-case to fullwidth, not ASCII'],
  ['lone-surrogate', '\ud800 Password', 'lone-surrogate', 'a lone surrogate passes through trim and toLowerCase'],
  ['only-spaces', ' \t  ', 'unicode-space', 'only whitespace is empty, so none'],
];

vectorFile({
  area: 'steam',
  function: 'classifyReason',
  source: SOURCE,
  note: 'arg0 is the reason text of a WaitingForCredentials line, an in-memory string (from parseLoginStates). trim() and toLowerCase() are the JS ones.',
  call: classifyReason,
  cases: [
    ...reasons.map(([reason, title]) => ({
      id: `test-${reason.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'empty'}`,
      origin: fromTest(TESTS, PARSING, title),
      args: [reason],
      expect: 'out' as const,
    })),
    ...adversarialReasons.map(([id, reason, kind, what]) => ({
      id,
      origin: adversarial(kind as 'other', `${show(reason)}: ${what}`),
      args: [reason],
      expect: 'out' as const,
    })),
  ],
});

const events = (...pairs: [string, string][]) => pairs.map(([state, reason]) => ({ state, reason }));

vectorFile({
  area: 'steam',
  function: 'latestOutcome',
  source: SOURCE,
  note: 'arg0 is a list of { state, reason } as parseLoginStates returns it.',
  call: latestOutcome,
  cases: () => [
    { id: 'sample', origin: fromTest(TESTS, PARSING, T_LATEST), args: [parseLoginStates(SAMPLE)], expect: 'out' },
    { id: 'sample-then-success', origin: fromTest(TESTS, PARSING, T_LATEST), args: [parseLoginStates(`${SAMPLE}\n${SUCCESS_LINE}`)], expect: 'out' },
    {
      id: 'still-working',
      origin: fromTest(TESTS, PARSING, T_LATEST),
      args: [parseLoginStates('[x] [ None ] SetLoginState: WaitingForNetwork - OK')],
      expect: 'out',
    },
    { id: 'empty', origin: fromTest(TESTS, PARSING, T_LATEST), args: [[]], expect: 'out' },
    {
      id: 'success-then-credentials',
      origin: adversarial('other', 'the last decisive event wins'),
      args: [events(['Success', 'OK'], ['WaitingForCredentials', 'License expired'], ['WaitingForNetwork', 'OK'])],
      expect: 'out',
    },
    {
      id: 'credentials-ok',
      origin: adversarial('other', 'credentials with OK classify as none'),
      args: [events(['WaitingForCredentials', 'OK'])],
      expect: 'out',
    },
    {
      id: 'state-case',
      origin: adversarial('case-mapping', 'states are compared exactly: success and SUCCESS are not decisive'),
      args: [events(['success', 'OK'], ['SUCCESS', 'OK'], ['waitingforcredentials', 'x'])],
      expect: 'out',
    },
    {
      id: 'reason-kept-raw',
      origin: adversarial('unicode-space', 'the reason is returned as it was, untrimmed; only the cause is from the trimmed form'),
      args: [events(['WaitingForCredentials', ' Invalid Password '])],
      expect: 'out',
    },
  ],
});

const LOG = 'steamui_login.txt';
const log = (content: string | Buffer | undefined): { file?: Buffer } =>
  content === undefined ? {} : { file: Buffer.isBuffer(content) ? content : Buffer.from(content) };
const FILE_NOTE = `arg0 stands for the log file: { file: <bytes> } when <SteamPath>\\logs\\${LOG} exists, {} when it does not. call writes the bytes to ${LOG} in a fresh temporary folder, passes that path, and removes the folder; the path never reaches the result.`;

const bigTail = (): Buffer => {
  const first = `${PASSWORD_LINE}\n`;
  const filler = FILLER.repeat(Math.ceil(MAX_TAIL / FILLER.length) + 1);
  return Buffer.from(`${first}${filler}`.slice(0, MAX_TAIL + 1).replace(/[^\n]$/, '\n'));
};

const outcomeCases = (): Case[] => {
  const sampleNl = `${SAMPLE}\n`;
  const big = bigTail();
  const bigFile = () => ({ file: input('steam', 'outcomeSince/tail-512k-plus-1.txt', big) });
  return [
    {
      id: 'history-before-mark',
      origin: fromTest(TESTS, APPENDS, 'ignores history before the mark and sees lines added after it'),
      args: [log(sampleNl), Buffer.byteLength(sampleNl)],
      expect: 'out',
    },
    {
      id: 'line-after-mark',
      origin: fromTest(TESTS, APPENDS, 'ignores history before the mark and sees lines added after it'),
      args: [log(`${sampleNl}${SUCCESS_LINE}\n`), Buffer.byteLength(sampleNl)],
      expect: 'out',
    },
    {
      id: 'larger-than-one-read',
      origin: fromTest(TESTS, APPENDS, 'reads the end of a log that is larger than one read, not its start'),
      args: [log(`${PASSWORD_LINE}\n${FILLER.repeat(40)}${SUCCESS_LINE}\n`), 0],
      expect: 'out',
    },
    {
      id: 'missing-file',
      origin: fromTest(TESTS, APPENDS, 'copes with a missing file and with a log that was rotated'),
      args: [log(undefined), 0],
      expect: 'out',
    },
    {
      id: 'rotated',
      origin: fromTest(TESTS, APPENDS, 'copes with a missing file and with a log that was rotated'),
      args: [log(`${PASSWORD_LINE}\n`), Buffer.byteLength(sampleNl)],
      expect: 'out',
    },
    { id: 'whole-sample', origin: fromTest(TESTS, PARSING, T_LATEST), args: [log(SAMPLE), 0], expect: 'out' },
    { id: 'empty-file', origin: adversarial('other', 'an empty log'), args: [log(''), 0], expect: 'out' },
    {
      id: 'mark-at-end',
      origin: adversarial('other', 'a mark at the end of the file reads nothing'),
      args: [log(`${SUCCESS_LINE}\n`), Buffer.byteLength(`${SUCCESS_LINE}\n`)],
      expect: 'out',
    },
    {
      id: 'mark-mid-line',
      origin: adversarial('other', 'a mark in the middle of a line reads from there; the unanchored pattern still matches the rest'),
      args: [log(`${SUCCESS_LINE}\n`), 4],
      expect: 'out',
    },
    {
      id: 'mark-mid-character',
      origin: adversarial(
        'utf8-decode',
        'a mark inside a multi-byte character: the read starts with continuation bytes, each one U+FFFD, and the line is kept',
      ),
      args: [log(`é${stateLine('Invalid Password')}\n`), 1],
      expect: 'out',
    },
    {
      id: 'cap-tail-at',
      origin: adversarial('other', 'exactly MAX_TAIL_BYTES (524288) after the mark: no clip, so the first line (Invalid Password) is read'),
      args: [bigFile(), 1],
      expect: 'out',
    },
    {
      id: 'cap-tail-over',
      origin: adversarial(
        'other',
        'one byte more than MAX_TAIL_BYTES after the mark: the read is clipped and its first, partial line dropped, so no state is left',
      ),
      args: [bigFile(), 0],
      expect: 'out',
    },
    {
      id: 'invalid-utf8',
      origin: adversarial('utf8-decode', 'invalid bytes in the reason'),
      args: [log(Buffer.concat([Buffer.from(stateLine('Bad')), Buffer.from([0xc0, 0x80]), Buffer.from('\n')])), 0],
      expect: 'out',
    },
  ];
};

vectorFile({
  area: 'steam',
  function: 'outcomeSince',
  source: SOURCE,
  note: [
    FILE_NOTE,
    'arg1 is the mark, the byte size of the log when the wait began. The function reads at most the last MAX_TAIL_BYTES (512 KiB) appended since the mark (a log smaller than the mark was rotated and is read from its start), decodes it with toString(utf8), and returns latestOutcome(parseLoginStates(text)).',
    'Caps: MAX_TAIL_BYTES, one file l1/steam/files/outcomeSince/tail-512k-plus-1.txt of 524289 bytes read from mark 1 (cap-tail-at) and mark 0 (cap-tail-over).',
    'gap: src/main/launchers/steam/login-log.ts:85:11 catch (in readLoginLogSince), reached only when stat or read fails on a path that exists (a folder named like the log, a locked or unreadable file); no file content reaches it.',
  ].join('\n'),
  call: (arg: { file?: Buffer }, mark: number) => withFile(LOG, arg.file, (path) => outcomeSince(path, mark)),
  cases: outcomeCases,
});

const readCases = (): Case[] => {
  const old = `${PASSWORD_LINE}\n`;
  const content = `${old}${FILLER.repeat(40)}${SUCCESS_LINE}\n`;
  const sampleNl = `${SAMPLE}\n`;
  const T_END = 'reads the end of a log that is larger than one read, not its start';
  return [
    { id: 'tail-100', origin: fromTest(TESTS, APPENDS, T_END), args: [log(content), 0, 100], expect: 'out' },
    { id: 'tail-100-from-old', origin: fromTest(TESTS, APPENDS, T_END), args: [log(content), Buffer.byteLength(old), 100], expect: 'out' },
    {
      id: 'appended-since-mark',
      origin: fromTest(TESTS, APPENDS, 'ignores history before the mark and sees lines added after it'),
      args: [log(`${sampleNl}${SUCCESS_LINE}\n`), Buffer.byteLength(sampleNl), undefined],
      expect: 'out',
    },
    { id: 'missing-file', origin: adversarial('other', 'a missing log reads as empty'), args: [log(undefined), 0, undefined], expect: 'out' },
    {
      id: 'rotated',
      origin: adversarial('other', 'a log smaller than the mark is read from its start'),
      args: [log('short\n'), 1000, undefined],
      expect: 'out',
    },
    { id: 'mark-at-end', origin: adversarial('other', 'nothing appended'), args: [log('abc\n'), 4, undefined], expect: 'out' },
    {
      id: 'cap-max-at',
      origin: adversarial('other', 'exactly maxBytes after the mark: no clip, the first line is kept'),
      args: [log('first\nsecond\n'), 0, 13],
      expect: 'out',
    },
    {
      id: 'cap-max-over',
      origin: adversarial('other', 'one byte over maxBytes: the clipped first line is dropped'),
      args: [log('first\nsecond\n'), 0, 12],
      expect: 'out',
    },
    { id: 'clip-no-newline', origin: adversarial('other', 'a clipped read with no newline in it is empty'), args: [log('abcdefghij'), 0, 5], expect: 'out' },
    {
      id: 'clip-at-newline',
      origin: adversarial('other', 'a clip that starts on a newline drops only that newline'),
      args: [log('abc\ndef\n'), 0, 5],
      expect: 'out',
    },
    { id: 'max-zero', origin: adversarial('other', 'maxBytes 0 reads nothing'), args: [log('abc\n'), 0, 0], expect: 'out' },
    {
      id: 'clip-mid-character',
      origin: adversarial('utf8-decode', 'a clip inside a multi-byte character: the partial first line with its U+FFFD is dropped'),
      args: [log('ab\u{1F600}cd\nnext\n'), 0, 10],
      expect: 'out',
    },
    {
      id: 'mark-mid-character',
      origin: adversarial('utf8-decode', 'a mark inside a multi-byte character with no clip: the continuation bytes stay as U+FFFD'),
      args: [log('\u{1F600}x\n'), 2, undefined],
      expect: 'out',
    },
    {
      id: 'bom-kept',
      origin: adversarial('utf8-decode', 'a BOM at the start of an unclipped read is kept as U+FEFF'),
      args: [log(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a])), 0, undefined],
      expect: 'out',
    },
    { id: 'crlf-kept', origin: adversarial('other', 'line endings are returned as they are'), args: [log('a\r\nb\r\n'), 0, undefined], expect: 'out' },
  ];
};

vectorFile({
  area: 'steam',
  function: 'readLoginLogSince',
  source: SOURCE,
  note: [
    FILE_NOTE,
    'arg1 is the mark; arg2 is maxBytes, undefined for the default MAX_TAIL_BYTES (512 KiB). The result is the decoded text (toString utf8).',
    'Caps: maxBytes at and over with small values (cap-max-*); the default is exercised by outcomeSince’s cap-tail-*.',
    'gap: src/main/launchers/steam/login-log.ts:85:11 catch, reached only when stat or read fails on a path that exists (a folder named like the log, a locked or unreadable file); no file content reaches it.',
    'The default parameter maxBytes = MAX_TAIL_BYTES is not measured by the coverage tool (V8 keeps no counter for it); the cases with arg2 undefined use it.',
  ].join('\n'),
  call: (arg: { file?: Buffer }, mark: number, maxBytes: number | undefined) => withFile(LOG, arg.file, (path) => readLoginLogSince(path, mark, maxBytes)),
  cases: readCases,
});
