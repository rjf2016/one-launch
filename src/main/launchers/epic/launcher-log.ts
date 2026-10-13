/**
 * Reads the launcher's own log, %LOCALAPPDATA%\EpicGamesLauncher\Saved\Logs\EpicGamesLauncher.log,
 * for sign-in outcomes. The launcher redacts tokens itself; the lines used here carry at most the
 * account id (docs/adapters/epic.md, Phase 4 survey):
 *
 *     FAccountService::AutoSignIn
 *     FAccountService::OnLoginComplete - 0 TRUE 0123456789abcdef0123456789abcdef
 *     FAccountService::OnLoginComplete - 0 FALSE  errormessage=Sorry the refresh token '...' is invalid. Reason: TOKEN_EXPIRED errorcode=18036 ...
 *     FAccountService::SignIn (exchange code)
 *     LogInit: AllCheckComplete SelfUpdate=1 SignedIn=0 RequiresRestart=0      (startup finished)
 *     Application: Restarting .../EpicGamesUpdater.exe with command: start ...  (it will come back after exiting)
 *
 * FAccountService::SignOut is logged during every normal shutdown (seen 2026-09-13) and says nothing
 * about the remembered session, so it is ignored; whether the launcher is signed out is read from
 * GameUserSettings.ini instead.
 *
 * The launcher starts a new log on every start (the old one becomes EpicGamesLauncher-backup-*.log),
 * so "what was appended since the mark" also has to notice that the file was replaced: the first
 * line, "Log file open, <date>", identifies a run.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LOG_LINE_LENGTH, readRange, readTail } from '../log-read';

export const LAUNCHER_LOG_RELATIVE = join('Saved', 'Logs', 'EpicGamesLauncher.log');

export function launcherLogPath(localAppData: string): string {
  return join(localAppData, 'EpicGamesLauncher', LAUNCHER_LOG_RELATIVE);
}

export type LogEvent =
  | { kind: 'auto-sign-in' }
  | { kind: 'manual-sign-in' }
  | { kind: 'signed-in'; accountId: string; at: string | null }
  | { kind: 'sign-in-failed'; reason: string }
  | { kind: 'ready' }
  | { kind: 'restart' }
  | { kind: 'exit' };

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const LOGIN_COMPLETE = /FAccountService::OnLoginComplete - \d+ (TRUE|FALSE)\s*(.*)$/;
/** Unreal's line prefix: [2026.09.13-00.09.05:354][713], a UTC timestamp. */
const LINE_TIME = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/;

/** The UTC time in a log line's prefix as ISO, or null when the line has none. */
export function lineTime(line: string): string | null {
  const m = LINE_TIME.exec(line);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

/** Failure text with any 32-hex value (a token id) and everything from errorpath= on dropped. */
export function maskReason(raw: string): string {
  const text = raw.replace(/^errormessage=/, '');
  const cut = text.indexOf('errorpath=');
  return (cut === -1 ? text : text.slice(0, cut)).replace(/[0-9a-f]{32}/gi, '…').trim();
}

export function parseLogEvents(text: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length > MAX_LOG_LINE_LENGTH) continue;
    if (line.includes('FAccountService::AutoSignIn')) {
      out.push({ kind: 'auto-sign-in' });
      continue;
    }
    if (line.includes('FAccountService::SignIn')) {
      out.push({ kind: 'manual-sign-in' });
      continue;
    }
    const m = LOGIN_COMPLETE.exec(line);
    if (m) {
      if (m[1] === 'TRUE') {
        const id = (m[2] ?? '').trim().split(/\s+/)[0] ?? '';
        out.push({ kind: 'signed-in', accountId: ACCOUNT_ID.test(id) ? id.toLowerCase() : '', at: lineTime(line) });
      } else {
        out.push({ kind: 'sign-in-failed', reason: maskReason(m[2] ?? '') });
      }
      continue;
    }
    if (line.includes('LogInit: AllCheckComplete')) {
      out.push({ kind: 'ready' });
      continue;
    }
    if (line.includes('Application: Restarting') && line.includes('EpicGamesUpdater.exe')) {
      out.push({ kind: 'restart' });
      continue;
    }
    if (line.includes('LogCore: Engine exit requested') || line.startsWith('Log file closed')) out.push({ kind: 'exit' });
  }
  return out;
}

export type SignInOutcome = { ok: true; accountId: string; at: string | null } | { ok: false; reason: string };

/** The last decisive sign-in event, or null while the launcher is still working (or never tried). */
export function lastSignIn(events: readonly LogEvent[]): SignInOutcome | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'signed-in') return { ok: true, accountId: e.accountId, at: e.at };
    if (e.kind === 'sign-in-failed') return { ok: false, reason: e.reason };
  }
  return null;
}

/**
 * The failure says the remembered session itself was refused (seen: "Sorry the refresh token '...' is invalid. Reason: TOKEN_EXPIRED
 * errorcode=18036"), as opposed to a service or network error that the same session survives.
 */
export function isSessionRejection(reason: string): boolean {
  return /TOKEN_EXPIRED|refresh token|invalid_grant|token (is |was |has )?(invalid|expired|revoked)/i.test(reason);
}

/** The launcher announced it will restart itself (self-update hand-off) in the events seen so far. */
export function announcedRestart(events: readonly LogEvent[]): boolean {
  return events.some((e) => e.kind === 'restart');
}

/** Startup of the current run has finished (AllCheckComplete logged). */
export function startupFinished(events: readonly LogEvent[]): boolean {
  return events.some((e) => e.kind === 'ready');
}

export interface LogMark {
  size: number;
  /** The first line of the file at mark time; a different first line later means a new run. */
  opened: string | null;
}

export const MAX_TAIL_BYTES = 8 * 1024 * 1024;

function firstLine(path: string): string | null {
  try {
    const head = readRange(path, 0, 256);
    const nl = head.indexOf('\n');
    const line = (nl >= 0 ? head.slice(0, nl) : head).replace(/\r$/, '');
    return line === '' ? null : line;
  } catch {
    return null;
  }
}

export function logMark(path: string): LogMark {
  try {
    if (!existsSync(path)) return { size: 0, opened: null };
    return { size: statSync(path).size, opened: firstLine(path) };
  } catch {
    return { size: 0, opened: null };
  }
}

/** Text appended since `mark`, or the whole file when the launcher has started a new log since; at most the last `maxBytes` of it. */
export function readLogSince(path: string, mark: LogMark, maxBytes = MAX_TAIL_BYTES): string {
  try {
    if (!existsSync(path)) return '';
    const size = statSync(path).size;
    const opened = firstLine(path);
    const sameRun = opened !== null && opened === mark.opened && size >= mark.size;
    return readTail(path, sameRun ? mark.size : 0, size, maxBytes);
  } catch {
    return '';
  }
}

export function eventsSince(path: string, mark: LogMark): LogEvent[] {
  return parseLogEvents(readLogSince(path, mark));
}

/** The current log's last sign-in outcome, or null when the file is missing or says nothing. */
export function lastSignInInLog(path: string): SignInOutcome | null {
  return lastSignIn(eventsSince(path, { size: 0, opened: null }));
}
