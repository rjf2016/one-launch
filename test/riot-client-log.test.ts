import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_LOG_FILE,
  clientLogDir,
  currentRunBuild,
  currentRunEvents,
  eventsSince,
  exitedCleanly,
  gameStarted,
  lastSignIn,
  launchAccepted,
  launchDeclined,
  launchPageShown,
  launchRequest,
  logMark,
  newestClientLog,
  parseLogEvents,
  patchStates,
  productNeedsUpdate,
  productsNeedingUpdate,
  readLogSince,
  startupFinished,
  type LogEvent,
} from '../src/main/launchers/riot/client-log';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'riot', name), 'utf8');
const RESTORED = '2026-10-04T20-34-14_10001_Riot Client.log';
const MANUAL = '2026-10-04T20-56-32_10002_Riot Client.log';
const REJECTED = '2026-10-04T20-42-52_10003_Riot Client.log';
const LAUNCH_77 = '2026-01-14T19-01-46_10004_Riot Client.log';
const FORWARDED_140 = '2026-10-07T17-26-29_10005_Riot Client.log';
const BOOT_140 = '2026-10-07T20-51-16_10006_Riot Client.log';
/** The second process a shortcut starts while the client runs: it hands over its command line and exits, and its log is not a run. */
const STUB_140 = '2026-10-07T17-27-00_1234_Riot Client.log';

const line = (level: string, body: string): string => `000010.000|${level.padStart(7)}| ${body}`;
const state = (name: string): string => line('ALWAYS', `riot-client-lifecycle: PSLProvider: PSL state changed to ${name}`);
const indexOf = (events: readonly LogEvent[], pred: (e: LogEvent) => boolean, nth = 1): number => {
  let seen = 0;
  for (let i = 0; i < events.length; i++) if (pred(events[i]!) && ++seen === nth) return i;
  throw new Error('event not found');
};
const upTo = (events: readonly LogEvent[], i: number): LogEvent[] => events.slice(0, i + 1);

describe('Riot client log parser', () => {
  it('reads a build 140 run that signed in from the saved session and was closed by its core (fixture)', () => {
    const events = parseLogEvents(fixture(RESTORED));
    expect(events).toEqual([
      { kind: 'started', at: '2026-10-04T20:34:14.123', build: '140.0.6.5027' },
      { kind: 'psl-state', state: 'PendingInitialization' },
      { kind: 'psl-state', state: 'PendingClientId' },
      { kind: 'psl-state', state: 'PendingPersistenceInitialization' },
      { kind: 'psl-state', state: 'RestoreAuthorization' },
      { kind: 'psl-state', state: 'PendingEulaData' },
      { kind: 'settings-written', key: 'psl.authorization.riot-client' },
      { kind: 'psl-state', state: 'PendingEulaData' },
      { kind: 'psl-state', state: 'PendingPersistentFlagsData' },
      { kind: 'psl-state', state: 'PendingProductContext' },
      { kind: 'settings-written', key: 'rso-authenticator.tdid' },
      { kind: 'patch-state', product: 'valorant', patchline: 'live', status: 'UpToDate', launchable: null },
      { kind: 'quit' },
      { kind: 'exit' },
    ]);
    expect(lastSignIn(events)).toEqual({ ok: true, how: 'restored' });
    expect(startupFinished(events)).toBe(true);
    expect(exitedCleanly(events)).toBe(true);
    expect(launchRequest(events)).toBeNull();
    expect(patchStates(events)).toEqual(new Map([['valorant.live', { status: 'UpToDate', launchable: null }]]));
    // Still working: no verdict yet.
    expect(
      lastSignIn(
        upTo(
          events,
          indexOf(events, (e) => e.kind === 'psl-state' && e.state === 'RestoreAuthorization'),
        ),
      ),
    ).toBeNull();
    expect(startupFinished(events.slice(0, 5))).toBe(false);
    expect(exitedCleanly(events.slice(0, -1))).toBe(false);
  });

  it('skips telemetry lines and never carries a raw line: no token, no path, no session id in the events', () => {
    const text = fixture(RESTORED);
    expect(text).toContain('telemetry:');
    expect(text).toContain('eyJ');
    expect(text).toContain('Placeholder');
    const json = JSON.stringify(parseLogEvents(text));
    for (const leak of ['eyJ', 'PLACEHOLDER', 'Placeholder', '00000000-0000', 'telemetry', 'C:/', 'lockfile']) expect(json).not.toContain(leak);
  });

  it('follows a run that started signed out, signed in by hand, signed out, and signed in again (fixture)', () => {
    const events = parseLogEvents(fixture(MANUAL));
    expect(events.map((e) => e.kind)).toEqual([
      'started',
      'psl-state',
      'psl-state',
      'settings-written',
      'psl-state',
      'psl-state',
      'settings-written',
      'manual-sign-in',
      'settings-written',
      'psl-state',
      'psl-state',
      'psl-state',
      'psl-state',
      'settings-written',
      'settings-written',
      'settings-written',
      'signed-out',
      'psl-state',
      'settings-written',
      'settings-written',
      'psl-state',
      'psl-state',
      'psl-state',
      'settings-written',
      'manual-sign-in',
      'settings-written',
      'psl-state',
      'settings-written',
      'psl-state',
      'psl-state',
      'psl-state',
      'settings-written',
      'quit',
      'exit',
    ]);
    expect(lastSignIn(events)).toEqual({ ok: true, how: 'manual' });
    const loginPage = (nth: number): number => indexOf(events, (e) => e.kind === 'psl-state' && e.state === 'PendingLoginStrategy', nth);
    expect(lastSignIn(upTo(events, loginPage(1)))).toEqual({ ok: false, reason: 'no-session', detail: 'no saved sign-in' });
    expect(
      lastSignIn(
        upTo(
          events,
          indexOf(events, (e) => e.kind === 'psl-state' && e.state === 'PendingProductContext'),
        ),
      ),
    ).toEqual({ ok: true, how: 'manual' });
    expect(
      lastSignIn(
        upTo(
          events,
          indexOf(events, (e) => e.kind === 'signed-out'),
        ),
      ),
    ).toEqual({ ok: false, reason: 'signed-out', detail: 'signed out' });
    expect(lastSignIn(upTo(events, loginPage(2)))).toEqual({ ok: false, reason: 'signed-out', detail: 'signed out' });
    expect(startupFinished(upTo(events, loginPage(1)))).toBe(true);
  });

  it('reads a refused saved session as a rejection, with the client’s own words and nothing else (fixture)', () => {
    const events = parseLogEvents(fixture(REJECTED));
    expect(events.map((e) => e.kind)).toEqual([
      'started',
      'psl-state',
      'psl-state',
      'psl-state',
      'session-rejected',
      'settings-written',
      'psl-state',
      'psl-state',
      'settings-written',
      'quit',
      'exit',
    ]);
    expect(events[4]).toEqual({ kind: 'session-rejected', detail: 'the client refused the saved sign-in (401 invalid_grant)' });
    expect(lastSignIn(events)).toEqual({ ok: false, reason: 'rejected', detail: 'the client refused the saved sign-in (401 invalid_grant)' });
    expect(JSON.stringify(events)).not.toContain('HandleAuthorizationCreate');
  });

  it('reads a build 77 launch: the command line, the pre-116 sign-in, the product context, the lifecycle, the game session (fixture)', () => {
    const events = parseLogEvents(fixture(LAUNCH_77));
    expect(events[0]).toEqual({ kind: 'started', at: '2026-01-14T19:01:46.012', build: '77.0.1.814' });
    expect(events[1]).toEqual({ kind: 'launch-request', product: 'valorant', patchline: 'live' });
    expect(events.filter((e) => e.kind === 'launch-request')).toHaveLength(1);
    expect(events[2]).toEqual({ kind: 'signed-in', how: 'restored' });
    expect(events.filter((e) => e.kind === 'signed-in')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'settings-written')).toEqual([
      { kind: 'settings-written', key: 'riot-login' },
      { kind: 'settings-written', key: 'riot-login' },
    ]);
    expect(events.filter((e) => e.kind === 'product-context')).toEqual([
      { kind: 'product-context', product: 'valorant', patchline: 'live', autoLaunch: true },
      { kind: 'product-context', product: 'valorant', patchline: 'live', autoLaunch: false },
    ]);
    const transitions = events.filter((e) => e.kind === 'lifecycle');
    expect(transitions).toHaveLength(20);
    expect(transitions[0]).toEqual({ kind: 'lifecycle', from: 'SelfUpdate', to: 'LifecycleSync' });
    expect(transitions.at(-1)).toEqual({ kind: 'lifecycle', from: 'WaitForLaunch', to: 'WaitForSessionExit' });
    expect(events.filter((e) => e.kind === 'game-session-ended')).toEqual([{ kind: 'game-session-ended', product: 'valorant', patchline: 'live' }]);
    expect(events.slice(-2).map((e) => e.kind)).toEqual(['quit', 'exit']);
    expect(lastSignIn(events)).toEqual({ ok: true, how: 'restored' });
    expect(launchRequest(events)).toEqual({ product: 'valorant', patchline: 'live' });
    expect(launchRequest(events.filter((e) => e.kind !== 'launch-request'))).toEqual({ product: 'valorant', patchline: 'live' });
    expect(JSON.stringify(events)).not.toContain('3743783');
  });

  it('tells a launch the client took from one it started, per product, and reads which products need an update', () => {
    const events = parseLogEvents(fixture(LAUNCH_77));
    expect(launchAccepted(events, 'valorant', 'live')).toBe(true);
    expect(launchAccepted(events, 'valorant', 'pbe')).toBe(false);
    expect(launchAccepted(events, 'league_of_legends', 'live')).toBe(false);
    const running = indexOf(events, (e) => e.kind === 'lifecycle' && e.to === 'WaitForSessionExit');
    expect(gameStarted(upTo(events, running - 1), 'valorant', 'live')).toBe(false);
    expect(gameStarted(upTo(events, running), 'valorant', 'live')).toBe(true);
    // The transition names no product, so it counts only after the product's own context.
    expect(gameStarted(upTo(events, running), 'league_of_legends', 'live')).toBe(false);
    const ended = events.filter((e) => e.kind !== 'lifecycle');
    expect(gameStarted(ended, 'valorant', 'live')).toBe(true);
    expect(
      gameStarted(
        ended.filter((e) => e.kind !== 'game-session-ended'),
        'valorant',
        'live',
      ),
    ).toBe(false);
    expect(productsNeedingUpdate(events)).toEqual(new Set());
    expect(launchDeclined(events, 'valorant', 'live')).toBeNull();

    const patched = parseLogEvents(
      [
        line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: OutOfDate, progress: 0'),
        line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: league_of_legends, patchlineId: live, status: UpToDate, progress: 0'),
        line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: UpToDate, progress: 0'),
        line(
          'OKAY',
          'patch-proxy: ProductPatchline: UpdateCombinedProductStatus state for bacon.live changed from CheckingForUpdate to UpToDate, launchable: 0',
        ),
        line('OKAY', 'patch-proxy: HandleProductPatchlineStatusUpdate: productId: lion, patchlineId: live, status: OutOfDate, progress: 0'),
      ].join('\r\n'),
    );
    expect(productsNeedingUpdate(patched)).toEqual(new Set(['bacon.live', 'lion.live']));
    expect(productsNeedingUpdate(patched.slice(0, 1))).toEqual(new Set(['valorant.live']));
    expect(productNeedsUpdate(patchStates(patched).get('valorant.live'))).toBe(false);
    expect(productNeedsUpdate(undefined)).toBe(false);
  });

  it('reads a build 140 run in which a launch request handed to the running client only opened the page, and Play started the game (fixture)', () => {
    const events = parseLogEvents(fixture(FORWARDED_140));
    expect(events[0]).toEqual({ kind: 'started', at: '2026-10-07T17:26:29.636', build: '140.0.7.5045' });
    // Started with no saved sign-in (the login page straight after PendingClientId), then a manual sign-in.
    expect(lastSignIn(events)).toEqual({ ok: true, how: 'manual' });
    const page = indexOf(events, (e) => e.kind === 'psl-state' && e.state === 'PendingLoginStrategy');
    expect(lastSignIn(upTo(events, page))).toEqual({ ok: false, reason: 'no-session', detail: 'no saved sign-in' });
    // The request arrived without auto-launch and was declined twice, with the client's reasons.
    expect(events.filter((e) => e.kind === 'product-context')).toEqual([
      { kind: 'product-context', product: 'valorant', patchline: 'live', autoLaunch: false },
    ]);
    expect(events.filter((e) => e.kind === 'launch-declined')).toEqual([
      { kind: 'launch-declined', reason: 'No product context or launch arguments specified at boot' },
      { kind: 'launch-declined', reason: 'Product is not up to date' },
      { kind: 'launch-declined', reason: 'Auto-launch is disabled' },
    ]);
    expect(launchAccepted(events, 'valorant', 'live')).toBe(true);
    expect(launchRequest(events)).toBeNull();
    const declined = indexOf(events, (e) => e.kind === 'launch-declined', 3);
    expect(launchDeclined(upTo(events, declined), 'valorant', 'live')).toBe('Auto-launch is disabled');
    expect(gameStarted(upTo(events, declined), 'valorant', 'live')).toBe(false);
    // The page is up once the first refusal of the request is logged (the patch check still running), and for sure at WaitForLaunch; the bare start's own reason does not count.
    const first = indexOf(events, (e) => e.kind === 'launch-declined', 2);
    expect(launchPageShown(upTo(events, first - 1), 'valorant', 'live')).toBe(false);
    expect(launchPageShown(upTo(events, first), 'valorant', 'live')).toBe(true);
    expect(launchPageShown(events, 'league_of_legends', 'live')).toBe(false);
    // Play: "Launch starting", then the session running, then its end.
    const starting = indexOf(events, (e) => e.kind === 'launch-starting');
    expect(events[starting]).toEqual({ kind: 'launch-starting', product: 'valorant', patchline: 'live' });
    const running = indexOf(events, (e) => e.kind === 'lifecycle' && e.to === 'WaitForSessionExit');
    expect(gameStarted(upTo(events, running - 1), 'valorant', 'live')).toBe(false);
    expect(gameStarted(upTo(events, running), 'valorant', 'live')).toBe(true);
    expect(events.filter((e) => e.kind === 'game-session-ended')).toEqual([{ kind: 'game-session-ended', product: 'valorant', patchline: 'live' }]);
    // DependencyUpdate is a check, not an update the user must do.
    expect(productsNeedingUpdate(events)).toEqual(new Set());
    expect(JSON.stringify(events)).not.toContain('Placeholder');
  });

  it('reads a build 140 start with the arguments: the context taken back by the auto-launch flag, the sign-in, the page, no game (fixture)', () => {
    const events = parseLogEvents(fixture(BOOT_140));
    expect(events[0]).toEqual({ kind: 'started', at: '2026-10-07T20:51:16.212', build: '140.0.8.5062' });
    expect(launchRequest(events)).toEqual({ product: 'valorant', patchline: 'live' });
    expect(events.filter((e) => e.kind === 'product-context')).toEqual([
      { kind: 'product-context', product: 'valorant', patchline: 'live', autoLaunch: true },
      { kind: 'product-context', product: 'valorant', patchline: 'live', autoLaunch: false },
    ]);
    // Signed in from the saved sign-in: with a product context the client ends on PendingProductContextInitialization.
    expect(lastSignIn(events)).toEqual({ ok: true, how: 'restored' });
    expect(startupFinished(events)).toBe(true);
    const ready = indexOf(events, (e) => e.kind === 'lifecycle' && e.to === 'WaitForLaunch');
    expect(launchPageShown(upTo(events, ready - 1), 'valorant', 'live')).toBe(false);
    expect(launchPageShown(upTo(events, ready), 'valorant', 'live')).toBe(true);
    expect(launchDeclined(upTo(events, ready), 'valorant', 'live')).toBeNull();
    expect(launchDeclined(events, 'valorant', 'live')).toBe('Auto-launch is disabled');
    expect(gameStarted(events, 'valorant', 'live')).toBe(false);
    expect(events.filter((e) => e.kind === 'launch-starting')).toEqual([]);
    expect(events.slice(-2).map((e) => e.kind)).toEqual(['quit', 'exit']);
    // A bare start's own reason names no product and never counts against one.
    const bare = parseLogEvents(
      [
        line('OKAY', 'riot-client-lifecycle: Attempting to launch default product with reason (No product context or launch arguments specified at boot)'),
        line('ALWAYS', 'riot-client-lifecycle: Setting product context to valorant.live, willAutoLaunch=false'),
      ].join('\r\n'),
    );
    expect(bare.map((e) => e.kind)).toEqual(['launch-declined', 'product-context']);
    expect(launchDeclined(bare, 'valorant', 'live')).toBeNull();
    expect(launchPageShown(bare, 'valorant', 'live')).toBe(false);
  });

  it('gives the transitions and refusals, which name no product, to the product whose lines are the latest to name one', () => {
    const context = (product: string): string => line('ALWAYS', `riot-client-lifecycle: Setting product context to ${product}.live, willAutoLaunch=false`);
    const transition = (from: string, to: string): string => line('ALWAYS', `riot-client-lifecycle: Context #1: Middleware transition (${from}) -> (${to})`);
    const starting = (product: string): string => line('OKAY', `product-launcher: Launch starting: productId='${product}' patchlineId='live'`);
    const declined = (reason: string): string =>
      line('ALWAYS', `riot-client-lifecycle: Client is already running. Explicitly request focus instead of launching (${reason})`);
    // VALORANT's page opens for the request; the user then picks League in the client and presses Play there.
    const events = parseLogEvents(
      [
        context('valorant'),
        transition('RestartRequired', 'WaitForLaunch'),
        declined('Product is not up to date'),
        context('league_of_legends'),
        transition('RestartRequired', 'WaitForLaunch'),
        declined('Auto-launch is disabled'),
        starting('league_of_legends'),
        transition('WaitForLaunch', 'WaitForSessionExit'),
      ].join('\r\n'),
    );
    expect(events.map((e) => e.kind)).toEqual([
      'product-context',
      'lifecycle',
      'launch-declined',
      'product-context',
      'lifecycle',
      'launch-declined',
      'launch-starting',
      'lifecycle',
    ]);
    expect(launchAccepted(events, 'valorant', 'live')).toBe(true);
    expect(launchPageShown(upTo(events, 1), 'valorant', 'live')).toBe(true);
    expect(launchPageShown(upTo(events, 1), 'league_of_legends', 'live')).toBe(false);
    expect(launchDeclined(events, 'valorant', 'live')).toBe('Product is not up to date');
    expect(launchDeclined(events, 'league_of_legends', 'live')).toBe('Auto-launch is disabled');
    expect(gameStarted(events, 'valorant', 'live')).toBe(false);
    expect(gameStarted(events, 'league_of_legends', 'live')).toBe(true);
    // With League's lines straight after VALORANT's context, nothing that follows is VALORANT's.
    const leagueNext = [events[0]!, ...events.slice(3)];
    expect(launchPageShown(leagueNext, 'valorant', 'live')).toBe(false);
    expect(launchDeclined(leagueNext, 'valorant', 'live')).toBeNull();
    expect(gameStarted(leagueNext, 'valorant', 'live')).toBe(false);
    // VALORANT named again takes the next transition.
    const back = parseLogEvents([starting('valorant'), transition('WaitForLaunch', 'WaitForSessionExit')].join('\r\n'));
    expect(gameStarted([...events, ...back], 'valorant', 'live')).toBe(true);
  });

  it('recognises the other verdict lines of builds up to 116 and the patch state with its launchable flag', () => {
    const events = parseLogEvents(
      [
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
      ].join('\r\n'),
    );
    expect(events).toEqual([
      { kind: 'session-rejected', detail: 'the client could not authenticate with the saved sign-in' },
      { kind: 'patch-state', product: 'valorant', patchline: 'live', status: 'OutOfDate', launchable: false },
      { kind: 'patch-state', product: 'valorant', patchline: 'live', status: 'OutOfDate', launchable: null },
      { kind: 'product-context', product: 'lion', patchline: 'live', autoLaunch: true },
      { kind: 'settings-written', key: 'riot-login' },
      { kind: 'signed-in', how: 'unknown' },
      { kind: 'settings-written', key: 'riot-login' },
    ]);
    expect(lastSignIn(events)).toEqual({ ok: true, how: 'unknown' });
    expect(lastSignIn(events.slice(0, 2))).toEqual({ ok: false, reason: 'rejected', detail: 'the client could not authenticate with the saved sign-in' });
    expect(patchStates(events).get('valorant.live')).toEqual({ status: 'OutOfDate', launchable: null });
    expect(launchRequest(events)).toEqual({ product: 'lion', patchline: 'live' });

    const older = parseLogEvents(
      [
        line(
          'ERROR',
          'SDK: riot-login: Did not restore persistent session state: Failed to login with persisted login state: Error response for POST /rso-auth/v2/authorizations: in plugin endpoint function RequestAuthorization',
        ),
        line('OKAY', 'SDK: riot-login: Persisting 1 RSO auth cookies: tdid and 0 RSO auth scopes: '),
        line('OKAY', 'SDK: riot-login: Did not restore persistent session state: No stored session exists'),
      ].join('\n'),
    );
    expect(older.map((e) => e.kind)).toEqual(['session-rejected', 'settings-written', 'no-session']);
    expect(lastSignIn(older)).toEqual({ ok: false, reason: 'no-session', detail: 'no saved sign-in' });
    expect(JSON.stringify(older)).not.toContain('/rso-auth/');
  });

  it('tells a refused session from another auth error, and a restore that reached the login page without a verdict', () => {
    const start = [state('PendingInitialization'), state('PendingClientId'), state('PendingPersistenceInitialization')];
    const other = parseLogEvents(
      [
        ...start,
        line(
          'ERROR',
          "SDK: rso-auth: error 'authorization_creation_failure_network_error': in plugin library function HandleAuthorizationCreate: Failed to create RSO authorization (503) service_unavailable: ",
        ),
        state('RestoreAuthorization'),
        state('PendingLoginStrategy'),
      ].join('\r\n'),
    );
    expect(other[3]).toEqual({ kind: 'auth-error', error: 'authorization_creation_failure_network_error' });
    expect(lastSignIn(other)).toEqual({ ok: false, reason: 'error', detail: 'the sign-in did not complete (authorization_creation_failure_network_error)' });

    const silent = parseLogEvents([...start, state('RestoreAuthorization'), state('PendingLoginStrategy')].join('\r\n'));
    expect(lastSignIn(silent)).toEqual({ ok: false, reason: 'error', detail: 'the saved sign-in was not restored' });

    // The same words at another level are not an error line.
    const okay = parseLogEvents(
      [
        ...start,
        line('OKAY', "SDK: rso-auth: error 'authorization_creation_failure_request_error' was cleared"),
        state('RestoreAuthorization'),
        state('PendingEulaData'),
        state('PendingProductContext'),
      ].join('\n'),
    );
    expect(okay.some((e) => e.kind === 'auth-error' || e.kind === 'session-rejected')).toBe(false);
    expect(lastSignIn(okay)).toEqual({ ok: true, how: 'restored' });

    // A manual sign-in after a rejection is a manual one, whatever came before it in the run.
    const manual = parseLogEvents(
      [
        ...start,
        line('ERROR', "SDK: rso-auth: error 'authorization_creation_failure_request_error': Failed to create RSO authorization (401) invalid_grant: "),
        state('RestoreAuthorization'),
        state('PendingLoginStrategy'),
        line('OKAY', 'SDK: rso-auth: Using direct token exchange'),
        state('LoginTokenExchange'),
        state('PendingEulaData'),
        state('PendingEulaAcceptance'),
      ].join('\n'),
    );
    expect(lastSignIn(manual)).toEqual({ ok: false, reason: 'rejected', detail: 'the client refused the saved sign-in (401 invalid_grant)' });
    expect(startupFinished(manual)).toBe(true);
    expect(lastSignIn([...manual, { kind: 'psl-state', state: 'PendingProductContext' }])).toEqual({ ok: true, how: 'manual' });
    expect(startupFinished(parseLogEvents([...start, state('RestoreAuthorization')].join('\n')))).toBe(false);
  });

  it('parses only lines in the client’s shape and ignores everything else', () => {
    expect(parseLogEvents('')).toEqual([]);
    expect(
      parseLogEvents(
        [
          'riot-client-lifecycle: PSLProvider: PSL state changed to PendingProductContext',
          '    --launch-patchline=live',
          'Logging started at 2026-10-04T20:34:14.123',
          '000000.000| ALWAYS| Application Version: 140.0.6.5027',
          '000001.000| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to Pending Product Context',
          '000001.000| ALWAYS| riot-client-lifecycle: Setting product context to valorant, willAutoLaunch=true',
        ].join('\r\n'),
      ),
    ).toEqual([{ kind: 'started', at: null, build: '140.0.6.5027' }]);
    expect(CLIENT_LOG_FILE.test('2026-10-04T20-34-14_12345_Riot Client.log')).toBe(true);
    expect(CLIENT_LOG_FILE.test('2026-10-04T20-34-14.123_12345_Riot Client.log')).toBe(true);
    expect(CLIENT_LOG_FILE.test('Riot Client.log')).toBe(false);
    expect(CLIENT_LOG_FILE.test('2026-10-04T20-34-14_12345_RiotClientCrashHandler.log')).toBe(false);
    expect(clientLogDir('C:\\Users\\x\\AppData\\Local')).toBe(join('C:\\Users\\x\\AppData\\Local', 'Riot Games', 'Riot Client', 'Logs', 'Riot Client Logs'));
  });

  describe('log files', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'onelaunch-riot-log-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('skips the stub a second process leaves behind, so the run that is still writing stays current', () => {
      const run = join(dir, FORWARDED_140);
      writeFileSync(run, fixture(FORWARDED_140));
      expect(newestClientLog(dir)).toBe(run);
      const mark = logMark(dir);
      // The shortcut's second process: newer by name, a few lines, no run.
      writeFileSync(join(dir, STUB_140), fixture(STUB_140));
      expect(newestClientLog(dir)).toBe(run);
      expect(eventsSince(dir, mark)).toEqual([]);
      expect(currentRunBuild(dir)).toBe('140.0.7.5045');
      // A run that has only just started is small too, and is not a stub.
      const fresh = join(dir, '2026-10-07T17-40-00_10007_Riot Client.log');
      writeFileSync(fresh, fixture(FORWARDED_140).split('\n').slice(0, 3).join('\n'));
      expect(newestClientLog(dir)).toBe(fresh);
      expect(eventsSince(dir, mark).map((e) => e.kind)).toEqual(['started']);
    });

    it('picks the newest run by name and reads only what a new run or new bytes add', () => {
      expect(newestClientLog(join(dir, 'missing'))).toBeNull();
      expect(currentRunEvents(join(dir, 'missing'))).toEqual([]);
      expect(currentRunBuild(join(dir, 'missing'))).toBeNull();
      const logs = join(dir, 'Riot Client Logs');
      mkdirSync(logs);
      writeFileSync(join(logs, 'notes.log'), 'x');
      const text = fixture(REJECTED);
      writeFileSync(join(logs, REJECTED), text);
      expect(newestClientLog(logs)).toBe(join(logs, REJECTED));
      expect(currentRunBuild(logs)).toBe('140.0.6.5027');
      const mark = logMark(logs);
      expect(mark).toEqual({ file: join(logs, REJECTED), size: Buffer.byteLength(text) });
      expect(eventsSince(logs, mark)).toEqual([]);
      writeFileSync(join(logs, REJECTED), `${text}${state('LoginTokenExchange')}\r\n${state('PendingProductContext')}\r\n`);
      expect(eventsSince(logs, mark)).toEqual([
        { kind: 'psl-state', state: 'LoginTokenExchange' },
        { kind: 'psl-state', state: 'PendingProductContext' },
      ]);
      writeFileSync(join(logs, MANUAL), fixture(MANUAL));
      expect(newestClientLog(logs)).toBe(join(logs, MANUAL));
      expect(eventsSince(logs, mark)[0]).toEqual({ kind: 'started', at: '2026-10-04T20:56:32.456', build: '140.0.6.5027' });
      expect(lastSignIn(eventsSince(logs, mark))).toEqual({ ok: true, how: 'manual' });
      writeFileSync(join(logs, LAUNCH_77), fixture(LAUNCH_77));
      expect(newestClientLog(logs)).toBe(join(logs, MANUAL));
    });

    it('reads the end of a log that is larger than one read, so the newest verdict decides', () => {
      const logs = join(dir, 'Riot Client Logs');
      mkdirSync(logs);
      const filler = `${line('OKAY', 'SDK: chatter')}\r\n`.repeat(40);
      writeFileSync(join(logs, RESTORED), `${state('PendingLoginStrategy')}\r\n${filler}${state('PendingEulaData')}\r\n${state('PendingProductContext')}\r\n`);
      const tail = readLogSince(logs, { file: null, size: 0 }, 200);
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(200);
      expect(tail.startsWith('000010.000')).toBe(true);
      expect(lastSignIn(parseLogEvents(tail))).toEqual({ ok: true, how: 'unknown' });
    });
  });
});
