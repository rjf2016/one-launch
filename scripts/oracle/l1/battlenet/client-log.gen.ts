import { adversarial, bundleBytes, bytes, corpus, file, fixture, text, vectorFile, type Case, type Origin } from '../lib/index';
import {
  endedSignedOut,
  isForwarderLog,
  lastSignIn,
  lineTime,
  maskReason,
  parseLogEvents,
  type LogEvent,
} from '../../../../src/main/launchers/battlenet/client-log';
import { testOrigin, D_CLIENT_LOG, D_LIMITS, D_STATE, FILES_TEST, LIMITS_TEST, LOG_0913, LOGS, STATE_TEST } from './shared';

const SOURCE = 'src/main/launchers/battlenet/client-log.ts';
const logId = (path: string): string => `fixture-log-${/-(\d{8})T/.exec(path)![1]}`;
const MAX_LINE = 16 * 1024;
const T = testOrigin(FILES_TEST, D_CLIENT_LOG);
const TF = testOrigin(FILES_TEST, D_CLIENT_LOG, 'log files');
const LIM = testOrigin(LIMITS_TEST, D_LIMITS);
const S = testOrigin(STATE_TEST, D_STATE);
const RUN = 'parses the run: start, sign-in attempt, sign-in with the account id, main window, close, exit';
const FAIL = 'recognises failures, logouts, and launch requests, and masks reasons';
const NEWEST = 'picks the newest run by name and reads only what a new run or new bytes add';
const TAIL = 'reads the end of a log that is larger than one read, so the newest sign-in decides';
const FORWARDER = 'ignores the short log a --uri / --exec forwarder process leaves behind (seen 2026-09-13)';

const FAIL_LINES = [
  'I 2026-09-13 03:20:52.000000 [LoginController] {Main} Login_QueueUpdate (position=1)',
  'I 2026-09-13 03:20:52.500000 [BNLogin] {Main} BattleNetLogin::DeleteToken(): Deleting registry token because !m_lastEmailUsed.empty()',
  'E 2026-09-13 03:20:53.000000 [BNLogin] {Main} Login failed. error=ERROR_BAD_PASSWORD for someone@example.com token 0123456789abcdef0123',
  'I 2026-09-13 03:21:00.000000 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:0a1b2c3d|game=2:1:1',
  'I 2026-09-13 03:22:00.000000 [GameLaunchController] {Main} Launch request Pro. isRunning=0 isLaunching=0 supportsMultibox=0',
  'D 2026-09-13 03:25:00.000000 [BNLogin] {Main} BattleNetLogin::Logout() : calling DeleteToken()',
  'I 2026-09-13 03:26:00.000000 [Main] {Main} Auto logout dialog is now signaling application exit',
];
const FORWARDER_LINES = [
  'I 2026-09-13 04:20:43.512821 [Main] {Main} Logging started for Battle.net build 2.52.11.17778',
  'I 2026-09-13 04:20:43.514633 [Main] {Main} Command line arguments: {[0]=--uri=battlenet://game/pro}',
  'I 2026-09-13 04:20:43.515434 [Main] {Main} Launched with uri: battlenet://game/pro',
  'I 2026-09-13 04:20:43.515882 [Main] {Main} Opening IPC shared memory. queueName=User:x:Battle.net IPC ShMem mode=client',
  'I 2026-09-13 04:20:43.515951 [Main] {Main} Leaving because another instance of battle.net is running',
];
const signedInLine = (id: string): string => `I 2026-09-13 03:20:55.149702 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:${id}|game=1\r\n`;
const TAIL_TEXT = `${signedInLine('0a1b2c3d')}${'I 2026-09-13 03:21:00.000000 [Main] {Main} chatter\r\n'.repeat(40)}${signedInLine('ffffffff')}`;
const WOW_LINES = [
  'D 2026-09-24 22:07:03.000000 [ProductState] {Main} InstallState (wow): currentOperation=Repair currentOperationStatus=On installed=1 playable=0 regionalVersions=(us: {playable:true config_key:abc})',
  'D 2026-09-24 22:07:04.000000 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=On newStatus=Off agentUid=wow',
];
const RUNNING_LINES = [
  'D 2026-10-10 23:44:19.513560 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=Off newStatus=On agentUid=prometheus',
  'D 2026-10-10 23:44:19.514172 [ProductState] {Main} InstallState (prometheus): gameRunning=1 isGameProcessRunning=1',
];
const EXITED_LINES = [
  'D 2026-10-10 23:44:19.514172 [ProductState] {Main} InstallState (prometheus): gameRunning=1 isGameProcessRunning=1',
  'D 2026-10-10 23:44:22.613138 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=On newStatus=Off agentUid=prometheus',
  'D 2026-10-10 23:44:22.615643 [ProductState] {Main} InstallState (prometheus): gameRunning=0 isGameProcessRunning=0',
];
const LAUNCH_REQUEST = 'I 2026-09-13 03:22:00.000000 [GameLaunchController] {Main} Launch request Pro. isRunning=0 isLaunching=0 supportsMultibox=0';
const LAUNCHING = 'D 2026-10-10 23:43:29.436396 [ProductState] {Main} InstallState (prometheus): GameLaunching=1';

const P = 'I 2026-09-13 03:20:55.149702';
const line = (tag: string, body: string): string => `${P} [${tag}] {Main} ${body}`;
const LINE_CASES: { id: string; origin: Origin; lines: string[] }[] = [
  {
    id: 'started-no-build',
    origin: fixture(LOG_0913, 'the start line cut after the word build'),
    lines: [line('Main', 'Logging started for Battle.net build')],
  },
  {
    id: 'started-and-signed-in',
    origin: fixture(LOG_0913, 'a start and a sign-in on one line: the start wins'),
    lines: [line('Main', 'Logging started for Battle.net build 2.52 Logged into Battle.net successfully. |bnet=1:0:0a1b2c3d|')],
  },
  {
    id: 'started-build-nbsp',
    origin: adversarial('unicode-space', 'a U+00A0 inside the build: \\S stops at it in JS and in Rust'),
    lines: [line('Main', 'Logging started for Battle.net build 2.52\u00A0x')],
  },
  {
    id: 'started-build-feff',
    origin: adversarial('unicode-space', 'a U+FEFF inside the build: JS \\s counts it as space, so \\S stops; Rust \\s does not'),
    lines: [line('Main', 'Logging started for Battle.net build 2.52\uFEFFx')],
  },
  {
    id: 'started-build-ideographic',
    origin: adversarial('unicode-space', 'a U+3000 and a U+180E inside the build: JS \\s has U+3000, not U+180E'),
    lines: [line('Main', 'Logging started for Battle.net build 2.52\u180Ey\u3000x')],
  },
  {
    id: 'signed-in-no-bnet',
    origin: fixture(LOG_0913, 'the sign-in line without its bnet field'),
    lines: [line('BNLogin', 'Logged into Battle.net successfully.')],
  },
  {
    id: 'signed-in-upper-hex',
    origin: fixture(LOG_0913, 'the account id in upper case'),
    lines: [line('BNLogin', 'Logged into Battle.net successfully. |bnet=1:0:0A1B2C3D|game=1')],
  },
  {
    id: 'cap-account-id-at',
    origin: fixture(LOG_0913, 'a 16-digit account id, the longest the pattern takes'),
    lines: [line('BNLogin', 'Logged into Battle.net successfully. |bnet=1:0:0123456789abcdef|game=1')],
  },
  {
    id: 'cap-account-id-over',
    origin: fixture(LOG_0913, 'a 17-digit account id'),
    lines: [line('BNLogin', 'Logged into Battle.net successfully. |bnet=1:0:0123456789abcdef0|game=1')],
  },
  {
    id: 'signed-in-unicode-digit',
    origin: adversarial('unicode-digit', 'Arabic-Indic digits in the bnet field: JS \\d is ASCII only, Rust \\d is Unicode'),
    lines: [line('BNLogin', 'Logged into Battle.net successfully. |bnet=\u0661:\u0660:0a1b2c3d|game=1')],
  },
  {
    id: 'signed-in-no-prefix',
    origin: fixture(LOG_0913, 'the sign-in line without its time prefix'),
    lines: ['Logged into Battle.net successfully. |bnet=1:0:0a1b2c3d|'],
  },
  {
    id: 'signed-in-time-unicode-digit',
    origin: adversarial('unicode-digit', 'Arabic-Indic digits in the year: lineTime gives null in JS'),
    lines: ['I \u0662\u0660\u0662\u0666-09-13 03:20:55.149702 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:0a1b2c3d|'],
  },
  {
    id: 'signed-in-level-non-ascii',
    origin: adversarial('regex', 'a non-ASCII level letter: JS \\w is ASCII only, Rust \\w is Unicode'),
    lines: ['\u00C9 2026-09-13 03:20:55.149702 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:0a1b2c3d|'],
  },
  {
    id: 'signed-in-feff-separator',
    origin: adversarial('unicode-space', 'a U+FEFF between the level and the date: JS \\s matches it'),
    lines: ['I\uFEFF2026-09-13 03:20:55.149702 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:0a1b2c3d|'],
  },
  { id: 'attempt-entity', origin: fixture(LOG_0913, 'a login trigger with an entity id'), lines: [line('BNLogin', 'Login triggered. entityId=1:2:0a1b2c3d')] },
  {
    id: 'attempt-no-entity',
    origin: fixture(LOG_0913, 'a login trigger without an entity id is no event'),
    lines: [line('BNLogin', 'Login triggered. nothing')],
  },
  { id: 'attempt-entity-upper', origin: fixture(LOG_0913, 'the entity id in upper case'), lines: [line('BNLogin', 'Login triggered. entityId=1:2:0A1B2C3D')] },
  {
    id: 'attempt-entity-boundary-non-ascii',
    origin: adversarial('word-boundary', 'an entity id followed by \u00E9: JS \\b sees a boundary (\u00E9 is no word character), Rust Unicode \\b does not'),
    lines: [line('BNLogin', 'Login triggered. entityId=1:2:0a1b2c3d\u00E9')],
  },
  {
    id: 'attempt-entity-too-long',
    origin: fixture(LOG_0913, 'a 17-digit entity id has no word boundary after 16 digits'),
    lines: [line('BNLogin', 'Login triggered. entityId=1:2:0123456789abcdef0')],
  },
  { id: 'queue-update', origin: T(FAIL, 'the queue line alone'), lines: [FAIL_LINES[0]!] },
  { id: 'delete-token', origin: T(FAIL, 'the token discard line alone'), lines: [FAIL_LINES[1]!] },
  {
    id: 'failed-no-error-field',
    origin: fixture(LOG_0913, 'a failure without error=: the text after the last } is the reason'),
    lines: [line('BNLogin', 'Login failed. {code} code=3')],
  },
  { id: 'failed-no-brace', origin: fixture(LOG_0913, 'a failure line with no } at all'), lines: ['Login failed. plain'] },
  {
    id: 'on-login-failed',
    origin: fixture(LOG_0913, 'OnLoginFailed with an error field'),
    lines: [line('BNLogin', 'BattleNetLogin::OnLoginFailed() error=BLZBNTBGS000003F8 for user_1@example.com')],
  },
  {
    id: 'challenge-cancelled',
    origin: fixture(LOG_0913, 'the external challenge cancelled'),
    lines: [line('BNLogin', 'External Challenge was canceled by user')],
  },
  {
    id: 'failed-line-separator',
    origin: adversarial(
      'regex',
      'a U+2028 in the failure text: JS . does not match it, so error=(.*)$ fails and the fallback keeps more text; Rust . matches it',
    ),
    lines: [line('BNLogin', 'Login failed. error=bad\u2028password')],
  },
  {
    id: 'failed-lone-cr',
    origin: adversarial('regex', 'a lone CR inside the line: the split is on \\r?\\n only, and JS . does not match \\r'),
    lines: [line('BNLogin', 'Login failed. error=bad\rpassword')],
  },
  {
    id: 'failed-long-reason',
    origin: fixture(LOG_0913, 'a failure reason over 200 characters is cut'),
    lines: [line('BNLogin', `Login failed. error=${'reason '.repeat(40)}`)],
  },
  {
    id: 'failed-reason-astral-cut',
    origin: adversarial('utf16-length', 'an astral character across the 200-unit cut of the reason leaves a lone high surrogate'),
    lines: [line('BNLogin', `Login failed. error=${'r'.repeat(199)}\u{1F600}tail`)],
  },
  { id: 'logout', origin: T(FAIL, 'the logout line alone'), lines: [FAIL_LINES[5]!] },
  {
    id: 'delete-token-disabled',
    origin: fixture(LOG_0913, 'the token deleted because remembering is off'),
    lines: [line('BNLogin', 'BattleNetLogin::DeleteToken() because !enabled')],
  },
  { id: 'main-window', origin: fixture(LOG_0913, 'the main window line alone'), lines: [line('Main', 'Attempting to show main window')] },
  {
    id: 'install-launching',
    origin: S('knows a game is running from the last start or exit the client logged for it, whoever started it (2026-10-10)'),
    lines: [LAUNCHING],
  },
  {
    id: 'install-launching-wins',
    origin: fixture(LOG_0913, 'GameLaunching=1 and gameRunning=1 on one line: launching wins'),
    lines: [line('ProductState', 'InstallState (prometheus): gameRunning=1 GameLaunching=1')],
  },
  {
    id: 'install-running-word-boundary',
    origin: fixture(LOG_0913, 'gameRunning=10 and isgameRunning=1 are not gameRunning=1'),
    lines: [line('ProductState', 'InstallState (prometheus): gameRunning=10 isgameRunning=1')],
  },
  {
    id: 'install-playable-1',
    origin: fixture(LOG_0913, 'an install state with playable=1'),
    lines: [line('ProductState', 'InstallState (hs_beta): currentOperation=UpToDate currentOperationStatus=Paused playable=1')],
  },
  {
    id: 'install-playable-other',
    origin: fixture(LOG_0913, 'playable=yes is not 1'),
    lines: [line('ProductState', 'InstallState (hs_beta): currentOperation=UpToDate playable=yes')],
  },
  {
    id: 'install-no-status',
    origin: fixture(LOG_0913, 'currentOperation= with nothing after it and no status'),
    lines: [line('ProductState', 'InstallState (hs_beta): currentOperation= x')],
  },
  {
    id: 'install-no-fields',
    origin: fixture(LOG_0913, 'an install state with no field the parser reads is no event'),
    lines: [line('ProductState', 'InstallState (wow): installed=1')],
  },
  {
    id: 'install-bad-codename',
    origin: fixture(LOG_0913, 'a codename with a space does not match'),
    lines: [line('ProductState', 'InstallState (wow classic): currentOperation=Update')],
  },
  {
    id: 'install-proto-codename',
    origin: adversarial('other', 'the codename __proto__ fits the codename pattern'),
    lines: [line('ProductState', 'InstallState (__proto__): currentOperation=Update currentOperationStatus=New')],
  },
  {
    id: 'install-line-separator',
    origin: adversarial('regex', 'a U+2028 in the fields: JS (.*)$ cannot reach the end, so the line is no install state; Rust . matches it'),
    lines: [line('ProductState', 'InstallState (wow): currentOperation=Update\u2028currentOperationStatus=New')],
  },
  {
    id: 'install-field-unicode-space',
    origin: adversarial('unicode-space', 'a U+FEFF ends a field value in JS (\\S), not in Rust'),
    lines: [line('ProductState', 'InstallState (wow): currentOperation=Update\uFEFFx playable=1')],
  },
  {
    id: 'execute-pending',
    origin: fixture(LOG_0913, 'an Execute operation going Pending'),
    lines: [line('InstallInfo', 'Operation status changed: opType=Execute oldStatus=Off newStatus=Pending agentUid=prometheus')],
  },
  {
    id: 'execute-on',
    origin: S('knows a game is running from the last start or exit the client logged for it, whoever started it (2026-10-10)', 'the Execute line alone'),
    lines: [RUNNING_LINES[0]!],
  },
  {
    id: 'execute-other-status',
    origin: fixture(LOG_0913, 'an Execute operation going Paused is no event'),
    lines: [line('InstallInfo', 'Operation status changed: opType=Execute oldStatus=On newStatus=Paused agentUid=prometheus')],
  },
  {
    id: 'execute-update-op',
    origin: fixture(LOG_0913, 'an Update operation is no game start'),
    lines: [line('InstallInfo', 'Operation status changed: opType=Update oldStatus=Off newStatus=On agentUid=battle.net')],
  },
  { id: 'launch-binary', origin: fixture(LOG_0913, 'a LaunchBinary line'), lines: [line('GameLaunchController', 'LaunchBinary: uid=prometheus path=x')] },
  { id: 'game-is-running', origin: fixture(LOG_0913, 'a Game is running line'), lines: [line('InstallManager', 'Game is running: hs_beta')] },
  {
    id: 'launch-request-no-dot',
    origin: fixture(LOG_0913, 'a launch request without the dot'),
    lines: [line('GameLaunchController', 'Launch request WTCG isRunning=0')],
  },
  {
    id: 'launch-request-two-dots',
    origin: fixture(LOG_0913, 'a launch request with two dots keeps one'),
    lines: [line('GameLaunchController', 'Launch request Pro.. isRunning=0')],
  },
  {
    id: 'launch-request-dot-only',
    origin: fixture(LOG_0913, 'a launch request whose code is a dot'),
    lines: [line('GameLaunchController', 'Launch request . isRunning=0')],
  },
  { id: 'close-requested', origin: fixture(LOG_0913, 'the close line alone'), lines: [line('Main', 'Frontend is requesting to close window')] },
  { id: 'shutting-down', origin: fixture(LOG_0913, 'the shutdown line alone'), lines: [line('Main', 'Shutting down battle.net interface')] },
  { id: 'unrelated', origin: fixture(LOG_0913, 'lines no rule reads'), lines: [line('Main', 'chatter'), '', '   '] },
];

const logCases = (): Case[] => [
  ...LOGS.map((path) => ({ id: logId(path), origin: fixture(path), args: [file(path)], expect: 'out' as const })),
  { id: 'test-failures', origin: T(FAIL), args: [text(FAIL_LINES.join('\r\n'))], expect: 'out' },
  {
    id: 'test-appended-sign-in',
    origin: TF(NEWEST, 'the sign-in line appended to the log'),
    args: [text(signedInLine('ffffffff'))],
    expect: 'out',
  },
  { id: 'test-tail', origin: TF(TAIL), args: [text(TAIL_TEXT)], expect: 'out' },
  { id: 'test-forwarder', origin: TF(FORWARDER), args: [text(FORWARDER_LINES.join('\r\n'))], expect: 'out' },
  {
    id: 'test-launch-request',
    origin: S('still accepts the launch request line older builds logged, matched on the program code'),
    args: [text(LAUNCH_REQUEST)],
    expect: 'out',
  },
  { id: 'test-regional-playable', origin: S('ignores the regional playable flags and a game exit'), args: [text(WOW_LINES.join('\n'))], expect: 'out' },
  {
    id: 'test-running',
    origin: S('knows a game is running from the last start or exit the client logged for it, whoever started it (2026-10-10)'),
    args: [text(RUNNING_LINES.join('\n'))],
    expect: 'out',
  },
  {
    id: 'test-exited',
    origin: S('knows a game is running from the last start or exit the client logged for it, whoever started it (2026-10-10)'),
    args: [text(EXITED_LINES.join('\n'))],
    expect: 'out',
  },
  ...LINE_CASES.map((c) => ({ id: c.id, origin: c.origin, args: [text(c.lines.join('\r\n'))], expect: 'out' as const })),
  { id: 'empty', origin: fixture(LOG_0913, 'emptied'), args: [text('')], expect: 'out' },
  {
    id: 'bom-first-line',
    origin: fixture(LOG_0913, 'UTF-8 BOM added: the first line keeps U+FEFF, so its time does not parse'),
    args: [bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(signedInLine('0a1b2c3d'))]))],
    expect: 'out',
  },
  {
    id: 'cr-only',
    origin: fixture(LOG_0913, 'lines ended by CR alone are one line'),
    args: [text([line('Main', 'Attempting to show main window'), line('Main', 'Frontend is requesting to close window')].join('\r'))],
    expect: 'out',
  },
  { id: 'lf-only', origin: fixture(LOG_0913, 'CRLF made LF'), args: [text(bundleBytes(LOG_0913).toString('utf8').replace(/\r\n/g, '\n'))], expect: 'out' },
  {
    id: 'invalid-utf8-in-reason',
    origin: adversarial('utf8-decode', 'a lone 0xFF and a truncated F0 9F 98 in a failure reason become U+FFFD'),
    args: [bytes(Buffer.concat([Buffer.from(line('BNLogin', 'Login failed. error=bad')), Buffer.from([0xff, 0x20, 0xf0, 0x9f, 0x98]), Buffer.from(' end')]))],
    expect: 'out',
  },
  {
    id: 'cap-line-at',
    origin: LIM('skips a log line longer than any launcher writes and still reads the lines around it', 'a line of exactly 16384 units'),
    args: [text(capLine(MAX_LINE))],
    expect: 'out',
  },
  {
    id: 'cap-line-over',
    origin: LIM('skips a log line longer than any launcher writes and still reads the lines around it'),
    args: [
      text(
        [
          `${P} [BNLogin] {Main} Login failed. error=${'x'.repeat(MAX_LINE + 1)}`,
          'I 2026-09-13 03:20:56.000000 [BNLogin] {Main} Login failed. error=bad password',
        ].join('\r\n'),
      ),
    ],
    expect: 'out',
  },
  {
    id: 'cap-line-over-by-one',
    origin: LIM('skips a log line longer than any launcher writes and still reads the lines around it', 'a line of 16385 units'),
    args: [text(capLine(MAX_LINE + 1))],
    expect: 'out',
  },
  {
    id: 'cap-line-astral-at',
    origin: adversarial('utf16-length', 'a line of 16384 UTF-16 units ending in an astral character (16383 code points) is read'),
    args: [text(capLine(MAX_LINE - 2) + '\u{1F600}')],
    expect: 'out',
  },
  {
    id: 'cap-line-astral-over',
    origin: adversarial('utf16-length', 'a line of 16383 code points but 16385 UTF-16 units is skipped: the limit counts units'),
    args: [text(capLine(MAX_LINE - 1) + '\u{1F600}')],
    expect: 'out',
  },
  {
    id: 'cap-line-non-ascii-at',
    origin: adversarial('utf16-length', 'a line of 16384 units that is 32 KiB of UTF-8 is read: the limit counts units, not bytes'),
    args: [text(capLine(MAX_LINE, '\u00E9'))],
    expect: 'out',
  },
  {
    id: 'cap-line-truncated-utf8-at',
    origin: adversarial('utf8-decode', 'each truncated F0 9F 98 decodes to one U+FFFD, so 5000 of them make a 16384-unit line of 25 KiB, which is read'),
    args: [bytes(Buffer.concat([Buffer.from(capLine(MAX_LINE - 5000)), Buffer.alloc(3 * 5000, Buffer.from([0xf0, 0x9f, 0x98]))]))],
    expect: 'out',
  },
  {
    id: 'cap-line-truncated-utf8-over',
    origin: adversarial('utf8-decode', 'one more unit of the same: 5001 truncated sequences make 16385 units, and the line is skipped'),
    args: [bytes(Buffer.concat([Buffer.from(capLine(MAX_LINE - 5000)), Buffer.alloc(3 * 5001, Buffer.from([0xf0, 0x9f, 0x98]))]))],
    expect: 'out',
  },
];

function capLine(units: number, fill = 'x'): string {
  const head = `${P} [BNLogin] {Main} Login failed. error=`;
  return head + fill.repeat(units - head.length);
}

vectorFile({
  area: 'battlenet',
  function: 'parseLogEvents',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: [
    'arg0 is client-log text as src/main/launchers/log-read.ts readRange decodes it (Buffer toString utf8, BOM kept) for readLogSince, which eventsSince and currentRunEvents parse.',
    "readTail clips to the newest 8 MiB (MAX_TAIL_BYTES) and drops a clipped first line; that cap is the caller's, not this function's. The function itself skips any line longer than MAX_LOG_LINE_LENGTH (16384) UTF-16 units.",
    'A seeded corpus (seed 31) over the three fixture logs adds robustness cases; it is not a rewriter corpus.',
  ].join('\n'),
  call: parseLogEvents,
  cases: () => [...logCases(), ...corpus({ seed: 31, count: 40, from: LOGS.map((path) => ({ path })), args: (m) => [m] })],
});

vectorFile({
  area: 'battlenet',
  function: 'lineTime',
  source: SOURCE,
  note: 'arg0 is one log line, already split, in memory. Reads the prefix "<level> YYYY-MM-DD HH:MM:SS.fff"; no range check on the fields.',
  call: lineTime,
  cases: [
    { id: 'test-line', origin: T(RUN), args: ['I 2026-09-13 03:20:55.149702 [BNLogin] {Main} x'], expect: 'out' },
    { id: 'test-no-prefix', origin: T(RUN), args: ['no prefix'], expect: 'out' },
    { id: 'three-digit-fraction', origin: fixture(LOG_0913, 'a three-digit fraction'), args: ['D 2026-09-13 03:20:55.149 x'], expect: 'out' },
    { id: 'two-digit-fraction', origin: fixture(LOG_0913, 'a two-digit fraction'), args: ['D 2026-09-13 03:20:55.14 x'], expect: 'out' },
    { id: 'many-spaces', origin: fixture(LOG_0913, 'several spaces and a tab after the level'), args: ['W \t  2026-09-13 03:20:55.149702 x'], expect: 'out' },
    { id: 'no-space', origin: fixture(LOG_0913, 'no space after the level'), args: ['I2026-09-13 03:20:55.149702 x'], expect: 'out' },
    { id: 'two-letter-level', origin: fixture(LOG_0913, 'a two-letter level'), args: ['II 2026-09-13 03:20:55.149702 x'], expect: 'out' },
    { id: 'underscore-level', origin: fixture(LOG_0913, 'an underscore or a digit is a \\w level'), args: ['_ 2026-09-13 03:20:55.149702 x'], expect: 'out' },
    { id: 'digit-level', origin: fixture(LOG_0913, 'a digit as the level'), args: ['7 2026-09-13 03:20:55.149702 x'], expect: 'out' },
    { id: 'leading-space', origin: fixture(LOG_0913, 'a space before the level'), args: [' I 2026-09-13 03:20:55.149702 x'], expect: 'out' },
    { id: 'out-of-range', origin: fixture(LOG_0913, 'month 13, day 45, hour 99: copied as written'), args: ['I 2026-13-45 99:99:99.999 x'], expect: 'out' },
    { id: 'empty', origin: fixture(LOG_0913, 'an empty line'), args: [''], expect: 'out' },
    {
      id: 'level-non-ascii',
      origin: adversarial('regex', 'a non-ASCII level letter: JS \\w (no u flag) is ASCII only'),
      args: ['\u00C9 2026-09-13 03:20:55.149702 x'],
      expect: 'out',
    },
    {
      id: 'level-astral',
      origin: adversarial('regex', 'an astral level character is two UTF-16 units and no \\w'),
      args: ['\u{1D400} 2026-09-13 03:20:55.149702 x'],
      expect: 'out',
    },
    {
      id: 'space-nbsp',
      origin: adversarial('unicode-space', 'U+00A0 after the level matches JS \\s'),
      args: ['I\u00A02026-09-13 03:20:55.149702 x'],
      expect: 'out',
    },
    {
      id: 'space-feff',
      origin: adversarial('unicode-space', 'U+FEFF after the level matches JS \\s, not Rust \\s'),
      args: ['I\uFEFF2026-09-13 03:20:55.149702 x'],
      expect: 'out',
    },
    {
      id: 'space-mongolian',
      origin: adversarial('unicode-space', 'U+180E after the level is no JS \\s'),
      args: ['I\u180E2026-09-13 03:20:55.149702 x'],
      expect: 'out',
    },
    {
      id: 'space-line-separator',
      origin: adversarial('unicode-space', 'U+2028 and U+3000 after the level match JS \\s'),
      args: ['I\u2028\u30002026-09-13 03:20:55.149702 x'],
      expect: 'out',
    },
    {
      id: 'digits-arabic-indic',
      origin: adversarial('unicode-digit', 'Arabic-Indic digits in the year: JS \\d is ASCII only'),
      args: ['I \u0662\u0660\u0662\u0666-09-13 03:20:55.149702 x'],
      expect: 'out',
    },
    {
      id: 'digits-fullwidth',
      origin: adversarial('unicode-digit', 'full-width digits in the fraction'),
      args: ['I 2026-09-13 03:20:55.\uFF11\uFF14\uFF19 x'],
      expect: 'out',
    },
    {
      id: 'bom-first',
      origin: adversarial('unicode-space', 'a U+FEFF before the level, as the first line of a file with a BOM: \\w fails'),
      args: ['\uFEFFI 2026-09-13 03:20:55.149702 x'],
      expect: 'out',
    },
  ],
});

vectorFile({
  area: 'battlenet',
  function: 'maskReason',
  source: SOURCE,
  note: [
    'arg0 is a failure text cut from a log line, in memory. Drops emails and hex runs of 16 or more, trims (JS trim), then keeps the first 200 UTF-16 units.',
    'The test literals of 200 000 characters that check linear time are not recorded (over the inline limit and about time, not output); shorter cases of the same shapes are.',
  ].join('\n'),
  call: maskReason,
  cases: [
    { id: 'test-cut-200', origin: T(FAIL), args: ['x '.repeat(200)], expect: 'out' },
    {
      id: 'test-email-and-token',
      origin: LIM('masks a failure reason in linear time, whatever one long run of characters it holds'),
      args: ['wrong password for some.one@example.com token 0123456789abcdef0123'],
      expect: 'out',
    },
    {
      id: 'test-long-run-a',
      origin: LIM('masks a failure reason in linear time, whatever one long run of characters it holds', 'shortened to 2000 characters'),
      args: ['a'.repeat(2000)],
      expect: 'out',
    },
    {
      id: 'test-long-run-dots',
      origin: LIM('masks a failure reason in linear time, whatever one long run of characters it holds', 'shortened to 1000 pairs'),
      args: ['a.'.repeat(1000)],
      expect: 'out',
    },
    {
      id: 'test-long-run-ats',
      origin: LIM('masks a failure reason in linear time, whatever one long run of characters it holds', 'shortened to 1000 pairs'),
      args: ['a@'.repeat(1000)],
      expect: 'out',
    },
    {
      id: 'email-plus-dots',
      origin: fixture(LOG_0913, 'an email with a plus, dots and a sub-domain'),
      args: ['for first.last+tag@mail.example.co.uk.'],
      expect: 'out',
    },
    {
      id: 'email-glued',
      origin: fixture(LOG_0913, 'an email right after a slash and before a comma'),
      args: ['/user_1@example.com,user_2@example.com'],
      expect: 'out',
    },
    { id: 'email-no-dot', origin: fixture(LOG_0913, 'an @ with no dotted domain is kept'), args: ['user@localhost'], expect: 'out' },
    {
      id: 'email-non-ascii-local',
      origin: adversarial('regex', 'a non-ASCII letter right before the @: JS \\w is ASCII, so this email is not masked; Rust Unicode \\w would mask it'),
      args: ['for jos\u00E9@example.com'],
      expect: 'out',
    },
    {
      id: 'email-non-ascii-domain',
      origin: adversarial('regex', 'a non-ASCII domain letter: the JS pattern stops before it and keeps the email'),
      args: ['for user@ex\u00E4mple.com'],
      expect: 'out',
    },
    {
      id: 'email-non-ascii-tld',
      origin: adversarial('regex', 'a non-ASCII letter after the dot: JS masks up to it and keeps the rest'),
      args: ['for user@example.c\u00F6m'],
      expect: 'out',
    },
    { id: 'hex-16', origin: fixture(LOG_0913, 'a 16-digit hex run, the shortest that is masked'), args: ['token 0123456789abcdef end'], expect: 'out' },
    { id: 'hex-15', origin: fixture(LOG_0913, 'a 15-digit hex run is kept'), args: ['token 0123456789abcde end'], expect: 'out' },
    { id: 'hex-upper', origin: fixture(LOG_0913, 'upper-case hex is masked'), args: ['token 0123456789ABCDEF0123 end'], expect: 'out' },
    {
      id: 'hex-glued-letter',
      origin: fixture(LOG_0913, 'a hex run glued to a letter has no word boundary and is kept'),
      args: ['tokeng0123456789abcdef0123 end'],
      expect: 'out',
    },
    {
      id: 'hex-glued-underscore',
      origin: fixture(LOG_0913, 'a hex run after an underscore has no word boundary'),
      args: ['id_0123456789abcdef0123'],
      expect: 'out',
    },
    {
      id: 'hex-non-ascii-boundary',
      origin: adversarial('word-boundary', 'a hex run after \u00E9: JS \\b sees a boundary and masks; Rust Unicode \\b does not'),
      args: ['caf\u00E90123456789abcdef0123'],
      expect: 'out',
    },
    { id: 'hex-in-email', origin: fixture(LOG_0913, 'an email whose local part is hex'), args: ['0123456789abcdef0123@example.com'], expect: 'out' },
    { id: 'trim-ascii', origin: fixture(LOG_0913, 'spaces, tabs and newlines around the text'), args: [' \t\r\n bad password \n'], expect: 'out' },
    {
      id: 'trim-unicode',
      origin: adversarial('unicode-space', 'U+FEFF, U+3000, U+00A0 and U+2029 around the text are trimmed by JS trim; Rust str::trim keeps U+FEFF'),
      args: ['\uFEFF\u3000\u00A0bad password\u2029\uFEFF'],
      expect: 'out',
    },
    { id: 'trim-not-mongolian', origin: adversarial('unicode-space', 'U+180E is not trimmed by JS'), args: ['\u180Ebad\u180E'], expect: 'out' },
    { id: 'cap-length-at', origin: fixture(LOG_0913, 'exactly 200 units'), args: ['y'.repeat(200)], expect: 'out' },
    { id: 'cap-length-over', origin: fixture(LOG_0913, '201 units'), args: ['y'.repeat(201)], expect: 'out' },
    {
      id: 'cap-length-astral-straddle',
      origin: adversarial('utf16-length', 'an astral character at units 200 and 201: the cut keeps its high surrogate alone'),
      args: ['y'.repeat(199) + '\u{1F600}z'],
      expect: 'out',
    },
    {
      id: 'cap-length-astral-inside',
      origin: adversarial('utf16-length', '100 astral characters are 200 units and are kept whole'),
      args: ['\u{1F600}'.repeat(100) + 'z'],
      expect: 'out',
    },
    {
      id: 'cap-after-mask',
      origin: fixture(LOG_0913, 'the cut counts the text after masking and trimming'),
      args: [`  ${'0123456789abcdef0123 '.repeat(30)}${'w'.repeat(150)}`],
      expect: 'out',
    },
    { id: 'lone-surrogate', origin: adversarial('lone-surrogate', 'a lone surrogate in the text is kept'), args: ['bad \ud800 password'], expect: 'out' },
    { id: 'empty', origin: fixture(LOG_0913, 'an empty reason'), args: [''], expect: 'out' },
  ],
});

const head4096 = (path: string): Origin => fixture(path, 'its first 4096 bytes, as newestClientLog reads the head');
vectorFile({
  area: 'battlenet',
  function: 'isForwarderLog',
  source: SOURCE,
  decode: { 0: 'utf8' },
  note: "arg0 is the head of a client log as newestClientLog reads it: readRange(path, 0, 4096), Buffer toString utf8. The 4096-byte cut is the caller's; a cut through a character decodes to U+FFFD.",
  call: isForwarderLog,
  cases: [
    { id: 'test-forwarder', origin: TF(FORWARDER), args: [text(FORWARDER_LINES.join('\r\n'))], expect: 'out' },
    ...LOGS.map((path) => ({
      id: logId(path),
      origin: head4096(path),
      args: [bytes(bundleBytes(path).subarray(0, 4096))],
      expect: 'out' as const,
    })),
    { id: 'shmem-only', origin: TF(FORWARDER, 'only the shared-memory line'), args: [text(FORWARDER_LINES[3]!)], expect: 'out' },
    { id: 'leaving-only', origin: TF(FORWARDER, 'only the leaving line'), args: [text(FORWARDER_LINES[4]!)], expect: 'out' },
    {
      id: 'server-mode',
      origin: TF(FORWARDER, 'the shared memory opened in server mode'),
      args: [text(FORWARDER_LINES[3]!.replace('mode=client', 'mode=server'))],
      expect: 'out',
    },
    {
      id: 'case-differs',
      origin: TF(FORWARDER, 'the marker in upper case is not matched'),
      args: [text(FORWARDER_LINES[3]!.replace('IPC ShMem mode=client', 'IPC SHMEM MODE=CLIENT'))],
      expect: 'out',
    },
    {
      id: 'marker-split-by-cut',
      origin: TF(FORWARDER, 'the marker cut short by the head read'),
      args: [text(FORWARDER_LINES[3]!.slice(0, -2))],
      expect: 'out',
    },
    { id: 'empty', origin: TF(FORWARDER, 'an empty head'), args: [text('')], expect: 'out' },
  ],
});

const eventsOf = (path: string): LogEvent[] => parseLogEvents(bundleBytes(path).toString('utf8'));
const FAIL_EVENTS = parseLogEvents(FAIL_LINES.join('\r\n'));
const ev = {
  in: (accountId: string, at: string | null = null): LogEvent => ({ kind: 'signed-in', accountId, at }),
  failed: (reason: string): LogEvent => ({ kind: 'sign-in-failed', reason }),
  out: { kind: 'signed-out' } as LogEvent,
  attempt: { kind: 'sign-in-attempt' } as LogEvent,
  exit: { kind: 'exit' } as LogEvent,
};
const eventCases = (): Case[] => [
  ...LOGS.map((path) => ({
    id: logId(path),
    origin: fixture(path, 'parsed by parseLogEvents'),
    args: [eventsOf(path)],
    expect: 'out' as const,
  })),
  { id: 'test-failures', origin: T(FAIL), args: [FAIL_EVENTS], expect: 'out' },
  { id: 'test-first-four', origin: T(FAIL, 'events.slice(0, 4)'), args: [FAIL_EVENTS.slice(0, 4)], expect: 'out' },
  { id: 'test-first-one', origin: T(FAIL, 'events.slice(0, 1)'), args: [FAIL_EVENTS.slice(0, 1)], expect: 'out' },
  { id: 'test-tail', origin: TF(TAIL), args: [parseLogEvents(TAIL_TEXT)], expect: 'out' },
  { id: 'empty', origin: T(FAIL, 'no events'), args: [[]], expect: 'out' },
  { id: 'failed-last', origin: T(FAIL, 'a sign-in, then a failure'), args: [[ev.in('0a1b2c3d'), ev.failed('bad password'), ev.exit]], expect: 'out' },
  {
    id: 'signed-in-after-out',
    origin: T(FAIL, 'a sign-out, then a sign-in'),
    args: [[ev.out, ev.in('0a1b2c3d', '2026-09-13T03:21:00.000Z'), ev.attempt]],
    expect: 'out',
  },
  { id: 'out-after-failure', origin: T(FAIL, 'a failure, then a sign-out'), args: [[ev.failed('bad password'), ev.out]], expect: 'out' },
  { id: 'attempts-only', origin: T(FAIL, 'attempts and an exit only'), args: [[ev.attempt, ev.attempt, ev.exit]], expect: 'out' },
  { id: 'empty-account-id', origin: T(FAIL, 'a sign-in whose account id did not parse'), args: [[ev.in('')]], expect: 'out' },
];

vectorFile({
  area: 'battlenet',
  function: 'lastSignIn',
  source: SOURCE,
  note: 'arg0 is the event list parseLogEvents returns, in memory; fixture cases are parseLogEvents(fixture) computed by the generator (the same out as parseLogEvents.json).',
  call: lastSignIn,
  cases: eventCases,
});

vectorFile({
  area: 'battlenet',
  function: 'endedSignedOut',
  source: SOURCE,
  note: 'arg0 is the event list parseLogEvents returns, in memory; fixture cases are parseLogEvents(fixture) computed by the generator. A failure does not decide it; only sign-outs and sign-ins do.',
  call: endedSignedOut,
  cases: eventCases,
});
