import type { ProcessInfo } from '../../platform/processes';

export interface SteamKnobs {
  /** Logins whose remembered session Steam rejects. */
  expiredSessions: string[];
  wrongPassword: boolean;
  /** What the login log reports after a -login attempt, e.g. "Account Logon Denied". */
  loginVerdict: string | null;
  /** Steam updates itself for this long at start before signing in; null = no update, negative = never finishes. */
  selfUpdateMs: number | null;
  /** Delay before the simulator reacts to a start; 0 = at once. */
  reactMs: number;
  /** After landing on its sign-in form, the simulated user signs in by hand after this long; null = never. */
  signInWhenAskedMs: number | null;
  /** The SteamID3 a manual sign-in lands on; null = the requested login's id from loginusers.vdf when known, else 424242. */
  signInAs: number | null;
  /** A login Steam is already signed in as when the run begins. */
  runningAs: string | null;
}

export interface ProcessKnobs {
  running: string[];
  table: ProcessInfo[];
  shutdownPolls: number;
  /** Image names whose start never shows up as running. */
  startFails: string[];
  /** Image names whose close or kill throws ProcessAccessDeniedError. */
  elevated: string[];
  /** Image name -> after that many isRunning() polls that found it stopped, it counts as running again (something else started it). */
  reappearsAfterPolls: Record<string, number>;
}
