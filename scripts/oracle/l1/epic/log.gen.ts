import { adversarial, bundleBytes, bytes, type Case, corpus, file, fixture, fromTest, text, vectorFile } from '../lib/index';
import { isSessionRejection, lastSignIn, parseLogEvents, type LogEvent } from '../../../../src/main/launchers/epic/launcher-log';
import { MAX_LOG_LINE_LENGTH } from '../../../../src/main/launchers/log-read';

const SOURCE = 'src/main/launchers/epic/launcher-log.ts';
const OK_LOG = 'fixtures/launchers/epic/EpicGamesLauncher.log';
const EXPIRED_LOG = 'fixtures/launchers/epic/EpicGamesLauncher-expired-then-manual.log';
const FILES_TEST = 'test/epic-files.test.ts';
const LIMITS_TEST = 'test/parse-limits.test.ts';
const ADAPTER_TEST = 'test/epic-adapter.test.ts';
const T_EVENTS = ['launcher log', 'extracts sign-in outcomes with the account id, masking token ids in failures'] as const;
const T_MARK = [
  'launcher log',
  'reading only what the launcher appends, across log rotation',
  'reads from the mark within one run and from the start once the launcher started a new log',
] as const;
const T_TAIL = [
  'launcher log',
  'reading only what the launcher appends, across log rotation',
  'reads the end of a log that is larger than one read, so the newest sign-in decides',
] as const;
const T_LONG = [
  'launcher files of a size or shape no launcher writes (H16)',
  'skips a log line longer than any launcher writes and still reads the lines around it',
] as const;
const T_STATE = [
  'EpicAdapter.listRememberedAccounts and sessionState',
  'reports what the launcher remembers and whose it is, by fingerprint first and the log second',
] as const;
const T_STRANGER = ['EpicAdapter: a session that no One Launch account owns (B23)'] as const;
const ID3 = '33333333333333333333333333333333';
const EXPIRED_REASON = "Sorry the refresh token '\u{2026}' is invalid. Reason: TOKEN_EXPIRED errorcode=18036";

const okText = (): string => bundleBytes(OK_LOG).toString('utf8');
const expiredText = (): string => bundleBytes(EXPIRED_LOG).toString('utf8');
const SHUTDOWN = [
  `[2026.09.13-00.02.57:351][555]FAccountService::OnLoginComplete - 0 TRUE ${ID3} `,
  '[2026.09.13-00.04.23:616][627]FAccountService::SignOut',
  '[2026.09.13-00.04.23:968][628]LogCore: Engine exit requested (reason: Shutdown)',
  '[2026.09.13-00.04.24:088][628]Application: Restarting C:/Program Files (x86)/Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesUpdater.exe with command: start -epicenv=Prod',
].join('\r\n');
const PREFIX = '[2026.09.13-00.09.05:354][713]';
const line = (body: string) => `${PREFIX}${body}`;
const padTo = (head: string, length: number, tail = '') => `${head}${'x'.repeat(length - head.length - tail.length)}${tail}`;

vectorFile({
  area: 'epic',
  function: 'parseLogEvents',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    "Epic's launcher-log parser (Riot has its own parseLogEvents). arg0 is the log text as eventsSince (src/main/launchers/epic/launcher-log.ts) gets it: readLogSince, readTail, readRange, buf.toString utf8, so a BOM is kept and invalid bytes become U+FFFD. readTail drops a clipped first line before the text gets here.",
    `Lines split on /\\r?\\n/; a line longer than MAX_LOG_LINE_LENGTH (${MAX_LOG_LINE_LENGTH}) UTF-16 code units is skipped whole (the cap-line cases). The checks run in this order per line: AutoSignIn, SignIn, OnLoginComplete (TRUE or FALSE), AllCheckComplete, Restarting with EpicGamesUpdater.exe, Engine exit requested or a line starting "Log file closed".`,
    'A signed-in accountId is lower-cased when it is 32 hex digits and empty otherwise; at is the line\'s [yyyy.mm.dd-hh.mm.ss:mmm] prefix as an ISO string, not checked as a date. A failure reason drops "errormessage=", everything from "errorpath=", every 32-hex run (as \u{2026}) and outer whitespace.',
    'No byte cap in the function: it relies on readLogSince (MAX_TAIL_BYTES, 8 MiB).',
    'gap: src/main/launchers/epic/launcher-log.ts:75:29 ?? right side, the (.*) group always takes part in a match, so m[2] is never undefined.',
    'gap: src/main/launchers/epic/launcher-log.ts:75:59 ?? right side, split() always returns at least one item, so [0] is never undefined.',
    'gap: src/main/launchers/epic/launcher-log.ts:78:71 ?? right side, the (.*) group always takes part in a match, so m[2] is never undefined.',
  ].join('\n'),
  call: parseLogEvents,
  cases: () => {
    const c = (id: string, origin: Case['origin'], arg: unknown): Case => ({ id, origin, args: [arg], expect: 'out' });
    const f = (change: string) => fixture(OK_LOG, change);
    const lit = (value: string) => text(value);
    const auto = 'FAccountService::AutoSignIn';
    return [
      c('test-ok-log', fromTest(FILES_TEST, ...T_EVENTS), file(OK_LOG)),
      c('test-expired-then-manual', fromTest(FILES_TEST, ...T_EVENTS), file(EXPIRED_LOG)),
      c('test-shutdown', fromTest(FILES_TEST, ...T_EVENTS), lit(SHUTDOWN)),
      c('test-mark-signed-in', fromTest(FILES_TEST, ...T_MARK), lit(`[..]FAccountService::OnLoginComplete - 0 TRUE ${ID3} \r\n`)),
      c(
        'test-new-run-failed',
        fromTest(FILES_TEST, ...T_MARK),
        lit('Log file open, 09/11/26 13:09:07\r\n[..]FAccountService::AutoSignIn\r\n[..]FAccountService::OnLoginComplete - 0 FALSE  errormessage=nope\r\n'),
      ),
      c('test-first-run', fromTest(FILES_TEST, ...T_MARK), lit('Log file open, 09/11/26 13:08:02\r\n[..]FAccountService::AutoSignIn\r\n')),
      c(
        'test-tail-newest',
        fromTest(FILES_TEST, ...T_TAIL),
        lit(`[..]LogOnline: Verbose: chatter\r\n[..]FAccountService::OnLoginComplete - 0 TRUE ${ID3} \r\n`),
      ),
      c(
        'test-tail-whole',
        fromTest(FILES_TEST, ...T_TAIL),
        lit(
          `Log file open, 09/11/26 13:08:02\r\n[..]FAccountService::OnLoginComplete - 0 TRUE ${'2'.repeat(32)} \r\n${'[..]LogOnline: Verbose: chatter\r\n'.repeat(40)}[..]FAccountService::OnLoginComplete - 0 TRUE ${ID3} \r\n`,
        ),
      ),
      c(
        'test-long-line-skipped',
        fromTest(LIMITS_TEST, ...T_LONG),
        lit(
          [
            `[2026.09.13-00.09.05:354][713]LogAccount: FAccountService::OnLoginComplete - 0 FALSE ${'x'.repeat(MAX_LOG_LINE_LENGTH + 1)}`,
            '[2026.09.13-00.09.06:000][714]LogAccount: FAccountService::OnLoginComplete - 0 FALSE errormessage=expired errorpath=x',
          ].join('\r\n'),
        ),
      ),
      c(
        'test-stranger-log',
        fromTest(ADAPTER_TEST, ...T_STRANGER),
        lit('Log file open, run by hand\r\n[..]FAccountService::OnLoginComplete - 0 TRUE ffffffffffffffffffffffffffffffff '),
      ),
      c('test-expired-first-three', fromTest(ADAPTER_TEST, ...T_STATE), lit(expiredText().trimEnd().split('\r\n').slice(0, 3).join('\r\n'))),
      c('ok-log-lf', f('CRLF made LF'), lit(okText().replace(/\r\n/g, '\n'))),
      c('ok-log-bom', f('UTF-8 BOM added'), bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bundleBytes(OK_LOG)]))),
      c('expired-cr-only', fixture(EXPIRED_LOG, 'CRLF made CR, so the whole log is one line'), lit(expiredText().replace(/\r\n/g, '\r'))),
      c('empty', f('an empty log'), lit('')),
      c('only-newlines', f('only line breaks'), lit('\r\n\n\r\n')),
      c('auto-sign-in-anywhere', f('AutoSignIn in the middle of other text'), lit('noise FAccountService::AutoSignIn noise')),
      c('sign-in-prefix', f('SignIn followed by more letters still counts'), lit(line('FAccountService::SignInWithSomething'))),
      c(
        'sign-out-ignored',
        f('SignOut and OnLoginChanged are no events'),
        lit([line('FAccountService::SignOut'), line('FAccountService::OnLoginChanged - LoggedIn 0')].join('\n')),
      ),
      c(
        'auto-and-complete-one-line',
        f('AutoSignIn and OnLoginComplete on one line: the first check wins'),
        lit(line(`FAccountService::AutoSignIn FAccountService::OnLoginComplete - 0 TRUE ${ID3}`)),
      ),
      c(
        'true-uppercase-id',
        f('an upper-case account id is lower-cased'),
        lit(line(`FAccountService::OnLoginComplete - 0 TRUE ${'ABCDEF0123456789'.repeat(2)} `)),
      ),
      c('true-short-id', f('a 31-digit id gives an empty account id'), lit(line(`FAccountService::OnLoginComplete - 0 TRUE ${'a'.repeat(31)}`))),
      c('true-long-id', f('a 33-digit id gives an empty account id'), lit(line(`FAccountService::OnLoginComplete - 0 TRUE ${'a'.repeat(33)}`))),
      c('true-non-hex-id', f('a 32-character id with a g gives an empty account id'), lit(line(`FAccountService::OnLoginComplete - 0 TRUE ${'g'.repeat(32)}`))),
      c('true-no-id', f('TRUE with nothing after it'), lit(line('FAccountService::OnLoginComplete - 0 TRUE'))),
      c('true-extra-words', f('TRUE with words after the id'), lit(line(`FAccountService::OnLoginComplete - 0 TRUE   ${ID3} more words`))),
      c('true-tab-separated', f('TRUE and the id separated by a tab'), lit(line(`FAccountService::OnLoginComplete - 0 TRUE\t${ID3}`))),
      c('true-no-space-id', f('TRUE glued to the id'), lit(line(`FAccountService::OnLoginComplete - 0 TRUE${ID3}`))),
      c('true-multi-digit', f('a two-digit local user number'), lit(line(`FAccountService::OnLoginComplete - 12 TRUE ${ID3}`))),
      c('complete-no-digit', f('no local user number: no match'), lit(line(`FAccountService::OnLoginComplete -  TRUE ${ID3}`))),
      c('complete-lowercase-true', f('lower-case true: no match'), lit(line(`FAccountService::OnLoginComplete - 0 true ${ID3}`))),
      c('true-no-prefix', f('no time prefix gives at null'), lit(`FAccountService::OnLoginComplete - 0 TRUE ${ID3}`)),
      c(
        'true-bad-date',
        f('a prefix with month 13 and hour 99 is passed through unchecked'),
        lit(`[2026.13.45-99.99.99:999][0]FAccountService::OnLoginComplete - 0 TRUE ${ID3}`),
      ),
      c(
        'true-short-prefix',
        f('a prefix with two millisecond digits gives at null'),
        lit(`[2026.09.13-00.09.05:35][1]FAccountService::OnLoginComplete - 0 TRUE ${ID3}`),
      ),
      c('true-prefix-not-first', f('a prefix after a space gives at null'), lit(` ${PREFIX}FAccountService::OnLoginComplete - 0 TRUE ${ID3}`)),
      c(
        'false-errorpath-cut',
        f('a failure with errorpath twice'),
        lit(line('FAccountService::OnLoginComplete - 0 FALSE errormessage=x 0123456789abcdef0123456789abcdef y   errorpath=z errorpath=again')),
      ),
      c('false-no-errormessage', f('a failure without errormessage='), lit(line('FAccountService::OnLoginComplete - 0 FALSE network down'))),
      c('false-errormessage-later', f('errormessage= not at the start is kept'), lit(line('FAccountService::OnLoginComplete - 0 FALSE code=1 errormessage=x'))),
      c('false-empty', f('FALSE with nothing after it'), lit(line('FAccountService::OnLoginComplete - 0 FALSE'))),
      c('false-only-errorpath', f('a failure that is only errorpath'), lit(line('FAccountService::OnLoginComplete - 0 FALSE errorpath=a.b.c'))),
      c(
        'false-two-tokens',
        f('two 32-hex ids and a 64-hex run in one failure'),
        lit(line(`FAccountService::OnLoginComplete - 0 FALSE errormessage=a ${'1'.repeat(32)} b ${'C'.repeat(32)}${'d'.repeat(32)} c`)),
      ),
      c('false-31-hex', f('a 31-hex run is not masked'), lit(line(`FAccountService::OnLoginComplete - 0 FALSE errormessage=${'e'.repeat(31)}`))),
      c('false-33-hex', f('a 33-hex run keeps its last digit'), lit(line(`FAccountService::OnLoginComplete - 0 FALSE errormessage=${'e'.repeat(33)}`))),
      c('ready', f('AllCheckComplete'), lit(line('LogInit: AllCheckComplete SelfUpdate=0 SignedIn=0 RequiresRestart=1'))),
      c(
        'restart-needs-updater',
        f('Restarting without EpicGamesUpdater.exe is no event'),
        lit([line('Application: Restarting C:/x/Other.exe'), line('Application: Restarting C:/x/EpicGamesUpdater.exe with command: start')].join('\r\n')),
      ),
      c(
        'exit-variants',
        f('Engine exit requested anywhere, Log file closed only at the start'),
        lit(['LogCore: Engine exit requested (reason: x)', 'Log file closed, 09/11/26', ' Log file closed', 'x Log file closed'].join('\n')),
      ),
      c(
        'exit-after-bom',
        f('a BOM before Log file closed on the first line: not at the start, so no exit'),
        bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Log file closed, 09/11/26\r\n')])),
      ),
      c('cap-line-at', f(`a ${MAX_LOG_LINE_LENGTH}-unit AutoSignIn line is read`), lit(padTo(line(auto), MAX_LOG_LINE_LENGTH))),
      c('cap-line-over', f(`a ${MAX_LOG_LINE_LENGTH + 1}-unit AutoSignIn line is skipped`), lit(padTo(line(auto), MAX_LOG_LINE_LENGTH + 1))),
      c(
        'cap-line-astral-at',
        adversarial(
          'utf16-length',
          `an AutoSignIn line of ${MAX_LOG_LINE_LENGTH - 2} BMP characters and one astral is ${MAX_LOG_LINE_LENGTH} UTF-16 units and is read`,
        ),
        lit(padTo(line(auto), MAX_LOG_LINE_LENGTH, '\u{1F600}')),
      ),
      c(
        'cap-line-astral-over',
        adversarial(
          'utf16-length',
          `an AutoSignIn line of ${MAX_LOG_LINE_LENGTH - 1} BMP characters and one astral is ${MAX_LOG_LINE_LENGTH + 1} UTF-16 units and is skipped, though it is ${MAX_LOG_LINE_LENGTH} chars`,
        ),
        lit(padTo(line(auto), MAX_LOG_LINE_LENGTH + 1, '\u{1F600}')),
      ),
      c(
        'cap-line-multibyte-at',
        adversarial(
          'utf16-length',
          `an AutoSignIn line of ${MAX_LOG_LINE_LENGTH} UTF-16 units holding 3-byte characters is read, though it is far more than ${MAX_LOG_LINE_LENGTH} bytes`,
        ),
        lit(`${line(auto)}${'\u{4E2D}'.repeat(MAX_LOG_LINE_LENGTH - line(auto).length)}`),
      ),
      c(
        'cap-line-crlf',
        f(`a ${MAX_LOG_LINE_LENGTH}-unit line before CRLF is read: the CR is not part of the line`),
        lit(`${padTo(line(auto), MAX_LOG_LINE_LENGTH)}\r\n${line('LogInit: AllCheckComplete')}`),
      ),
      c(
        'cap-line-cr-counted',
        f(`a ${MAX_LOG_LINE_LENGTH}-unit line before CR CR LF keeps one CR and is skipped`),
        lit(`${padTo(line(auto), MAX_LOG_LINE_LENGTH)}\r\r\n${line('LogInit: AllCheckComplete')}`),
      ),
      c(
        'adv-unicode-digit',
        adversarial('unicode-digit', 'the local user number in Arabic-Indic digits: JS \\d is ASCII only, so no event; Rust regex \\d is Unicode'),
        lit(line(`FAccountService::OnLoginComplete - \u{0663} TRUE ${ID3}`)),
      ),
      c(
        'adv-unicode-digit-prefix',
        adversarial('unicode-digit', 'a time prefix in fullwidth digits: JS \\d refuses it, so at is null'),
        lit(`[\u{FF12}026.09.13-00.09.05:354][1]FAccountService::OnLoginComplete - 0 TRUE ${ID3}`),
      ),
      c(
        'adv-feff-before-id',
        adversarial('unicode-space', 'U+FEFF between TRUE and the id: JS \\s and trim() treat it as space, so the id is read; Rust \\s and trim() do not'),
        lit(line(`FAccountService::OnLoginComplete - 0 TRUE\u{FEFF}${ID3}`)),
      ),
      c(
        'adv-nel-before-id',
        adversarial('unicode-space', 'U+0085 between TRUE and the id: not \\s in JS, so the id is "\\u0085<id>" and not 32 hex; Rust \\s matches it'),
        lit(line(`FAccountService::OnLoginComplete - 0 TRUE \u{85}${ID3}`)),
      ),
      c(
        'adv-ideographic-space-id',
        adversarial('unicode-space', 'U+3000 after the id: \\s in both, the id is split off it'),
        lit(line(`FAccountService::OnLoginComplete - 0 TRUE ${ID3}\u{3000}more`)),
      ),
      c(
        'adv-reason-trim-feff',
        adversarial('unicode-space', 'a failure reason wrapped in U+FEFF: JS trim() removes it; Rust trim() keeps it'),
        lit(line('FAccountService::OnLoginComplete - 0 FALSE errormessage=\u{FEFF}nope\u{FEFF}')),
      ),
      c(
        'adv-reason-trim-nel',
        adversarial('unicode-space', 'a failure reason ending in U+0085: JS trim() keeps it; Rust trim() removes it'),
        lit(line('FAccountService::OnLoginComplete - 0 FALSE errormessage=nope\u{85}')),
      ),
      c(
        'adv-cr-inside-line',
        adversarial('regex', 'a bare CR after the id: JS (.*)$ cannot cross it, so the line is no OnLoginComplete event; Rust regex . matches CR'),
        lit(line(`FAccountService::OnLoginComplete - 0 TRUE ${ID3} \rjunk`)),
      ),
      c(
        'adv-cr-cr-lf',
        adversarial('regex', 'a line ending in CR CR LF keeps one CR, and JS (.*)$ fails on it: no event'),
        lit(`${line(`FAccountService::OnLoginComplete - 0 TRUE ${ID3} `)}\r\r\n`),
      ),
      c(
        'adv-line-separator',
        adversarial('regex', 'U+2028 inside a failure reason: JS . does not match it, so no event; Rust regex . does'),
        lit(line('FAccountService::OnLoginComplete - 0 FALSE errormessage=a\u{2028}b')),
      ),
      c(
        'adv-fullwidth-hex-id',
        adversarial('case-mapping', 'an id in fullwidth hex digits is not [0-9a-f] under /i in JS (no Unicode case folding without the u flag)'),
        lit(line(`FAccountService::OnLoginComplete - 0 TRUE ${'\u{FF21}'.repeat(32)}`)),
      ),
      c(
        'adv-kelvin-id',
        adversarial(
          'case-mapping',
          'a 32-character id with KELVIN SIGN U+212A: no match for [0-9a-f] under /i in JS; a Unicode-folding Rust regex would not match either, as k is not hex',
        ),
        lit(line(`FAccountService::OnLoginComplete - 0 TRUE ${'a'.repeat(31)}\u{212A}`)),
      ),
      c(
        'adv-dotted-capital-id',
        adversarial('case-mapping', 'an upper-case hex id is lower-cased with toLowerCase(); only ASCII A-F can reach it'),
        lit(line(`FAccountService::OnLoginComplete - 0 TRUE ${'ABCDEF'.repeat(5)}AB`)),
      ),
      c(
        'adv-invalid-utf8',
        adversarial('utf8-decode', 'a lone 0xFF in the fixture log line before the sign-in becomes U+FFFD; the events are unchanged'),
        bytes(Buffer.from(bundleBytes(OK_LOG).toString('latin1').replace('LoggedIn 0', 'LoggedIn \u{FF}0'), 'latin1')),
      ),
      c(
        'adv-invalid-utf8-in-id',
        adversarial('utf8-decode', 'a 0xC3 byte cut short inside the account id: U+FFFD makes it not 32 hex, so the id is empty'),
        bytes(
          Buffer.concat([
            Buffer.from(line(`FAccountService::OnLoginComplete - 0 TRUE ${'3'.repeat(16)}`)),
            Buffer.from([0xc3]),
            Buffer.from(`${'3'.repeat(15)} \r\n`),
          ]),
        ),
      ),
      c(
        'adv-hex-mask-unicode-digit',
        adversarial('unicode-digit', 'Arabic-Indic digits in a 32-character run are not [0-9a-f]: the run is not masked'),
        lit(line(`FAccountService::OnLoginComplete - 0 FALSE errormessage=${'\u{0661}'.repeat(32)}`)),
      ),
      ...corpus({ seed: 8, count: 40, from: [{ path: OK_LOG }, { path: EXPIRED_LOG }], args: (mutated) => [mutated] }),
    ];
  },
});

vectorFile({
  area: 'epic',
  function: 'lastSignIn',
  source: SOURCE,
  note: [
    'arg0 is a LogEvent array as a plain value. The fixture and test cases use the events the real parseLogEvents gives for that log (computed when the vector is made); the rest are hand-built.',
    'The function judges no time: at is passed through from the event, so no clock is involved.',
  ].join('\n'),
  call: lastSignIn,
  cases: () => {
    const c = (id: string, origin: Case['origin'], events: LogEvent[]): Case => ({ id, origin, args: [events], expect: 'out' });
    const ok = parseLogEvents(okText());
    const expired = parseLogEvents(expiredText());
    const shutdown = parseLogEvents(SHUTDOWN);
    const signed = (accountId: string, at: string | null = null): LogEvent => ({ kind: 'signed-in', accountId, at });
    const failed = (reason: string): LogEvent => ({ kind: 'sign-in-failed', reason });
    const f = (change: string) => fixture(OK_LOG, change);
    return [
      c('test-ok-log', fromTest(FILES_TEST, ...T_EVENTS), ok),
      c('test-expired-first-two', fromTest(FILES_TEST, ...T_EVENTS), expired.slice(0, 2)),
      c('test-expired-all', fromTest(FILES_TEST, ...T_EVENTS), expired),
      c('test-auto-only', fromTest(FILES_TEST, ...T_EVENTS), [{ kind: 'auto-sign-in' }]),
      c('test-shutdown', fromTest(FILES_TEST, ...T_EVENTS), shutdown),
      c('test-mark', fromTest(FILES_TEST, ...T_MARK), [signed(ID3)]),
      c('test-new-run-failed', fromTest(FILES_TEST, ...T_MARK), [{ kind: 'auto-sign-in' }, failed('nope')]),
      c('test-empty', fromTest(FILES_TEST, ...T_MARK), []),
      c('no-decisive', f('only events that decide nothing'), [
        { kind: 'auto-sign-in' },
        { kind: 'manual-sign-in' },
        { kind: 'ready' },
        { kind: 'restart' },
        { kind: 'exit' },
      ]),
      c('failure-after-success', f('a success, then a failure'), [signed(ID3, '2026-09-11T17:09:08.138Z'), failed(EXPIRED_REASON), { kind: 'exit' }]),
      c('success-after-failure', f('a failure, then a success'), [failed('nope'), signed(ID3, '2026-09-11T17:09:08.138Z'), { kind: 'ready' }]),
      c('empty-account-id', f('a success with an empty account id'), [signed('')]),
      c('two-successes', f('two successes: the last one wins'), [
        signed('1'.repeat(32), '2026-09-11T17:00:00.000Z'),
        signed('2'.repeat(32), '2026-09-11T18:00:00.000Z'),
      ]),
      c('two-failures', f('two failures: the last one wins'), [failed('first'), failed('')]),
      c('adv-bad-at', adversarial('date', 'an at that is no real date (month 13) is passed through as a string, never parsed'), [
        signed(ID3, '2026-13-45T99:99:99.999Z'),
      ]),
    ];
  },
});

vectorFile({
  area: 'epic',
  function: 'isSessionRejection',
  source: SOURCE,
  note: [
    'arg0 is a failure reason as maskReason leaves it (src/main/launchers/epic/adapter.ts passes the reason of a failed sign-in). The test is /TOKEN_EXPIRED|refresh token|invalid_grant|token (is |was |has )?(invalid|expired|revoked)/i.',
    'The i flag without u folds case by JS Canonicalize: a non-ASCII character never matches an ASCII one, so KELVIN SIGN is not k and LONG S is not s, where a Rust (?i) regex with Unicode case folding matches them.',
  ].join('\n'),
  call: isSessionRejection,
  cases: () => {
    const c = (id: string, origin: Case['origin'], reason: string): Case => ({ id, origin, args: [reason], expect: 'out' });
    const f = (change: string) => fixture(EXPIRED_LOG, change);
    return [
      c('test-expired-reason', fromTest(FILES_TEST, ...T_EVENTS), EXPIRED_REASON),
      c('test-nope', fromTest(FILES_TEST, ...T_MARK), 'nope'),
      c('test-expired-word', fromTest(LIMITS_TEST, ...T_LONG), 'expired'),
      c('empty', f('an empty reason'), ''),
      c('token-expired-only', f('only TOKEN_EXPIRED'), 'TOKEN_EXPIRED'),
      c('token-expired-lower', f('token_expired in lower case'), 'errorcode token_expired'),
      c('refresh-token-upper', f('REFRESH TOKEN in upper case'), 'REFRESH TOKEN gone'),
      c('refresh-token-two-spaces', f('refresh and token two spaces apart'), 'refresh  token'),
      c('refresh-token-glued', f('refreshtoken without the space'), 'refreshtoken'),
      c('invalid-grant', f('invalid_grant'), 'error=invalid_grant'),
      c('invalid-grant-hyphen', f('invalid-grant with a hyphen'), 'invalid-grant'),
      c('token-invalid', f('token invalid'), 'the token invalid'),
      c('token-is-invalid', f('token is invalid'), 'token is invalid'),
      c('token-was-expired', f('token was expired'), 'Token Was Expired'),
      c('token-has-revoked', f('token has revoked'), 'token has revoked'),
      c('token-has-been-revoked', f('token has been revoked: no match'), 'token has been revoked'),
      c('token-two-spaces', f('token and invalid two spaces apart'), 'token  invalid'),
      c('token-tab', f('a tab between token and invalid'), 'token\tinvalid'),
      c('tokens-invalid', f('tokens invalid: no match'), 'tokens invalid'),
      c('token-invalidated', f('token invalidated matches on its prefix'), 'token invalidated'),
      c('auth-token-invalid-path', f('a masked errorpath-free reason with token.invalid'), 'auth_token.invalid'),
      c('service-error', f('a service error the session survives'), 'Service unavailable errorcode=1041'),
      c('network-error', f('a network error'), 'errors.com.epicgames.common.server_error'),
      c(
        'adv-kelvin-sign',
        adversarial('case-mapping', 'TO\\u212AEN_EXPIRED with KELVIN SIGN: JS /i without u does not fold it to k; Rust (?i) does'),
        'TO\u{212A}EN_EXPIRED',
      ),
      c(
        'adv-long-s',
        adversarial('case-mapping', 'refre\\u017Fh token with LONG S: JS /i without u does not fold it to s; Rust (?i) does'),
        'refre\u{17F}h token',
      ),
      c(
        'adv-dotless-i',
        adversarial('case-mapping', '\\u0131nvalid_grant with DOTLESS I: not i in JS /i; not in Rust simple folding either'),
        '\u{131}nvalid_grant',
      ),
      c('adv-dotted-capital-i', adversarial('case-mapping', 'token \\u0130nvalid with CAPITAL I WITH DOT: not i in JS /i'), 'token \u{130}nvalid'),
      c('adv-nbsp', adversarial('unicode-space', 'token, U+00A0, invalid: the pattern has a literal space, so no match in either'), 'token\u{A0}invalid'),
      c('adv-fullwidth', adversarial('case-mapping', 'TOKEN_EXPIRED in fullwidth letters: no match'), '\u{FF34}\u{FF2F}\u{FF2B}\u{FF25}\u{FF2E}_EXPIRED'),
    ];
  },
});
