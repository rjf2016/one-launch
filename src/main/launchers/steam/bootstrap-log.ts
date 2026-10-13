/**
 * Reads Steam's updater log, <SteamPath>\logs\bootstrap_log.txt, to tell a client that is updating
 * itself from one that is stuck. It is a plain text log written by steam.exe before the UI exists;
 * it holds no account names or tokens. A self-update looks like this (seen 2026-09-11, 9 s in all):
 *
 *     [2026-09-11 12:56:02] Downloaded new manifest: /steam_client_win64 version 1788652215, installed version 1785799196, existing pending version 0
 *     [2026-09-11 12:56:02] Downloading update (12,842 of 212,314 KB)...
 *     [2026-09-11 12:56:05] Download complete.
 *     [2026-09-11 12:56:05] Found pending update
 *     [2026-09-11 12:56:05] Installing update...
 *     [2026-09-11 12:56:05] Extracting package...
 *     [2026-09-11 12:56:10] Update complete, launching Steam...
 *     [2026-09-11 12:56:10] Shutdown
 *     [2026-09-11 12:56:10] Startup - updater built Sep  2 2026 18:32:43
 *     [2026-09-11 12:56:10] Verification complete
 *
 * steam.exe starts itself again after "Update complete"; the relaunched client logs "Verification
 * complete" and only then brings up the UI that writes steamui_login.txt.
 *
 * A running client also downloads updates in the background, a couple of minutes after start, and
 * applies them at its next start (27 of the 79 update runs in the author's logs, read 2026-09-18):
 *
 *     [2026-05-22 21:03:53] Background update loop checking for update. . .
 *     [2026-05-22 21:03:54] Downloading update (141 of 269 KB)...
 *     [2026-05-22 21:03:55] Download complete.
 *     [2026-05-23 12:43:35] Startup - updater built May  8 2026 15:40:38
 *     [2026-05-23 12:43:35] Found pending update
 *     [2026-05-23 12:43:35] Installing update...
 *
 * The download never reaches "Verification complete" in its own run and holds nothing up, so it does
 * not count; the install at the next start does.
 */

import { join } from 'node:path';
import { loginLogMark, readLoginLogSince } from './login-log';

export const BOOTSTRAP_LOG_RELATIVE = join('logs', 'bootstrap_log.txt');

export function bootstrapLogPath(installDir: string): string {
  return join(installDir, BOOTSTRAP_LOG_RELATIVE);
}

const UPDATE_LINE = /Downloaded new manifest|Downloading update|Found pending update|Installing update|Extracting package|Update complete, launching Steam/;
const SETTLED_LINE = /Verification complete/;
const STARTUP_LINE = /Startup - updater built/;
const BACKGROUND_LINE = /Background update loop/;

/** The lines show a startup update that the relaunched client's "Verification complete" has not yet closed. */
export function updateInProgress(text: string): boolean {
  let updating = false;
  let background = false;
  for (const line of text.split(/\r?\n/)) {
    if (STARTUP_LINE.test(line)) background = false;
    else if (BACKGROUND_LINE.test(line)) background = true;
    else if (SETTLED_LINE.test(line)) updating = false;
    else if (UPDATE_LINE.test(line) && !background) updating = true;
  }
  return updating;
}

export const bootstrapLogMark = loginLogMark;

export function updatingSince(path: string, mark: number): boolean {
  return updateInProgress(readLoginLogSince(path, mark));
}
