/**
 * The Riot Client's own log, %LOCALAPPDATA%\Riot Games\Riot Client\Logs\Riot Client Logs\<local time>_<pid>_Riot Client.log,
 * one file per run (docs/adapters/riot.md › Log). Lines look like
 *
 *     000000.000| ALWAYS| Logging started at 2026-10-04T20:34:14.123
 *     000000.000| ALWAYS| Application Version: 140.0.6.5027
 *     000002.296| ALWAYS| riot-client-lifecycle: PSLProvider: PSL state changed to PendingProductContext
 *
 * The log never names the account (identity comes from the session file), and its telemetry lines
 * embed cookie and token values. The parser skips those lines and returns only fields a strict pattern
 * matched (a state name, a product id, a status word, an error code), never a raw line.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LOG_LINE_LENGTH, readRange, readTail } from '../log-read';

export const CLIENT_LOG_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?_\d+_Riot Client\.log$/i;

export function clientLogDir(localAppData: string): string {
  return join(localAppData, 'Riot Games', 'Riot Client', 'Logs', 'Riot Client Logs');
}

/** A second RiotClientServices.exe (a shortcut while the client runs) writes a few lines, hands its command line to the running core, and exits; its log is not a run. */
const STUB_LOG_MAX_BYTES = 64 * 1024;
const STUB_LOG_MARK = 'ProcessSingleton: Did not acquire process singleton';

/** The current run's log: the newest file by name (the name is the run's local start time), skipping the stub a second process leaves behind. */
export function newestClientLog(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((name) => CLIENT_LOG_FILE.test(name))
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? 1 : a.toLowerCase() > b.toLowerCase() ? -1 : 0));
  for (const name of names) {
    const file = join(dir, name);
    if (!isStubLog(file)) return file;
  }
  return null;
}

function isStubLog(file: string): boolean {
  try {
    const size = statSync(file).size;
    return size <= STUB_LOG_MAX_BYTES && readRange(file, 0, size).includes(STUB_LOG_MARK);
  } catch {
    return false;
  }
}

export type LogEvent =
  | { kind: 'started'; at: string | null; build: string | null }
  /** The client was started with --launch-product (and --launch-patchline), echoed under "Command Line Arguments". */
  | { kind: 'launch-request'; product: string; patchline: string | null }
  /** "Setting product context to <product>.<patchline>, willAutoLaunch=<bool>": true at a launch start, false once the launch is handed over. */
  | { kind: 'product-context'; product: string; patchline: string; autoLaunch: boolean }
  /** "Context #n: Middleware transition (<from>) -> (<to>)": the launch pipeline; WaitForSessionExit means the game is running (builds 77 and 140). */
  | { kind: 'lifecycle'; from: string; to: string }
  /** "product-launcher: Launch starting: productId='<product>' patchlineId='<patchline>'": the game is being started (build 140), by the client itself or by Play. */
  | { kind: 'launch-starting'; product: string; patchline: string }
  /**
   * Build 140 is not launching the product it was asked for, and says why: "Client is already running. Explicitly request focus
   * instead of launching (<reason>)" for a request handed to the running client, "Attempting to launch default product with
   * reason (<reason>)" at a start (its bare-start reason, "No product context or launch arguments specified at boot", precedes
   * any product context and so never counts against one).
   */
  | { kind: 'launch-declined'; reason: string }
  | { kind: 'patch-state'; product: string; patchline: string; status: string; launchable: boolean | null }
  /** Build 140's sign-in state machine ("PSL state changed to <state>"). PendingProductContext is signed in; PendingLoginStrategy is the login page. */
  | { kind: 'psl-state'; state: string }
  /** "Using direct token exchange": the user is signing in by hand. */
  | { kind: 'manual-sign-in' }
  /** Builds up to 116 said so in words; build 140 says PendingProductContext. */
  | { kind: 'signed-in'; how: 'restored' | 'unknown' }
  /** The saved session was refused (invalid_grant). */
  | { kind: 'session-rejected'; detail: string }
  /** Another rso-auth error: a service or network failure the saved session may survive. */
  | { kind: 'auth-error'; error: string }
  /** Builds up to 116: started with no saved session. */
  | { kind: 'no-session' }
  | { kind: 'signed-out' }
  /** The session file was written ("Updated private settings ... with key <key>"). */
  | { kind: 'settings-written'; key: string }
  /** "Session for <product> on patchline <patchline> has ended" (seen on build 77). */
  | { kind: 'game-session-ended'; product: string; patchline: string }
  | { kind: 'quit' }
  /** "Removal of LockFile complete": the core's last line of a clean exit. */
  | { kind: 'exit' };

const LINE = /^\d{6}\.\d{3}\|\s*([A-Z]+)\|\s?(.*)$/;
const LAUNCH_ARG = /^\s+--launch-(product|patchline)=([a-z0-9_]+)\s*$/i;
const STARTED = /^Logging started at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;
const VERSION = /^Application Version: (\d+(?:\.\d+){0,3})\b/;
const PSL_STATE = /riot-client-lifecycle: PSLProvider: PSL state changed to ([A-Za-z]+)\s*$/;
const PRODUCT_CONTEXT = /riot-client-lifecycle: Setting product context to ([a-z0-9_]+)\.([a-z0-9_]+), willAutoLaunch=(true|false)/i;
const LIFECYCLE = /riot-client-lifecycle: Context #\d+: Middleware transition \(([A-Za-z]+)\) -> \(([A-Za-z]+)\)/;
const LAUNCH_STARTING = /product-launcher: Launch starting: productId='([a-z0-9_]+)' patchlineId='([a-z0-9_]+)'/i;
const LAUNCH_DECLINED = /riot-client-lifecycle: Client is already running\. Explicitly request focus instead of launching \(([^()]{1,80})\)/;
/** At a start with the arguments, build 140 gives the same verdict this way ("Auto-launch is disabled"); at a bare start the reason is "No product context or launch arguments specified at boot". */
const BOOT_LAUNCH_VERDICT = /riot-client-lifecycle: Attempting to launch default product with reason \(([^()]{1,80})\)/;
const PATCH_STATUS = /patch-proxy: HandleProductPatchlineStatusUpdate: productId: ([a-z0-9_]+), patchlineId: ([a-z0-9_]+), status: ([A-Za-z]+)/i;
const PATCH_STATE_116 = /patch-proxy: ProductPatchline: \w+ state for ([a-z0-9_]+)\.([a-z0-9_]+) changed from [A-Za-z]+ to ([A-Za-z]+), launchable: ([01])/i;
const RSO_ERROR = /rso-auth: error '([a-z_]+)'/;
const INVALID_GRANT = /Failed to create RSO authorization \((\d{3})\) ([a-z_]+)/;
const SETTINGS_WRITTEN = /private-settings: Updated private settings for user \S+ with key ([A-Za-z0-9_.-]+)/;
const COOKIES_PERSISTED = /riot-login: Persisting (\d+) RSO auth cookies: .* and (\d+) RSO auth scopes/;
const GAME_SESSION_ENDED = /product-launcher: Session for ([a-z0-9_]+) on patchline ([a-z0-9_]+) has ended/i;

const VERDICTS: ReadonlySet<LogEvent['kind']> = new Set(['signed-in', 'session-rejected', 'no-session', 'signed-out']);

function lastVerdict(events: readonly LogEvent[]): LogEvent | null {
  for (let i = events.length - 1; i >= 0; i--) if (VERDICTS.has(events[i]!.kind)) return events[i]!;
  return null;
}

/** Events the client logs several times in a row (a repeated state, the device cookie written again) count once. */
const DEDUPED: ReadonlySet<LogEvent['kind']> = new Set([
  'launch-request',
  'product-context',
  'patch-state',
  'psl-state',
  'signed-out',
  'settings-written',
  'quit',
]);

export function parseLogEvents(text: string): LogEvent[] {
  const out: LogEvent[] = [];
  const push = (event: LogEvent): void => {
    const last = out[out.length - 1];
    if (last && DEDUPED.has(event.kind) && JSON.stringify(last) === JSON.stringify(event)) return;
    out.push(event);
  };
  let pending: { product: string | null; patchline: string | null } = { product: null, patchline: null };
  const flushLaunch = (): void => {
    if (pending.product) push({ kind: 'launch-request', product: pending.product, patchline: pending.patchline });
    pending = { product: null, patchline: null };
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.length > MAX_LOG_LINE_LENGTH || /telemetry/i.test(line)) continue;
    const prefixed = LINE.exec(line);
    if (!prefixed) {
      // The command line is echoed one argument per indented line under "Command Line Arguments".
      const arg = LAUNCH_ARG.exec(line);
      if (arg) {
        if (arg[1]!.toLowerCase() === 'product') pending.product = arg[2]!.toLowerCase();
        else pending.patchline = arg[2]!.toLowerCase();
      }
      continue;
    }
    flushLaunch();
    const level = prefixed[1]!;
    const body = prefixed[2]!;
    let m: RegExpExecArray | null;
    if ((m = STARTED.exec(body))) {
      push({ kind: 'started', at: m[1]!, build: null });
      continue;
    }
    if ((m = VERSION.exec(body))) {
      const last = out[out.length - 1];
      if (last?.kind === 'started' && last.build === null) last.build = m[1]!;
      else push({ kind: 'started', at: null, build: m[1]! });
      continue;
    }
    if ((m = PSL_STATE.exec(body))) {
      push({ kind: 'psl-state', state: m[1]! });
      continue;
    }
    if (body.includes('rso-auth: Using direct token exchange')) {
      push({ kind: 'manual-sign-in' });
      continue;
    }
    if (body.includes('riot-client-auth: Deleted current RSO authorization') || body.includes('rso-auth: Successfully deleted RSO authorization')) {
      push({ kind: 'signed-out' });
      continue;
    }
    if ((m = RSO_ERROR.exec(body)) && level === 'ERROR') {
      const grant = INVALID_GRANT.exec(body);
      if (grant && grant[2] === 'invalid_grant') push({ kind: 'session-rejected', detail: `the client refused the saved sign-in (${grant[1]} invalid_grant)` });
      else push({ kind: 'auth-error', error: m[1]! });
      continue;
    }
    if ((m = SETTINGS_WRITTEN.exec(body))) {
      push({ kind: 'settings-written', key: m[1]! });
      continue;
    }
    if ((m = PRODUCT_CONTEXT.exec(body))) {
      push({ kind: 'product-context', product: m[1]!.toLowerCase(), patchline: m[2]!.toLowerCase(), autoLaunch: m[3]!.toLowerCase() === 'true' });
      continue;
    }
    if ((m = LIFECYCLE.exec(body))) {
      push({ kind: 'lifecycle', from: m[1]!, to: m[2]! });
      continue;
    }
    if ((m = LAUNCH_STARTING.exec(body))) {
      push({ kind: 'launch-starting', product: m[1]!.toLowerCase(), patchline: m[2]!.toLowerCase() });
      continue;
    }
    if ((m = LAUNCH_DECLINED.exec(body)) || (m = BOOT_LAUNCH_VERDICT.exec(body))) {
      push({ kind: 'launch-declined', reason: m[1]! });
      continue;
    }
    if ((m = PATCH_STATUS.exec(body))) {
      push({ kind: 'patch-state', product: m[1]!.toLowerCase(), patchline: m[2]!.toLowerCase(), status: m[3]!, launchable: null });
      continue;
    }
    if ((m = PATCH_STATE_116.exec(body))) {
      push({ kind: 'patch-state', product: m[1]!.toLowerCase(), patchline: m[2]!.toLowerCase(), status: m[3]!, launchable: m[4] === '1' });
      continue;
    }
    if ((m = GAME_SESSION_ENDED.exec(body))) {
      push({ kind: 'game-session-ended', product: m[1]!.toLowerCase(), patchline: m[2]!.toLowerCase() });
      continue;
    }
    if (body.includes('riot-login: Successfully logged in with persistent session state')) {
      push({ kind: 'signed-in', how: 'restored' });
      continue;
    }
    if (body.includes('riot-login: Did not restore persistent session state: Failed')) {
      push({ kind: 'session-rejected', detail: 'the client could not authenticate with the saved sign-in' });
      continue;
    }
    if (body.includes('riot-login: Did not restore persistent session state: No stored session exists')) {
      push({ kind: 'no-session' });
      continue;
    }
    if ((m = COOKIES_PERSISTED.exec(body))) {
      // Builds up to 116 kept the session in cookies; a write with scopes is a completed sign-in (unless one was already logged), one without is only the device cookie.
      if (Number(m[2]) > 0 && lastVerdict(out)?.kind !== 'signed-in') push({ kind: 'signed-in', how: 'unknown' });
      push({ kind: 'settings-written', key: 'riot-login' });
      continue;
    }
    if (body.includes('riot-client-lifecycle: Attempting to quit')) {
      push({ kind: 'quit' });
      continue;
    }
    if (body.includes('ProcessSingleton: Removal of LockFile complete')) push({ kind: 'exit' });
  }
  flushLaunch();
  return out;
}

export type SignInOutcome =
  { ok: true; how: 'restored' | 'manual' | 'unknown' } | { ok: false; reason: 'rejected' | 'signed-out' | 'no-session' | 'error'; detail: string };

/** The events of the sign-in attempt that ends at `end`: back to the previous PendingInitialization (one per start and per sign-out). */
function attempt(events: readonly LogEvent[], end: number): LogEvent[] {
  let start = end;
  while (start > 0) {
    const e = events[start - 1]!;
    if (e.kind === 'psl-state' && e.state === 'PendingInitialization') break;
    start--;
  }
  return events.slice(start, end);
}

function loginPageReason(events: readonly LogEvent[], end: number): Extract<SignInOutcome, { ok: false }> {
  let rejected: string | null = null;
  let error: string | null = null;
  let signedOut = false;
  let restored = false;
  for (const e of attempt(events, end)) {
    if (e.kind === 'session-rejected') rejected = e.detail;
    else if (e.kind === 'auth-error') error = e.error;
    else if (e.kind === 'signed-out' || (e.kind === 'psl-state' && e.state === 'PendingCreateAuthorization')) signedOut = true;
    else if (e.kind === 'psl-state' && e.state === 'RestoreAuthorization') restored = true;
  }
  if (rejected) return { ok: false, reason: 'rejected', detail: rejected };
  if (error) return { ok: false, reason: 'error', detail: `the sign-in did not complete (${error})` };
  if (signedOut) return { ok: false, reason: 'signed-out', detail: 'signed out' };
  if (restored) return { ok: false, reason: 'error', detail: 'the saved sign-in was not restored' };
  return { ok: false, reason: 'no-session', detail: 'no saved sign-in' };
}

function signedInHow(events: readonly LogEvent[], end: number): 'restored' | 'manual' | 'unknown' {
  let how: 'restored' | 'manual' | 'unknown' = 'unknown';
  for (const e of attempt(events, end)) {
    if (e.kind === 'manual-sign-in' || (e.kind === 'psl-state' && e.state === 'LoginTokenExchange')) return 'manual';
    if (e.kind === 'psl-state' && e.state === 'RestoreAuthorization') how = 'restored';
  }
  return how;
}

/**
 * The last verdict the log gives on a sign-in, or null while the client is still working (or has not
 * tried). Build 140 ends on PendingProductContext (signed in) or PendingLoginStrategy (the login page
 * is showing); why the page is showing comes from the lines before it. A later sign-out cancels a sign-in.
 */
export function lastSignIn(events: readonly LogEvent[]): SignInOutcome | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    switch (e.kind) {
      case 'psl-state':
        // PendingProductContextInitialization is the same point when the client was started with a product (build 140.0.8).
        if (e.state === 'PendingProductContext' || e.state === 'PendingProductContextInitialization') return { ok: true, how: signedInHow(events, i) };
        if (e.state === 'PendingLoginStrategy') return loginPageReason(events, i);
        break;
      case 'signed-in':
        return { ok: true, how: e.how };
      case 'session-rejected':
        return { ok: false, reason: 'rejected', detail: e.detail };
      case 'no-session':
        return { ok: false, reason: 'no-session', detail: 'no saved sign-in' };
      case 'signed-out':
        return { ok: false, reason: 'signed-out', detail: 'signed out' };
      default:
        break;
    }
  }
  return null;
}

/** The current run has reached a sign-in verdict or the terms page, so a restarted client is far enough along to be closed again. */
export function startupFinished(events: readonly LogEvent[]): boolean {
  return lastSignIn(events) !== null || events.some((e) => e.kind === 'psl-state' && e.state === 'PendingEulaAcceptance');
}

/** The core logged the removal of its lock file, its last line of a clean exit. */
export function exitedCleanly(events: readonly LogEvent[]): boolean {
  return events.some((e) => e.kind === 'exit');
}

/** The product the run was asked to launch: the command line first, else a product context set to auto-launch. */
export function launchRequest(events: readonly LogEvent[]): { product: string; patchline: string | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'launch-request') return { product: e.product, patchline: e.patchline };
    if (e.kind === 'product-context' && e.autoLaunch) return { product: e.product, patchline: e.patchline };
  }
  return null;
}

export interface PatchState {
  status: string;
  launchable: boolean | null;
}

/** The latest patch state per `<product>.<patchline>`. */
export function patchStates(events: readonly LogEvent[]): Map<string, PatchState> {
  const out = new Map<string, PatchState>();
  for (const e of events) {
    if (e.kind === 'patch-state') out.set(`${e.product}.${e.patchline}`, { status: e.status, launchable: e.launchable });
  }
  return out;
}

/** The client's last word on the product is that it must be patched before it runs: its Play button reads Update, and a launch request only opens its page. */
export function productNeedsUpdate(state: PatchState | undefined): boolean {
  return state !== undefined && (state.status.toLowerCase() === 'outofdate' || state.launchable === false);
}

/** The `<product>.<patchline>` ids whose latest patch state says they need an update. */
export function productsNeedingUpdate(events: readonly LogEvent[]): Set<string> {
  const out = new Set<string>();
  for (const [id, state] of patchStates(events)) if (productNeedsUpdate(state)) out.add(id);
  return out;
}

/**
 * The product a line names, as `<product>.<patchline>`: a context set or a launch start. The pipeline
 * transitions and the refusals name none, so they belong to the product whose lines are the latest to name one.
 */
function namedProduct(e: LogEvent): string | null {
  return e.kind === 'product-context' || e.kind === 'launch-starting' ? `${e.product}.${e.patchline}` : null;
}

/** The client acted on the launch request: it set the product's context, or began the launch (the command line echo alone says only that it was asked). */
export function launchAccepted(events: readonly LogEvent[], product: string, patchline: string): boolean {
  const id = `${product}.${patchline}`;
  return events.some((e) => namedProduct(e) === id);
}

/** The client took the launch request as a request to show the game's page instead (build 140, auto-launch turned off by Riot); the reason it gave, or null. */
export function launchDeclined(events: readonly LogEvent[], product: string, patchline: string): string | null {
  const id = `${product}.${patchline}`;
  let reason: string | null = null;
  let named = false;
  for (const e of events) {
    const names = namedProduct(e);
    if (names !== null) named = names === id;
    else if (e.kind === 'launch-declined' && named) reason = e.reason;
  }
  return reason;
}

/**
 * The game's page is up with its Play button ready: after the product's own lines, with no other product's
 * since, the launch pipeline reached WaitForLaunch (the patch check is done), or the client said why it is
 * not launching. What the user is handed.
 */
export function launchPageShown(events: readonly LogEvent[], product: string, patchline: string): boolean {
  const id = `${product}.${patchline}`;
  let named = false;
  for (const e of events) {
    const names = namedProduct(e);
    if (names !== null) named = names === id;
    else if (named && ((e.kind === 'lifecycle' && e.to === 'WaitForLaunch') || e.kind === 'launch-declined')) return true;
  }
  return false;
}

/**
 * The client started the product's game: the launch pipeline reached WaitForSessionExit after the
 * product's context was set or its launch began (builds 77 and 140), or the game ran to its end. The
 * transition names no product, so it counts only while the product's own lines are the latest to name one:
 * another product chosen in the client meanwhile takes the transitions that follow.
 */
export function gameStarted(events: readonly LogEvent[], product: string, patchline: string): boolean {
  const id = `${product}.${patchline}`;
  let named = false;
  for (const e of events) {
    const names = namedProduct(e);
    if (names !== null) named = names === id;
    else if (e.kind === 'lifecycle' && e.to === 'WaitForSessionExit' && named) return true;
    else if (e.kind === 'game-session-ended' && e.product === product && e.patchline === patchline) return true;
  }
  return false;
}

export interface LogMark {
  /** The newest log file at mark time; a different newest file later means a new run. */
  file: string | null;
  size: number;
}

export const MAX_TAIL_BYTES = 8 * 1024 * 1024;

export function logMark(dir: string): LogMark {
  try {
    const file = newestClientLog(dir);
    return { file, size: file ? statSync(file).size : 0 };
  } catch {
    return { file: null, size: 0 };
  }
}

/** Text appended to the current log since `mark`, or the whole new log when the client has started a new run since; at most the last `maxBytes` of it. */
export function readLogSince(dir: string, mark: LogMark, maxBytes = MAX_TAIL_BYTES): string {
  try {
    const file = newestClientLog(dir);
    if (!file) return '';
    const size = statSync(file).size;
    const sameRun = mark.file !== null && file.toLowerCase() === mark.file.toLowerCase() && size >= mark.size;
    return readTail(file, sameRun ? mark.size : 0, size, maxBytes);
  } catch {
    return '';
  }
}

export function eventsSince(dir: string, mark: LogMark): LogEvent[] {
  return parseLogEvents(readLogSince(dir, mark));
}

/** The current log's events (its newest 8 MB), or [] when there is no log. */
export function currentRunEvents(dir: string): LogEvent[] {
  return eventsSince(dir, { file: null, size: 0 });
}

/** The build the current run's log names, or null. Reads only the file's head. */
export function currentRunBuild(dir: string): string | null {
  try {
    const file = newestClientLog(dir);
    if (!file) return null;
    const started = parseLogEvents(readRange(file, 0, 512)).find((e) => e.kind === 'started');
    return started?.build ?? null;
  } catch {
    return null;
  }
}
