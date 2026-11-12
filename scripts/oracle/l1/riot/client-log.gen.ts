import { adversarial, bundleBytes, bytes, corpus, file, fixture, fromTest, text, vectorFile, type Case } from '../lib/index';
import { MAX_LOG_LINE_LENGTH } from '../../../../src/main/launchers/log-read';
import { parseLogEvents } from '../../../../src/main/launchers/riot/client-log';

const DIR = 'fixtures/launchers/riot';
const RESTORED = `${DIR}/2026-10-04T20-34-14_10001_Riot Client.log`;
const MANUAL = `${DIR}/2026-10-04T20-56-32_10002_Riot Client.log`;
const REJECTED = `${DIR}/2026-10-04T20-42-52_10003_Riot Client.log`;
const LAUNCH_77 = `${DIR}/2026-01-14T19-01-46_10004_Riot Client.log`;
const FORWARDED_140 = `${DIR}/2026-10-07T17-26-29_10005_Riot Client.log`;
const BOOT_140 = `${DIR}/2026-10-07T20-51-16_10006_Riot Client.log`;
const STUB_140 = `${DIR}/2026-10-07T17-27-00_1234_Riot Client.log`;
const LOGS = [RESTORED, MANUAL, REJECTED, LAUNCH_77, FORWARDED_140, BOOT_140, STUB_140];

const TESTS = 'test/riot-client-log.test.ts';
const PARSER = 'Riot client log parser';
const t = (...titles: string[]) => fromTest(TESTS, PARSER, ...titles);
const T_PER_PRODUCT = 'tells a launch the client took from one it started, per product, and reads which products need an update';
const T_BOOT = 'reads a build 140 start with the arguments: the context taken back by the auto-launch flag, the sign-in, the page, no game (fixture)';
const T_LATEST = 'gives the transitions and refusals, which name no product, to the product whose lines are the latest to name one';
const T_116 = 'recognises the other verdict lines of builds up to 116 and the patch state with its launchable flag';
const T_AUTH = 'tells a refused session from another auth error, and a restore that reached the login page without a verdict';
const T_SHAPE = 'parses only lines in the client’s shape and ignores everything else';
const T_STUB = 'skips the stub a second process leaves behind, so the run that is still writing stays current';
const T_NEWEST = 'picks the newest run by name and reads only what a new run or new bytes add';
const T_TAIL = 'reads the end of a log that is larger than one read, so the newest verdict decides';

const line = (level: string, body: string): string => `000010.000|${level.padStart(7)}| ${body}`;
const state = (name: string): string => line('ALWAYS', `riot-client-lifecycle: PSLProvider: PSL state changed to ${name}`);
const context = (product: string): string => line('ALWAYS', `riot-client-lifecycle: Setting product context to ${product}.live, willAutoLaunch=false`);
const transition = (from: string, to: string): string => line('ALWAYS', `riot-client-lifecycle: Context #1: Middleware transition (${from}) -> (${to})`);
const starting = (product: string): string => line('OKAY', `product-launcher: Launch starting: productId='${product}' patchlineId='live'`);
const declined = (reason: string): string =>
  line('ALWAYS', `riot-client-lifecycle: Client is already running. Explicitly request focus instead of launching (${reason})`);
const bootVerdict = (reason: string): string => line('OKAY', `riot-client-lifecycle: Attempting to launch default product with reason (${reason})`);
const start = [state('PendingInitialization'), state('PendingClientId'), state('PendingPersistenceInitialization')];
const crlf = (lines: string[]) => text(lines.join('\r\n'));
const lf = (lines: string[]) => text(lines.join('\n'));
const swapEol = (data: Buffer): Buffer => {
  const s = data.toString('latin1');
  return Buffer.from(s.includes('\r\n') ? s.replace(/\r\n/g, '\n') : s.replace(/\n/g, '\r\n'), 'latin1');
};

const PSL_TEXT = 'riot-client-lifecycle: PSLProvider: PSL state changed to PendingLoginStrategy';
const PREFIX = line('ALWAYS', '');
/** A PSL line padded before its text so that its UTF-16 length is `units`, the padding made of `unit` (one or two code units each) and ASCII x. */
function paddedLine(units: number, unit: string): string {
  const room = units - PREFIX.length - PSL_TEXT.length - 1;
  const n = Math.floor(room / unit.length);
  return `${PREFIX}${unit.repeat(n)}${'x'.repeat(room - n * unit.length)} ${PSL_TEXT}`;
}
const after = state('PendingProductContext');

const fixtureCases: Case[] = LOGS.map((path) => ({
  id: `fixture-${path
    .split('/')
    .pop()!
    .replace(/_Riot Client\.log$/, '')
    .toLowerCase()}`,
  origin: fixture(path),
  args: [file(path)],
  expect: 'out' as const,
}));

const tailContent = `${state('PendingLoginStrategy')}\r\n${`${line('OKAY', 'SDK: chatter')}\r\n`.repeat(40)}${state('PendingEulaData')}\r\n${state('PendingProductContext')}\r\n`;
const tailBytes = (() => {
  const all = Buffer.from(tailContent);
  const clipped = all.subarray(all.length - 200);
  return clipped.subarray(clipped.indexOf(0x0a) + 1);
})();

const reason80 = 'r'.repeat(80);

vectorFile({
  area: 'riot',
  function: 'parseLogEvents',
  source: 'src/main/launchers/riot/client-log.ts',
  decode: { 0: 'utf8' },
  note: [
    "arg0 is a Riot Client run log as src/main/launchers/riot/client-log.ts reads it (readRange / readTail in src/main/launchers/log-read.ts: Buffer.toString('utf8'); a BOM stays as U+FEFF, invalid bytes become U+FFFD).",
    'The readers cap what they hand over (readLogSince keeps the last 8 MiB and drops a clipped first line, currentRunBuild reads 512 bytes); the function relies on that and enforces only its own line cap.',
    `Caps the function enforces: a line longer than MAX_LOG_LINE_LENGTH (${MAX_LOG_LINE_LENGTH}) UTF-16 code units is skipped (cap-line-*), and a launch-declined reason is 1 to 80 UTF-16 code units ([^()]{1,80} without the u flag; cap-reason-*).`,
    'All seven fixture logs are cases (fixture-*), each as the file the bundle holds.',
    'The regexes have no u flag: \\d is ASCII, \\s is JS whitespace (U+FEFF yes, U+0085 no), `.` stops at CR, LF, U+2028 and U+2029, `$` is the end of the line string, and /i folds ASCII only. The adv-* cases aim at each difference from Rust regex defaults.',
  ].join('\n'),
  call: parseLogEvents,
  cases: [
    ...fixtureCases,
    {
      id: 'fixture-restored-bom',
      origin: fixture(RESTORED, 'UTF-8 BOM added: the first line no longer starts with the timestamp'),
      args: [bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bundleBytes(RESTORED)]))],
      expect: 'out',
    },
    { id: 'fixture-restored-lf', origin: fixture(RESTORED, 'CRLF made LF'), args: [bytes(swapEol(bundleBytes(RESTORED)))], expect: 'out' },
    { id: 'fixture-boot-140-crlf', origin: fixture(BOOT_140, 'LF made CRLF'), args: [bytes(swapEol(bundleBytes(BOOT_140)))], expect: 'out' },
    {
      id: 'fixture-forwarded-140-head',
      origin: t('log files', T_STUB),
      args: [bytes(Buffer.from(bundleBytes(FORWARDED_140).toString('utf8').split('\n').slice(0, 3).join('\n')))],
      expect: 'out',
    },
    {
      id: 'patched',
      origin: t(T_PER_PRODUCT),
      args: [
        crlf([
          line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: OutOfDate, progress: 0'),
          line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: league_of_legends, patchlineId: live, status: UpToDate, progress: 0'),
          line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: UpToDate, progress: 0'),
          line(
            'OKAY',
            'patch-proxy: ProductPatchline: UpdateCombinedProductStatus state for bacon.live changed from CheckingForUpdate to UpToDate, launchable: 0',
          ),
          line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: lion, patchlineId: live, status: OutOfDate, progress: 0'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'bare-start-reason',
      origin: t(T_BOOT),
      args: [
        crlf([
          bootVerdict('No product context or launch arguments specified at boot'),
          line('ALWAYS', 'riot-client-lifecycle: Setting product context to valorant.live, willAutoLaunch=false'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'two-products',
      origin: t(T_LATEST),
      args: [
        crlf([
          context('valorant'),
          transition('RestartRequired', 'WaitForLaunch'),
          declined('Product is not up to date'),
          context('league_of_legends'),
          transition('RestartRequired', 'WaitForLaunch'),
          declined('Auto-launch is disabled'),
          starting('league_of_legends'),
          transition('WaitForLaunch', 'WaitForSessionExit'),
        ]),
      ],
      expect: 'out',
    },
    { id: 'valorant-back', origin: t(T_LATEST), args: [crlf([starting('valorant'), transition('WaitForLaunch', 'WaitForSessionExit')])], expect: 'out' },
    {
      id: 'verdicts-116',
      origin: t(T_116),
      args: [
        crlf([
          line('OKAY', 'SDK: riot-login: RiotLoginPlugin::OnConfigReady'),
          line('ERROR', 'SDK: riot-login: Did not restore persistent session state: Failed to authenticate with persisted login state'),
          line(
            'OKAY',
            'patch-proxy: ProductPatchline: UpdateCombinedProductStatus state for valorant.live changed from CheckingForUpdate to OutOfDate, launchable: 0',
          ),
          line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: OutOfDate, progress: 0'),
          line('ALWAYS', 'riot-client-lifecycle: Setting product context to lion.live, willAutoLaunch=true'),
          line('OKAY', 'SDK: riot-login: Persisting 6 RSO auth cookies: tdid asid clid ssid sub csid and 0 RSO auth scopes: '),
          line(
            'OKAY',
            'SDK: riot-login: Persisting 5 RSO auth cookies: tdid ssid sub csid clid and 7 RSO auth scopes: openid link ban lol_region lol summoner offline_access',
          ),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'verdicts-older',
      origin: t(T_116),
      args: [
        lf([
          line(
            'ERROR',
            'SDK: riot-login: Did not restore persistent session state: Failed to login with persisted login state: Error response for POST /rso-auth/v2/authorizations: in plugin endpoint function RequestAuthorization',
          ),
          line('OKAY', 'SDK: riot-login: Persisting 1 RSO auth cookies: tdid and 0 RSO auth scopes: '),
          line('OKAY', 'SDK: riot-login: Did not restore persistent session state: No stored session exists'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'auth-error-other',
      origin: t(T_AUTH),
      args: [
        crlf([
          ...start,
          line(
            'ERROR',
            "SDK: rso-auth: error 'authorization_creation_failure_network_error': in plugin library function HandleAuthorizationCreate: Failed to create RSO authorization (503) service_unavailable: ",
          ),
          state('RestoreAuthorization'),
          state('PendingLoginStrategy'),
        ]),
      ],
      expect: 'out',
    },
    { id: 'restore-silent', origin: t(T_AUTH), args: [crlf([...start, state('RestoreAuthorization'), state('PendingLoginStrategy')])], expect: 'out' },
    {
      id: 'error-words-at-okay',
      origin: t(T_AUTH),
      args: [
        lf([
          ...start,
          line('OKAY', "SDK: rso-auth: error 'authorization_creation_failure_request_error' was cleared"),
          state('RestoreAuthorization'),
          state('PendingEulaData'),
          state('PendingProductContext'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'manual-after-rejection',
      origin: t(T_AUTH),
      args: [
        lf([
          ...start,
          line('ERROR', "SDK: rso-auth: error 'authorization_creation_failure_request_error': Failed to create RSO authorization (401) invalid_grant: "),
          state('RestoreAuthorization'),
          state('PendingLoginStrategy'),
          line('OKAY', 'SDK: rso-auth: Using direct token exchange'),
          state('LoginTokenExchange'),
          state('PendingEulaData'),
          state('PendingEulaAcceptance'),
        ]),
      ],
      expect: 'out',
    },
    { id: 'restore-unfinished', origin: t(T_AUTH), args: [lf([...start, state('RestoreAuthorization')])], expect: 'out' },
    { id: 'empty', origin: t(T_SHAPE), args: [text('')], expect: 'out' },
    {
      id: 'only-client-shape',
      origin: t(T_SHAPE),
      args: [
        crlf([
          'riot-client-lifecycle: PSLProvider: PSL state changed to PendingProductContext',
          '    --launch-patchline=live',
          'Logging started at 2026-10-04T20:34:14.123',
          '000000.000| ALWAYS| Application Version: 140.0.6.5027',
          '000001.000| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to Pending Product Context',
          '000001.000| ALWAYS| riot-client-lifecycle: Setting product context to valorant, willAutoLaunch=true',
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'appended-lines',
      origin: t('log files', T_NEWEST),
      args: [text(`${state('LoginTokenExchange')}\r\n${state('PendingProductContext')}\r\n`)],
      expect: 'out',
    },
    { id: 'tail-file-whole', origin: t('log files', T_TAIL), args: [text(tailContent)], expect: 'out' },
    {
      id: 'tail-200-bytes',
      origin: t('log files', `${T_TAIL} | the text readLogSince hands over with maxBytes 200: the last 200 bytes from the first full line`),
      args: [bytes(tailBytes)],
      expect: 'out',
    },
    {
      id: 'long-line-skipped',
      origin: fromTest(
        'test/parse-limits.test.ts',
        'launcher files of a size or shape no launcher writes (H16)',
        'skips a log line longer than any launcher writes and still reads the lines around it',
      ),
      args: [
        crlf([
          `000001.000| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to ${'x'.repeat(MAX_LOG_LINE_LENGTH + 1)}`,
          '000001.001| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to PendingLoginStrategy',
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'cap-line-at',
      origin: fixture(RESTORED, `one PSL line padded to exactly ${MAX_LOG_LINE_LENGTH} code units, then another`),
      args: [crlf([paddedLine(MAX_LOG_LINE_LENGTH, 'x'), after])],
      expect: 'out',
    },
    {
      id: 'cap-line-over',
      origin: fixture(RESTORED, `one PSL line padded to ${MAX_LOG_LINE_LENGTH + 1} code units, then another`),
      args: [crlf([paddedLine(MAX_LOG_LINE_LENGTH + 1, 'x'), after])],
      expect: 'out',
    },
    {
      id: 'cap-line-astral-at',
      origin: adversarial(
        'utf16-length',
        `a PSL line of exactly ${MAX_LOG_LINE_LENGTH} UTF-16 code units padded with astral characters (two units, one char, four bytes each): kept`,
      ),
      args: [crlf([paddedLine(MAX_LOG_LINE_LENGTH, '\u{1F600}'), after])],
      expect: 'out',
    },
    {
      id: 'cap-line-astral-over',
      origin: adversarial(
        'utf16-length',
        `a PSL line of ${MAX_LOG_LINE_LENGTH + 1} UTF-16 code units but fewer chars, padded with astral characters: skipped, though a char count would keep it`,
      ),
      args: [crlf([paddedLine(MAX_LOG_LINE_LENGTH + 1, '\u{1F600}'), after])],
      expect: 'out',
    },
    {
      id: 'cap-line-bytes-at',
      origin: adversarial(
        'utf16-length',
        `a PSL line of exactly ${MAX_LOG_LINE_LENGTH} code units padded with two-byte é: kept, though it is far over the cap in UTF-8 bytes`,
      ),
      args: [crlf([paddedLine(MAX_LOG_LINE_LENGTH, '\u00e9'), after])],
      expect: 'out',
    },
    {
      id: 'cap-reason-at',
      origin: fixture(FORWARDED_140, 'a refusal whose reason is 80 characters'),
      args: [crlf([context('valorant'), declined(reason80)])],
      expect: 'out',
    },
    {
      id: 'cap-reason-over',
      origin: fixture(FORWARDED_140, 'a refusal whose reason is 81 characters'),
      args: [crlf([context('valorant'), declined(`${reason80}r`)])],
      expect: 'out',
    },
    {
      id: 'cap-reason-astral-at',
      origin: adversarial('utf16-length', 'a refusal reason of 78 ASCII and one astral character: 80 code units, matched'),
      args: [crlf([context('valorant'), declined(`${'r'.repeat(78)}\u{1F600}`)])],
      expect: 'out',
    },
    {
      id: 'cap-reason-astral-over',
      origin: adversarial('utf16-length', 'a refusal reason of 79 ASCII and one astral character: 80 chars but 81 code units, not matched in JS'),
      args: [crlf([context('valorant'), declined(`${'r'.repeat(79)}\u{1F600}`)])],
      expect: 'out',
    },
    {
      id: 'cap-boot-reason-at',
      origin: fixture(BOOT_140, 'the boot verdict with an 80-character reason'),
      args: [crlf([bootVerdict(reason80)])],
      expect: 'out',
    },
    {
      id: 'cap-boot-reason-over',
      origin: fixture(BOOT_140, 'the boot verdict with an 81-character reason'),
      args: [crlf([bootVerdict(`${reason80}r`)])],
      expect: 'out',
    },
    {
      id: 'reason-empty',
      origin: fixture(FORWARDED_140, 'a refusal with an empty reason and one with a parenthesis inside'),
      args: [crlf([context('valorant'), declined(''), declined('a (b) c')])],
      expect: 'out',
    },
    {
      id: 'launch-args',
      origin: fixture(
        LAUNCH_77,
        'the command line echo cut down: product and patchline, the SDKModule echo again, then a product alone, a patchline alone, and upper-case flags',
      ),
      args: [
        crlf([
          line('ALWAYS', 'Command Line Arguments (Riot Client App):'),
          '    --launch-product=valorant',
          '    --launch-patchline=live',
          '    --app-root=C:/Riot Games/Riot Client',
          line('ALWAYS', 'Command Line Arguments (SDKModule):'),
          '    --launch-product=valorant',
          '    --launch-patchline=live',
          line('ALWAYS', 'Command Line Arguments (Riot Client App):'),
          '\t--launch-product=bacon  ',
          line('ALWAYS', 'Command Line Arguments (Riot Client App):'),
          '    --launch-patchline=pbe',
          line('ALWAYS', 'Command Line Arguments (Riot Client App):'),
          '    --LAUNCH-PRODUCT=VALORANT',
          '    --Launch-Patchline=PBE',
          '    --launch-product=lion',
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'launch-args-unflushed-forms',
      origin: fixture(LAUNCH_77, 'launch arguments with no indent, with a space before the value, with a dash in the value'),
      args: [
        lf([
          '--launch-product=valorant',
          '    --launch-product= valorant',
          '    --launch-product=val-orant',
          '    --launch-product=',
          '    --launch-product=ok',
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'started-and-version',
      origin: fixture(RESTORED, 'the first two lines in other orders and forms'),
      args: [
        crlf([
          line('ALWAYS', 'Application Version: 140.0.6.5027'),
          line('ALWAYS', 'Logging started at 2026-10-04T20:34:14'),
          line('ALWAYS', 'Application Version: 140.0.6.5027.1'),
          line('ALWAYS', 'Application Version: 140.0.6.5027'),
          line('ALWAYS', 'Logging started at 2026-10-04T20:34:14.123456 local'),
          line('ALWAYS', 'Application Version: 140.0.6.5027a'),
          line('ALWAYS', 'Application Version: 141'),
          line('ALWAYS', 'Logging started at 2026-10-04 20:34:14'),
          line('ALWAYS', 'Application Version: v140'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'dedupe',
      origin: fixture(MANUAL, 'events repeated back to back, of the kinds that count once and the kinds that do not'),
      args: [
        crlf([
          state('PendingEulaData'),
          state('PendingEulaData'),
          line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key rso-authenticator.tdid'),
          line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key rso-authenticator.tdid'),
          line('OKAY', 'SDK: rso-auth: Using direct token exchange'),
          line('OKAY', 'SDK: rso-auth: Using direct token exchange'),
          line('OKAY', 'SDK: riot-client-auth: Deleted current RSO authorization.'),
          line('OKAY', 'SDK: rso-auth: Successfully deleted RSO authorization.'),
          transition('A', 'B'),
          transition('A', 'B'),
          context('valorant'),
          context('valorant'),
          line('OKAY', 'riot-client-lifecycle: Attempting to quit'),
          line('OKAY', 'riot-client-lifecycle: Attempting to quit. SwitchToBackgroundMode: False'),
          line('ALWAYS', 'ProcessSingleton: Removal of LockFile complete'),
          line('ALWAYS', 'ProcessSingleton: Removal of LockFile complete'),
          state('PendingEulaData'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'rso-errors',
      origin: fixture(REJECTED, 'the rso-auth error line with other codes and grants'),
      args: [
        crlf([
          line('ERROR', "SDK: rso-auth: error 'authorization_creation_failure_request_error': Failed to create RSO authorization (400) invalid_grant: "),
          line('ERROR', "SDK: rso-auth: error 'authorization_creation_failure_request_error': Failed to create RSO authorization (401) invalid_grant_type"),
          line('ERROR', "SDK: rso-auth: error 'authorization_creation_failure_request_error': Failed to create RSO authorization (401) invalid_client"),
          line('ERROR', "SDK: rso-auth: error 'x': Failed to create RSO authorization (4011) invalid_grant"),
          line('ERROR', "SDK: rso-auth: error 'Upper_Case': Failed to create RSO authorization (401) invalid_grant"),
          line('WARN', "SDK: rso-auth: error 'authorization_creation_failure_request_error': Failed to create RSO authorization (401) invalid_grant"),
          line('ERROR', 'SDK: rso-auth: error authorization_creation_failure_request_error: no quotes'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'non-error-rso-falls-through',
      origin: fixture(REJECTED, 'an rso-auth error at OKAY on a line that also says the settings were written'),
      args: [crlf([line('OKAY', "rso-auth: error 'x' private-settings: Updated private settings for user localuser with key psl.authorization.riot-client")])],
      expect: 'out',
    },
    {
      id: 'cookies-persisted-numbers',
      origin: adversarial(
        'parseint',
        'Persisting lines with 00 scopes (Number gives 0) and a scope count past 2^64; only a count above zero is a sign-in, and only when the last verdict is not one',
      ),
      args: [
        crlf([
          line('OKAY', 'SDK: riot-login: Persisting 1 RSO auth cookies: tdid and 00 RSO auth scopes: '),
          line('OKAY', 'SDK: riot-login: Persisting 5 RSO auth cookies: tdid ssid and 18446744073709551616 RSO auth scopes: openid'),
          line('OKAY', 'SDK: riot-login: Persisting 5 RSO auth cookies: tdid ssid and 7 RSO auth scopes: openid'),
          line('OKAY', 'SDK: riot-login: Did not restore persistent session state: No stored session exists'),
          line('OKAY', 'SDK: riot-login: Persisting 5 RSO auth cookies: tdid ssid and 7 RSO auth scopes: openid'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'game-session-and-patch',
      origin: fixture(LAUNCH_77, 'the session-ended line, a launchable 1 patch state and upper-case ids'),
      args: [
        crlf([
          line('OKAY', 'product-launcher: Session for VALORANT on patchline LIVE has ended after 3743783ms'),
          line(
            'OKAY',
            'patch-proxy: ProductPatchline: UpdateCombinedProductStatus state for Bacon.Live changed from CheckingForUpdate to UpToDate, launchable: 1',
          ),
          line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: LION, patchlineId: PBE, status: DependencyUpdate, progress: 50'),
          line('OKAY', "product-launcher: Launch starting: productId='VALORANT' patchlineId='PBE'"),
          line('ALWAYS', 'riot-client-lifecycle: Setting product context to VALORANT.LIVE, willAutoLaunch=TRUE'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'line-shape-variants',
      origin: fixture(RESTORED, 'the timestamp and level in shapes the prefix pattern accepts and refuses'),
      args: [
        crlf([
          '000010.000|ALWAYS|riot-client-lifecycle: PSLProvider: PSL state changed to A',
          '000010.000|  ALWAYS|  riot-client-lifecycle: PSLProvider: PSL state changed to B',
          '000010.000| Always| riot-client-lifecycle: PSLProvider: PSL state changed to C',
          '0000010.000| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to D',
          '000010.00| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to E',
          '000010.000| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to F   ',
          '000010.000| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to G1',
          '000010.000| ALWAYS| Logging started at 2026-10-04T20:34:14.123',
          '000010.000| ALWAYS|  Logging started at 2026-10-04T20:34:14.123',
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'telemetry-any-case',
      origin: fixture(RESTORED, 'a PSL line that mentions TELEMETRY in capitals is skipped like a telemetry line'),
      args: [
        crlf([
          state('PendingInitialization TELEMETRY'),
          line('OKAY', 'Telemetry: riot-client-lifecycle: PSLProvider: PSL state changed to X'),
          state('PendingClientId'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'adv-cr-cr-lf',
      origin: adversarial(
        'regex',
        'lines ended by CR CR LF: the split leaves a CR at the end, the JS `.` of the prefix pattern stops there and `$` cannot match, so every line is dropped; a Rust `.` takes the CR',
      ),
      args: [text(`${state('PendingInitialization')}\r\r\n${state('PendingLoginStrategy')}\r\r\n`)],
      expect: 'out',
    },
    {
      id: 'adv-lone-cr',
      origin: adversarial('regex', 'two client lines joined by a lone CR: one line to the split, which the JS prefix pattern refuses at the CR'),
      args: [text(`${state('PendingInitialization')}\r${state('PendingLoginStrategy')}\n${state('PendingProductContext')}`)],
      expect: 'out',
    },
    {
      id: 'adv-line-separator',
      origin: adversarial('regex', 'U+2028 and U+2029 inside a line: JS `.` does not match them, so the line is dropped; Rust `.` does'),
      args: [crlf([line('OKAY', 'SDK: chatter \u2028 more'), state('PendingClientId\u2029'), state('PendingProductContext')])],
      expect: 'out',
    },
    {
      id: 'adv-unicode-digit-timestamp',
      origin: adversarial('unicode-digit', 'the timestamp in Arabic-Indic digits and fullwidth digits: JS \\d refuses both'),
      args: [
        crlf([
          `\u0660\u0660\u0660\u0660\u0661\u0660.\u0660\u0660\u0660| ALWAYS| ${PSL_TEXT}`,
          `\uff10\uff10\uff10\uff10\uff11\uff10.000| ALWAYS| ${PSL_TEXT}`,
          state('PendingProductContext'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'adv-unicode-digit-version',
      origin: adversarial('unicode-digit', 'a build number in Arabic-Indic digits, and an rso-auth status of Devanagari digits: JS \\d refuses them'),
      args: [
        crlf([
          line('ALWAYS', 'Application Version: \u0661\u0664\u0660.0.6'),
          line(
            'ERROR',
            "SDK: rso-auth: error 'authorization_creation_failure_request_error': Failed to create RSO authorization (\u0664\u0660\u0661) invalid_grant",
          ),
          line('OKAY', 'SDK: riot-login: Persisting 5 RSO auth cookies: tdid and \u0667 RSO auth scopes: openid'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'adv-word-boundary-version',
      origin: adversarial(
        'word-boundary',
        'a build followed by é: JS \\b is ASCII, so it falls after the last digit and the build is 140.0.6.5027; a Unicode \\b sees é as a word character and backs off to 140.0.6',
      ),
      args: [crlf([line('ALWAYS', 'Application Version: 140.0.6.5027\u00e9'), line('ALWAYS', 'Application Version: 141.2\u0663')])],
      expect: 'out',
    },
    {
      id: 'adv-space-feff',
      origin: adversarial(
        'unicode-space',
        'U+FEFF where the patterns allow \\s: before the level, after a PSL state, before a launch argument; JS \\s matches U+FEFF, Rust \\s does not',
      ),
      args: [crlf([`000010.000|\ufeffALWAYS| ${PSL_TEXT}`, state('PendingClientId\ufeff'), '\ufeff--launch-product=valorant', line('OKAY', 'x')])],
      expect: 'out',
    },
    {
      id: 'adv-space-nel',
      origin: adversarial('unicode-space', 'U+0085 where the patterns allow \\s: JS \\s does not match it, Rust \\s does'),
      args: [crlf([`000010.000|\u0085ALWAYS| ${PSL_TEXT}`, state('PendingClientId\u0085'), '\u0085--launch-product=valorant', line('OKAY', 'x')])],
      expect: 'out',
    },
    {
      id: 'adv-space-nbsp-ideographic',
      origin: adversarial('unicode-space', 'U+00A0 and U+3000 where the patterns allow \\s: both JS and Unicode \\s match them'),
      args: [crlf([`000010.000|\u00a0ALWAYS|\u3000${PSL_TEXT}`, state('PendingClientId\u3000'), '\u00a0--launch-product=valorant\u3000', line('OKAY', 'x')])],
      expect: 'out',
    },
    {
      id: 'adv-case-fold-long-s-kelvin',
      origin: adversarial(
        'case-mapping',
        'ids with U+017F (long s) and U+212A (Kelvin) under /i: JS without the u flag folds ASCII only and refuses them; Rust (?i) folds them to s and k',
      ),
      args: [
        crlf([
          line('ALWAYS', 'riot-client-lifecycle: Setting product context to teamfighttactic\u017f.live, willAutoLaunch=true'),
          line('ALWAYS', 'Command Line Arguments (Riot Client App):'),
          '    --launch-product=\u212ayn',
          line('OKAY', "product-launcher: Launch starting: productId='bacon' patchlineId='\u017fandbox'"),
          line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: lion, patchlineId: live, status: Up\u017ftream, progress: 0'),
          line('OKAY', 'product-launcher: Session for \u212aestrel on patchline live has ended'),
        ]),
      ],
      expect: 'out',
    },
    {
      id: 'adv-case-dotted-i',
      origin: adversarial('case-mapping', 'an id with U+0130 (dotted capital I) under /i: refused by JS; toLowerCase would turn it into two code units'),
      args: [
        crlf([line('ALWAYS', 'riot-client-lifecycle: Setting product context to valorant.l\u0130ve, willAutoLaunch=false'), '    --launch-product=\u0130con']),
      ],
      expect: 'out',
    },
    {
      id: 'adv-invalid-utf8',
      origin: adversarial(
        'utf8-decode',
        'invalid bytes in a PSL state, a product id and a settings key; each maximal invalid subsequence becomes one U+FFFD and the patterns refuse the line',
      ),
      args: [
        bytes(
          Buffer.concat([
            Buffer.from(`${state('Pending')}`),
            Buffer.from([0xff]),
            Buffer.from(`Login\r\n${line('ALWAYS', 'riot-client-lifecycle: Setting product context to valo')}`),
            Buffer.from([0xc3, 0x28]),
            Buffer.from(
              `rant.live, willAutoLaunch=true\r\n${line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key psl.')}`,
            ),
            Buffer.from([0xf0, 0x9f, 0x98]),
            Buffer.from(`x\r\n${state('PendingProductContext')}`),
          ]),
        ),
      ],
      expect: 'out',
    },
    {
      id: 'adv-invalid-utf8-user',
      origin: adversarial('utf8-decode', 'an invalid byte in the user name of a settings-written line: \\S matches U+FFFD, so the event stands'),
      args: [
        bytes(
          Buffer.concat([
            Buffer.from(line('OKAY', 'SDK: private-settings: Updated private settings for user local')),
            Buffer.from([0x80]),
            Buffer.from('user with key rso-authenticator.tdid'),
          ]),
        ),
      ],
      expect: 'out',
    },
    ...corpus({ seed: 31, count: 40, from: LOGS.map((path) => ({ path })), args: (mutated) => [mutated] }),
  ],
});
