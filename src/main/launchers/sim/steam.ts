import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StaticProcessController } from '../../platform/processes';
import type { StaticRegistry } from '../../platform/registry';
import { STEAM_EXE, STEAM_HKCU_KEY, STEAM_HKLM_KEY, steamId3 } from '../steam/adapter';
import { bootstrapLogPath } from '../steam/bootstrap-log';
import { loginLogPath } from '../steam/login-log';
import { parseLoginUsers } from '../steam/loginusers';
import type { SteamKnobs } from './types';

export const STEAM_UPDATER_STARTUP_LINE = 'Startup - updater built Sep  2 2026 18:32:43';

export const STEAM_UPDATE_LINES: readonly string[] = [
  'Downloaded new manifest: /steam_client_win64 version 1788652215, installed version 1785799196, existing pending version 0',
  'Downloading update (12,842 of 212,314 KB)...',
  'Download complete.',
  'Found pending update',
  'Installing update...',
  'Extracting package...',
];

export const STEAM_UPDATED_LINES: readonly string[] = ['Update complete, launching Steam...', 'Shutdown', STEAM_UPDATER_STARTUP_LINE, 'Verification complete'];

/** The SteamID3 the simulator signs in as for a login that loginusers.vdf does not know. */
export const UNKNOWN_ACCOUNT_ID3 = 424242;

const REG = `HKCU\\${STEAM_HKCU_KEY}`;
const ACTIVE_USER = `${REG}\\ActiveProcess\\ActiveUser`;

export interface SteamSimOptions {
  steamDir: string;
  registry: StaticRegistry;
  processes: StaticProcessController;
  knobs?: Partial<SteamKnobs>;
}

/** A scripted Steam client: hooked to a StaticProcessController's onStart, it writes what the real client would (ActiveUser, log lines). */
export class SteamSim {
  readonly knobs: SteamKnobs;
  private readonly steamDir: string;
  private readonly loginUsers: string;
  private readonly registry: StaticRegistry;
  private readonly processes: StaticProcessController;
  private requestedId3: number | null = null;

  constructor(options: SteamSimOptions) {
    this.steamDir = options.steamDir;
    this.loginUsers = join(options.steamDir, 'config', 'loginusers.vdf');
    this.registry = options.registry;
    this.processes = options.processes;
    this.knobs = {
      expiredSessions: [],
      wrongPassword: false,
      loginVerdict: null,
      selfUpdateMs: null,
      reactMs: 0,
      signInWhenAskedMs: null,
      signInAs: null,
      runningAs: null,
      ...options.knobs,
    };
    if (this.knobs.runningAs !== null) {
      this.processes.setRunning(STEAM_EXE, true);
      this.signInByHand(this.id3Of(this.knobs.runningAs) ?? UNKNOWN_ACCOUNT_ID3);
    }
  }

  static defaultRegistry(steamDir: string): Record<string, string | number> {
    return {
      [`${REG}\\SteamPath`]: steamDir.replace(/\\/g, '/').toLowerCase(),
      [`${REG}\\SteamExe`]: `${steamDir.replace(/\\/g, '/').toLowerCase()}/steam.exe`,
      [`${REG}\\AutoLoginUser`]: 'user_1',
      [`${REG}\\RunningAppID`]: 0,
      [`HKLM\\${STEAM_HKLM_KEY}\\InstallPath`]: steamDir,
    };
  }

  onStart(exe: string, args: readonly string[]): void {
    if (exe.replace(/^.*[\\/]/, '').toLowerCase() !== STEAM_EXE) return;
    if (args.includes('-shutdown')) return;
    const { reactMs, selfUpdateMs } = this.knobs;
    const start = (): void => {
      if (selfUpdateMs === null) {
        this.react(args);
        return;
      }
      this.bootstrapSays(STEAM_UPDATER_STARTUP_LINE);
      STEAM_UPDATE_LINES.forEach((line) => this.bootstrapSays(line));
      if (selfUpdateMs < 0) return;
      setTimeout(() => {
        STEAM_UPDATED_LINES.forEach((line) => this.bootstrapSays(line));
        setTimeout(() => this.react(args), 20);
      }, selfUpdateMs);
    };
    if (reactMs > 0) setTimeout(start, reactMs);
    else start();
  }

  /** Appends a line to the simulated steamui_login.txt the way the Steam client would. */
  steamSays(line: string): void {
    const file = loginLogPath(this.steamDir);
    mkdirSync(join(this.steamDir, 'logs'), { recursive: true });
    writeFileSync(file, `[2026-09-12 15:00:45] [ WaitingForServerResponse ] ${line}\n`, { flag: 'a' });
  }

  /** Appends a line to the simulated bootstrap_log.txt the way steam.exe's updater would. */
  bootstrapSays(line: string): void {
    mkdirSync(join(this.steamDir, 'logs'), { recursive: true });
    writeFileSync(bootstrapLogPath(this.steamDir), `[2026-09-11 12:56:02] ${line}\n`, { flag: 'a' });
  }

  /** Stands in for the user finishing the sign-in in the Steam window. */
  signInByHand(as: number = this.knobs.signInAs ?? this.requestedId3 ?? UNKNOWN_ACCOUNT_ID3): void {
    this.steamSays('SetLoginState: Success - OK');
    this.registry.set(ACTIVE_USER, as);
  }

  private react(args: readonly string[]): void {
    const users = parseLoginUsers(readFileSync(this.loginUsers, 'utf8'));
    if (args[0] === '-login') {
      const known = users.find((u) => u.accountName === args[1]);
      this.requestedId3 = known ? steamId3(known.steamId64) : null;
      if (args.length === 2) {
        this.steamSays('SetLoginState: WaitingForCredentials - OK');
        this.registry.set(ACTIVE_USER, 0);
        this.landsOnForm();
        return;
      }
      if (this.knobs.loginVerdict) {
        this.steamSays(`SetLoginState: WaitingForCredentials - ${this.knobs.loginVerdict}`);
        this.registry.set(ACTIVE_USER, 0);
        this.landsOnForm();
        return;
      }
      this.registry.set(ACTIVE_USER, this.knobs.wrongPassword ? 0 : known ? steamId3(known.steamId64) : UNKNOWN_ACCOUNT_ID3);
      if (this.knobs.wrongPassword) this.landsOnForm();
      return;
    }
    const auto = this.registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser');
    void auto.then((name) => {
      const user = users.find((u) => u.accountName.toLowerCase() === (name ?? '').toLowerCase());
      this.requestedId3 = user ? steamId3(user.steamId64) : null;
      const signedIn = user && !this.knobs.expiredSessions.includes(user.accountName);
      this.registry.set(ACTIVE_USER, signedIn ? steamId3(user.steamId64) : 0);
      if (!signedIn) this.landsOnForm();
    });
  }

  private landsOnForm(): void {
    const { signInWhenAskedMs } = this.knobs;
    if (signInWhenAskedMs === null) return;
    setTimeout(() => this.signInByHand(), signInWhenAskedMs);
  }

  private id3Of(login: string): number | null {
    try {
      const user = parseLoginUsers(readFileSync(this.loginUsers, 'utf8')).find((u) => u.accountName.toLowerCase() === login.toLowerCase());
      return user ? steamId3(user.steamId64) : null;
    } catch {
      return null;
    }
  }
}
