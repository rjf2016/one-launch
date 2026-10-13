/**
 * Reads Steam's own sign-in state log, <SteamPath>\logs\steamui_login.txt, to learn why a sign-in
 * stalled instead of guessing from a timeout. It is a plain text log written by the client UI; it
 * holds no tokens or credentials. Lines of interest look like
 *
 *     [2026-09-12 15:00:45] [ WaitingForServerResponse ] SetLoginState: WaitingForCredentials - Account Logon Denied
 *     [2026-09-12 15:17:39] [ WaitingForLibraryReady ] SetLoginState: Success - OK
 *
 * Observed on the user's machine (2026-09-12): "Success - OK", "WaitingForCredentials - OK" (Steam
 * simply shows the form), "- Account Logon Denied" (Steam Guard wants an emailed code for a PC it
 * has not seen), "- License expired" (remembered session dropped).
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LOG_LINE_LENGTH, readTail } from '../log-read';

export const LOGIN_LOG_RELATIVE = join('logs', 'steamui_login.txt');

export function loginLogPath(installDir: string): string {
  return join(installDir, LOGIN_LOG_RELATIVE);
}

export interface LoginStateEvent {
  state: string;
  reason: string;
}

const STATE_LINE = /SetLoginState:\s*([A-Za-z]+)\s*-\s*(.*?)\s*$/;

export function parseLoginStates(text: string): LoginStateEvent[] {
  const out: LoginStateEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length > MAX_LOG_LINE_LENGTH) continue;
    const m = STATE_LINE.exec(line);
    if (m) out.push({ state: m[1]!, reason: m[2] ?? '' });
  }
  return out;
}

export type SignInCause = 'guard-email' | 'guard-mobile' | 'password' | 'expired' | 'rate-limit' | 'none' | 'other';

export type SignInOutcome = { kind: 'success' } | { kind: 'credentials'; reason: string; cause: SignInCause };

/** Maps Steam's EResult wording on a WaitingForCredentials line to what the user has to do. */
export function classifyReason(reason: string): SignInCause {
  const r = reason.trim().toLowerCase();
  if (r === '' || r === 'ok') return 'none';
  if (r.includes('two factor') || r.includes('twofactor') || r.includes('mobile')) return 'guard-mobile';
  if (r.includes('logon denied') || r.includes('login denied') || r.includes('email')) return 'guard-email';
  if (r.includes('password')) return 'password';
  if (r.includes('expired')) return 'expired';
  if (r.includes('rate limit') || r.includes('throttle')) return 'rate-limit';
  return 'other';
}

/** The last decisive state among the events, or null while Steam is still working on it. */
export function latestOutcome(events: readonly LoginStateEvent[]): SignInOutcome | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.state === 'Success') return { kind: 'success' };
    if (e.state === 'WaitingForCredentials') return { kind: 'credentials', reason: e.reason, cause: classifyReason(e.reason) };
  }
  return null;
}

/** Current size of the log, to read only what Steam appends after this point. 0 when absent. */
export function loginLogMark(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

/** Steam rotates the file to steamui_login.previous.txt at about this size (seen 2026-09-18), so one read holds a whole file. */
export const MAX_TAIL_BYTES = 512 * 1024;

/** Text appended since `mark`, at most the last `maxBytes` of it. A log that shrank (rotated) is read from its start. */
export function readLoginLogSince(path: string, mark: number, maxBytes = MAX_TAIL_BYTES): string {
  try {
    if (!existsSync(path)) return '';
    const size = statSync(path).size;
    return readTail(path, size < mark ? 0 : mark, size, maxBytes);
  } catch {
    return '';
  }
}

export function outcomeSince(path: string, mark: number): SignInOutcome | null {
  return latestOutcome(parseLoginStates(readLoginLogSince(path, mark)));
}
