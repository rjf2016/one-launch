/**
 * The Battle.net client's own log, %LOCALAPPDATA%\Battle.net\Logs\battle.net-<UTC stamp>.log, one
 * file per run (docs/adapters/battlenet.md, "Client log"). Lines look like
 *
 *     I 2026-09-13 03:20:55.149702 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:0a1b2c3d|game=...
 *
 * The account id in that line is the account's launcher_uid. Tokens never appear in the log; the
 * only sensitive things are logins inside failure text, which maskReason strips.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LOG_LINE_LENGTH, readRange, readTail } from '../log-read';

export const CLIENT_LOG_FILE = /^battle\.net-(\d{8}T\d{6}(?:\.\d+)?)\.log$/i;

export function clientLogDir(localAppData: string): string {
  return join(localAppData, 'Battle.net', 'Logs');
}

/**
 * A second Battle.net.exe started with --uri= or --exec= while the client runs writes its own short
 * log ("Opening IPC shared memory ... mode=client", "Leaving because another instance of battle.net
 * is running") and hands the command over. Those files are not client runs.
 */
export function isForwarderLog(head: string): boolean {
  return head.includes('IPC ShMem mode=client') || head.includes('Leaving because another instance');
}

/** The current run's log: the newest battle.net-*.log by name (the name is the run's UTC start) that is a client run, not a forwarder. */
export function newestClientLog(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((name) => CLIENT_LOG_FILE.test(name))
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? 1 : a.toLowerCase() > b.toLowerCase() ? -1 : 0));
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!isForwarderLog(readRange(path, 0, 4096))) return path;
    } catch {
      // unreadable: try the next one
    }
  }
  return null;
}

export type LogEvent =
  | { kind: 'started'; build: string | null }
  | { kind: 'sign-in-attempt' }
  | { kind: 'signed-in'; accountId: string; at: string | null }
  | { kind: 'sign-in-failed'; reason: string }
  | { kind: 'signed-out' }
  | { kind: 'main-window' }
  | { kind: 'launch-request'; code: string }
  /** "InstallState (<codename>): currentOperation=…": the client's install state for a product, logged at start and when it changes. */
  | { kind: 'product-state'; codename: string; operation: string | null; status: string | null; playable: boolean | null }
  | { kind: 'game-launching'; codename: string }
  | { kind: 'game-running'; codename: string }
  | { kind: 'game-exited'; codename: string }
  | { kind: 'close-requested' }
  | { kind: 'exit' };

const LINE_TIME = /^\w\s+(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
const ACCOUNT_ID = /\|bnet=\d+:\d+:([0-9a-f]{1,16})\|/i;
const ENTITY_ID = /entityId=\d+:\d+:([0-9a-f]{1,16})\b/i;
const INSTALL_STATE = /\[ProductState\] \{Main\} InstallState \(([A-Za-z0-9_.-]+)\): (.*)$/;
const EXECUTE_STATUS = /Operation status changed: opType=Execute oldStatus=\S+ newStatus=(\S+) agentUid=([A-Za-z0-9_.-]+)/;
const LAUNCH_BINARY = /\[GameLaunchController\] \{Main\} LaunchBinary: uid=([A-Za-z0-9_.-]+)/;
const GAME_RUNNING = /\[InstallManager\] \{Main\} Game is running: ([A-Za-z0-9_.-]+)/;

/** The UTC time in a line's prefix as ISO, or null when the line has none. */
export function lineTime(line: string): string | null {
  const m = LINE_TIME.exec(line);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

/** Failure text with emails and long hex values dropped. */
export function maskReason(raw: string): string {
  return raw
    .replace(/(?<![\w.+-])[\w.+-]+@[\w-]+\.[\w.-]+/g, '…')
    .replace(/\b[0-9a-f]{16,}\b/gi, '…')
    .trim()
    .slice(0, 200);
}

export function parseLogEvents(text: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length > MAX_LOG_LINE_LENGTH) continue;
    if (line.includes('Logging started for Battle.net build')) {
      out.push({ kind: 'started', build: /build (\S+)/.exec(line)?.[1] ?? null });
      continue;
    }
    if (line.includes('Logged into Battle.net successfully')) {
      out.push({ kind: 'signed-in', accountId: (ACCOUNT_ID.exec(line)?.[1] ?? '').toLowerCase(), at: lineTime(line) });
      continue;
    }
    if (line.includes('Login triggered.') && ENTITY_ID.test(line)) {
      out.push({ kind: 'sign-in-attempt' });
      continue;
    }
    if (line.includes('Login_QueueUpdate')) {
      out.push({ kind: 'sign-in-attempt' });
      continue;
    }
    if (line.includes('DeleteToken(): Deleting registry token')) {
      // Logged at start when the token on disk is not the account the login page remembers; the client then asks for that account's password.
      out.push({ kind: 'sign-in-failed', reason: 'the client discarded the token at start (its login page remembers a different account)' });
      continue;
    }
    if (line.includes('Login failed.') || line.includes('OnLoginFailed()') || line.includes('External Challenge was canceled by user')) {
      const reason = /error=(.*)$/.exec(line)?.[1] ?? line.replace(/^.*\}\s*/, '');
      out.push({ kind: 'sign-in-failed', reason: maskReason(reason) });
      continue;
    }
    if (line.includes('Logout() : calling DeleteToken') || line.includes('DeleteToken() because !enabled')) {
      out.push({ kind: 'signed-out' });
      continue;
    }
    if (line.includes('Attempting to show main window')) {
      out.push({ kind: 'main-window' });
      continue;
    }
    const state = INSTALL_STATE.exec(line);
    if (state) {
      const codename = state[1]!;
      const fields = state[2]!;
      if (/\bGameLaunching=1\b/.test(fields)) out.push({ kind: 'game-launching', codename });
      else if (/\bgameRunning=1\b/.test(fields)) out.push({ kind: 'game-running', codename });
      else if (/\bgameRunning=0\b/.test(fields)) out.push({ kind: 'game-exited', codename });
      else if (fields.includes('currentOperation=')) {
        // "playable=1" is the product's own flag; the regional "playable:false" entries use a colon and are not it.
        const field = (name: string): string | null => new RegExp(`\\b${name}=(\\S+)`).exec(fields)?.[1] ?? null;
        const playable = field('playable');
        out.push({
          kind: 'product-state',
          codename,
          operation: field('currentOperation'),
          status: field('currentOperationStatus'),
          playable: playable === null ? null : playable === '1',
        });
      }
      continue;
    }
    const execute = EXECUTE_STATUS.exec(line);
    if (execute) {
      if (execute[1] === 'Pending') out.push({ kind: 'game-launching', codename: execute[2]! });
      else if (execute[1] === 'On') out.push({ kind: 'game-running', codename: execute[2]! });
      else if (execute[1] === 'Off') out.push({ kind: 'game-exited', codename: execute[2]! });
      continue;
    }
    const binary = LAUNCH_BINARY.exec(line);
    if (binary) {
      out.push({ kind: 'game-launching', codename: binary[1]! });
      continue;
    }
    const running = GAME_RUNNING.exec(line);
    if (running) {
      out.push({ kind: 'game-running', codename: running[1]! });
      continue;
    }
    const launch = /Launch request (\S+?)\.? isRunning=/.exec(line);
    if (launch) {
      out.push({ kind: 'launch-request', code: launch[1]! });
      continue;
    }
    if (line.includes('Frontend is requesting to close window')) {
      out.push({ kind: 'close-requested' });
      continue;
    }
    if (line.includes('Shutting down battle.net interface') || line.includes('signaling application exit')) out.push({ kind: 'exit' });
  }
  return out;
}

export type SignInOutcome = { ok: true; accountId: string; at: string | null } | { ok: false; reason: string };

/** The last decisive sign-in event, or null while the client is still working (or never tried). A later sign-out cancels a sign-in. */
export function lastSignIn(events: readonly LogEvent[]): SignInOutcome | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'signed-in') return { ok: true, accountId: e.accountId, at: e.at };
    if (e.kind === 'sign-in-failed') return { ok: false, reason: e.reason };
    if (e.kind === 'signed-out') return { ok: false, reason: 'signed out' };
  }
  return null;
}

/** The run's last event is a sign-out, so the client left no remembered session behind. */
export function endedSignedOut(events: readonly LogEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'signed-out') return true;
    if (e.kind === 'signed-in') return false;
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
