import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StaticProcessController } from '../../platform/processes';
import { EPIC_EXE, EPIC_EXE_RELATIVE, EPIC_HKLM_KEY, EPIC_UNINSTALL_KEY, EPIC_URI_COMMAND_KEY, SETTINGS_INI_RELATIVE } from '../epic/adapter';
import { launcherLogPath } from '../epic/launcher-log';
import { planSessionWrite, readSessionFromIni } from '../epic/session';

export interface EpicKnobs {
  /** Sessions the launcher rejects at start: a blob's data or the uid it signs in as; either form matches. */
  expired: string[];
  /** The launcher writes a rotated blob for the signed-in account on every start. */
  rotateOnStart: boolean;
  /** The sign-in fails with this text instead of looking at the session (a service outage, say). */
  signInError: string | null;
  /** Delay before the simulator reacts to a start; 0 = at once. */
  reactMs: number;
  /** After landing on its sign-in page, the simulated user signs in by hand after this long; null = never. */
  signInWhenAskedMs: number | null;
  /** The uid a manual sign-in lands on; required when signInWhenAskedMs is set. */
  signInAs: string | null;
  /** A uid the launcher is already signed in as when the run begins. */
  runningAs: string | null;
}

export interface EpicSimOptions {
  localAppData: string;
  processes: StaticProcessController;
  /** What "Epic's servers" know: which account each blob signs in as. */
  servers?: Map<string, string>;
  knobs?: Partial<EpicKnobs>;
}

/** A scripted Epic Games Launcher: hooked to a StaticProcessController's onStart, it reads [RememberMe], signs in (or not), and writes a new log. */
export class EpicSim {
  readonly knobs: EpicKnobs;
  readonly servers: Map<string, string>;
  readonly iniPath: string;
  readonly logPath: string;
  private readonly processes: StaticProcessController;
  private blobCounter = 0;

  constructor(options: EpicSimOptions) {
    this.iniPath = join(options.localAppData, SETTINGS_INI_RELATIVE);
    this.logPath = launcherLogPath(options.localAppData);
    this.processes = options.processes;
    this.servers = options.servers ?? new Map();
    this.knobs = {
      expired: [],
      rotateOnStart: false,
      signInError: null,
      reactMs: 0,
      signInWhenAskedMs: null,
      signInAs: null,
      runningAs: null,
      ...options.knobs,
    };
    if (this.knobs.runningAs !== null) {
      this.processes.setRunning(EPIC_EXE, true);
      this.writeLog([this.logHeader(), '[..]FAccountService::AutoSignIn', `[..]FAccountService::OnLoginComplete - 0 TRUE ${this.knobs.runningAs} `]);
    }
  }

  static defaultRegistry(o: { installLocation: string; programData: string }): Record<string, string> {
    return {
      [`HKLM\\${EPIC_UNINSTALL_KEY}\\InstallLocation`]: `${o.installLocation}\\`,
      [`HKLM\\${EPIC_URI_COMMAND_KEY}\\`]: `"${join(o.installLocation, 'Launcher', EPIC_EXE_RELATIVE)}" %1`,
      [`HKLM\\${EPIC_HKLM_KEY}\\AppDataPath`]: `${join(o.programData, 'Epic', 'EpicGamesLauncher', 'Data')}\\`,
    };
  }

  onStart(exe: string, args: readonly string[]): void {
    if (exe.replace(/^.*[\\/]/, '').toLowerCase() !== EPIC_EXE.toLowerCase()) return;
    if (args[0] === '<close>') return;
    const { reactMs } = this.knobs;
    if (reactMs > 0) setTimeout(() => this.react(), reactMs);
    else this.react();
  }

  freshBlob(): string {
    this.blobCounter++;
    return Buffer.from(`fresh-blob-${this.blobCounter}-${'x'.repeat(40)}`).toString('base64');
  }

  /** The launcher stamps its first line with the time, which is what tells one run's log from the next; a per-process counter alone repeats after a restart. */
  private logHeader(): string {
    return `Log file open, ${new Date().toISOString()} run ${++this.blobCounter}`;
  }

  /** Starts a new EpicGamesLauncher.log the way the launcher does on every start. */
  writeLog(lines: string[]): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    writeFileSync(this.logPath, `${lines.join('\r\n')}\r\n`);
  }

  appendLog(lines: string[]): void {
    writeFileSync(this.logPath, `${lines.join('\r\n')}\r\n`, { flag: 'a' });
  }

  /** Stands in for the user signing in on the launcher's page; unless writeIni is false, the launcher then remembers a fresh blob for that uid. */
  signInByHand(as: string | null = this.knobs.signInAs, opts: { writeIni?: boolean } = {}): void {
    if (as === null) throw new Error('EpicSim.signInByHand needs a uid: pass one or set knobs.signInAs');
    this.appendLog(['[..]FAccountService::SignIn (exchange code)', `[..]FAccountService::OnLoginComplete - 0 TRUE ${as} `]);
    if (opts.writeIni !== false) {
      const fresh = this.freshBlob();
      this.servers.set(fresh, as);
      writeFileSync(
        this.iniPath,
        planSessionWrite(readFileSync(this.iniPath, 'utf8'), { v: 1, rememberMe: { enable: 'True', data: fresh }, offline: null }).text,
      );
    }
  }

  private react(): void {
    const text = readFileSync(this.iniPath, 'utf8');
    const disk = readSessionFromIni(text);
    const lines = [this.logHeader(), '[..]FAccountService::AutoSignIn'];
    let signedIn = false;
    if (disk.remembered && disk.data && this.knobs.signInError !== null) {
      lines.push(`[..]FAccountService::OnLoginComplete - 0 FALSE  errormessage=${this.knobs.signInError}`);
    } else if (disk.remembered && disk.data) {
      const id = this.servers.get(disk.data);
      if (!id || this.knobs.expired.includes(disk.data) || this.knobs.expired.includes(id)) {
        lines.push(
          "[..]FAccountService::OnLoginComplete - 0 FALSE  errormessage=Sorry the refresh token 'deadbeefdeadbeefdeadbeefdeadbeef' is invalid. Reason: TOKEN_EXPIRED errorcode=18036 errorpath=x",
        );
      } else {
        lines.push(`[..]FAccountService::OnLoginComplete - 0 TRUE ${id} `);
        signedIn = true;
        if (this.knobs.rotateOnStart) {
          const fresh = this.freshBlob();
          this.servers.set(fresh, id);
          writeFileSync(this.iniPath, planSessionWrite(text, { v: 1, rememberMe: { enable: 'True', data: fresh }, offline: null }).text);
        }
      }
    }
    this.writeLog(lines);
    if (!signedIn) this.landsOnPage();
  }

  private landsOnPage(): void {
    const { signInWhenAskedMs } = this.knobs;
    if (signInWhenAskedMs === null) return;
    setTimeout(() => this.signInByHand(), signInWhenAskedMs);
  }
}
