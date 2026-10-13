import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StaticProcessController } from '../../platform/processes';
import type { StaticRegistry } from '../../platform/registry';
import { BATTLENET_EXE, BATTLENET_LAUNCHER_EXE, BATTLENET_UNINSTALL_KEY, BATTLENET_URI_COMMAND_KEY } from '../battlenet/adapter';
import { parseConfig, planSavedAccountNames, readClientSettings } from '../battlenet/config';
import { PRODUCTS, UNINSTALL_KEY } from '../battlenet/products';
import { UNIFIED_AUTH_KEY } from '../battlenet/session';

const TOKEN_NAME = 'AA11BB22';
export const LOGGING_STARTED_LINE = 'I 2026-09-13 03:20:48.092586 [Main] {Main} Logging started for Battle.net build 2.52.11.17778';
/** The products the simulated client knows: the two verified in the product table, which defaultRegistry installs. */
const DEFAULT_PRODUCTS = ['prometheus', 'hs_beta'];
const CLIENT_IMAGES = new Set([BATTLENET_EXE, BATTLENET_LAUNCHER_EXE].map((name) => name.toLowerCase()));

export interface BattlenetKnobs {
  /** Tokens the servers reject at start, each given as its hex or as the uid it signs in as. */
  rejected: string[];
  /** The client writes a fresh token after every successful sign-in. */
  rotateOnSignIn: boolean;
  /** Delay before the simulator reacts to a start; 0 = at once. */
  reactMs: number;
  /** After landing on its login page, the simulated user signs in by hand after this long; null = never. */
  signInWhenAskedMs: number | null;
  /** The uid a manual sign-in lands on; required when signInWhenAskedMs is set. */
  signInAs: string | null;
  /** A uid the client is already signed in as when the run begins. */
  runningAs: string | null;
  /** Codenames the client wants to update before they run: their install state says Update, and --exec for them only selects the game page. */
  updatesPending: string[];
  /** Codenames whose game runs outside the client (a process under its folder): each client start logs it running, and --exec for it only selects the game page. Needs gamesDir. */
  gamesRunning: string[];
}

export interface BattlenetSimOptions {
  appData: string;
  localAppData: string;
  registry: StaticRegistry;
  processes: StaticProcessController;
  /** What Blizzard's servers know: which account (uid) each token (hex) signs in as. */
  servers?: Map<string, string>;
  /** The login each account (uid) signs in with; the client keys its token check on the first saved login. */
  logins?: Record<string, string>;
  tokenName?: string;
  /** Codenames the client logs an install state for and can start; defaults to the two verified products. */
  products?: string[];
  /** The folder the games are installed under, as the registry names them; the gamesRunning knob puts a game process there. */
  gamesDir?: string;
  knobs?: Partial<BattlenetKnobs>;
}

/** A scripted Battle.net client: hooked to a StaticProcessController's onStart, it reads UnifiedAuth, signs in (or waits on its login page), and starts a new log. */
export class BattlenetSim {
  readonly knobs: BattlenetKnobs;
  readonly servers: Map<string, string>;
  readonly logins: Record<string, string>;
  readonly tokenName: string;
  readonly products: string[];
  readonly configPath: string;
  readonly logsDir: string;
  private readonly registry: StaticRegistry;
  private readonly processes: StaticProcessController;
  private readonly gamesDir: string | null;
  private runCounter = 0;
  private hexCounter = 0;

  constructor(options: BattlenetSimOptions) {
    this.registry = options.registry;
    this.processes = options.processes;
    this.gamesDir = options.gamesDir ?? null;
    this.servers = options.servers ?? new Map();
    this.logins = options.logins ?? {};
    this.tokenName = options.tokenName ?? TOKEN_NAME;
    this.products = options.products ?? DEFAULT_PRODUCTS;
    this.configPath = join(options.appData, 'Battle.net', 'Battle.net.config');
    this.logsDir = join(options.localAppData, 'Battle.net', 'Logs');
    this.knobs = {
      rejected: [],
      rotateOnSignIn: false,
      reactMs: 0,
      signInWhenAskedMs: null,
      signInAs: null,
      runningAs: null,
      updatesPending: [],
      gamesRunning: [],
      ...options.knobs,
    };
    for (const codename of [...this.knobs.gamesRunning]) this.gameStarts(codename);
    if (this.knobs.runningAs !== null) {
      this.processes.setRunning(BATTLENET_EXE, true);
      this.writeLog([LOGGING_STARTED_LINE, ...this.installStateLines(), ...this.runningGameLines(), this.signedInLine(this.knobs.runningAs)]);
    }
  }

  static defaultRegistry(o: { installDir: string; gamesDir: string }): Record<string, string> {
    return {
      [`HKLM\\${BATTLENET_UNINSTALL_KEY}\\InstallLocation`]: o.installDir,
      [`HKLM\\${BATTLENET_UNINSTALL_KEY}\\DisplayName`]: 'Battle.net',
      [`HKLM\\${BATTLENET_UNINSTALL_KEY}\\UninstallString`]:
        '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=battle.net --displayname="Battle.net"',
      [`HKLM\\${BATTLENET_URI_COMMAND_KEY}\\`]: `"${join(o.installDir, BATTLENET_EXE)}" --uri="%1"`,
      [`HKLM\\${UNINSTALL_KEY}\\Overwatch\\DisplayName`]: 'Overwatch',
      [`HKLM\\${UNINSTALL_KEY}\\Overwatch\\InstallLocation`]: join(o.gamesDir, 'Overwatch'),
      [`HKLM\\${UNINSTALL_KEY}\\Overwatch\\UninstallString`]:
        '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=prometheus --displayname="Overwatch"',
      [`HKLM\\${UNINSTALL_KEY}\\Hearthstone\\DisplayName`]: 'Hearthstone',
      [`HKLM\\${UNINSTALL_KEY}\\Hearthstone\\InstallLocation`]: join(o.gamesDir, 'Hearthstone'),
      [`HKLM\\${UNINSTALL_KEY}\\Hearthstone\\UninstallString`]:
        '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=hs_beta --displayname="Hearthstone"',
      [`HKLM\\${UNINSTALL_KEY}\\{AEB35C6C-B6D4-4AA0-8452-DE699737B5F6}\\UninstallString`]: 'MsiExec.exe /X{AEB35C6C-B6D4-4AA0-8452-DE699737B5F6}',
    };
  }

  /** A product.db with the same string layout as the real one (protobuf length-delimited fields). */
  static productDb(): Buffer {
    const rec = (s: string): Buffer => Buffer.concat([Buffer.from([0x0a, s.length]), Buffer.from(s, 'latin1')]);
    return Buffer.concat([
      rec('agent'),
      rec('agent'),
      rec('C:/ProgramData/Battle.net/Agent'),
      rec('prometheus'),
      rec('pro'),
      rec('C:/Users/someone/Games/Overwatch'),
      rec('enUS'),
    ]);
  }

  ensureProductDb(programData: string): void {
    const dir = join(programData, 'Battle.net', 'Agent');
    const file = join(dir, 'product.db');
    if (existsSync(file)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, BattlenetSim.productDb());
  }

  onStart(exe: string, args: readonly string[]): void {
    if (!CLIENT_IMAGES.has(exe.replace(/^.*[\\/]/, '').toLowerCase())) return;
    if (args[0] === '<close>') return;
    if (args[0]?.startsWith('--exec=')) {
      // A second Battle.net.exe forwards the command to the running client, which logs what it does with it.
      const programCode = args[0]!.replace('--exec=launch ', '');
      this.appendLog(this.launchLines(programCode));
      return;
    }
    const { reactMs } = this.knobs;
    if (reactMs > 0) setTimeout(() => this.react(), reactMs);
    else this.react();
  }

  freshHex(): string {
    this.hexCounter++;
    return `01000000d08c9ddf${this.hexCounter.toString(16).padStart(4, '0')}${'ab'.repeat(24)}`;
  }

  tokenPath(name = this.tokenName): string {
    return `HKCU\\${UNIFIED_AUTH_KEY}\\${name}`;
  }

  firstSaved(): string | null {
    return readClientSettings(parseConfig(readFileSync(this.configPath, 'utf8')).doc).savedAccountNames[0] ?? null;
  }

  /** What the client does at every sign-in: the signed-in login goes to the front of SavedAccountNames. */
  clientSignedIn(id: string): void {
    const text = readFileSync(this.configPath, 'utf8');
    try {
      writeFileSync(this.configPath, planSavedAccountNames(text, this.logins[id]!).text);
    } catch {
      // The client rewrites the file in its own layout whatever it looked like before.
      const doc = JSON.parse(text) as { Client: { SavedAccountNames: string } };
      const login = this.logins[id]!;
      doc.Client.SavedAccountNames = [login, ...doc.Client.SavedAccountNames.split(',').filter((s) => s !== login)].join(',');
      writeFileSync(this.configPath, JSON.stringify(doc, null, 4));
    }
  }

  async currentTokens(): Promise<{ name: string; hex: string }[]> {
    return (await this.registry.listValues('HKCU', UNIFIED_AUTH_KEY)).map((v) => ({ name: v.name, hex: v.data.toLowerCase() }));
  }

  writeLog(lines: string[]): string {
    this.runCounter++;
    mkdirSync(this.logsDir, { recursive: true });
    const file = join(this.logsDir, `battle.net-20260913T0320${String(this.runCounter).padStart(2, '0')}.000000.log`);
    writeFileSync(file, `${lines.join('\r\n')}\r\n`);
    return file;
  }

  appendLog(lines: string[]): void {
    const newest = readdirSync(this.logsDir)
      .filter((n) => n.startsWith('battle.net-'))
      .sort()
      .pop()!;
    writeFileSync(join(this.logsDir, newest), `${lines.join('\r\n')}\r\n`, { flag: 'a' });
  }

  signedInLine(id: string): string {
    return `I 2026-09-13 03:21:00.000000 [BNLogin] {Main} Logged into Battle.net successfully. |bnet=1:0:${id}|game=2:100000000:0a1b2c3`;
  }

  /** What the client logs for each product it knows, right after its log opens (2026-09-24): up to date and playable, or an update pending. */
  installStateLines(): string[] {
    return this.products.map((codename) => {
      const name = (PRODUCTS[codename]?.name ?? codename).replace(/\s+/g, '');
      return this.knobs.updatesPending.includes(codename)
        ? `D 2026-09-13 03:20:49.000000 [ProductState] {Main} InstallState (${codename}): currentOperation=Update currentOperationStatus=New playable=0 regionalVersions=(us: {playable:false config_key:8ed16441fd9d4694ed1ac7bb332a755f}) latestVersion=153619 currentStage=Setup`
        : `D 2026-09-13 03:20:49.000000 [ProductState] {Main} InstallState (${codename}): currentOperation=UpToDate currentOperationStatus=Paused installed=1 hasInstallModificationOptions=1 installPath=C:/Users/someone/Games/${name} sharedContainerSubpath=_retail_ playable=1 canCreateShortcut=1 selectedRegion=us`;
    });
  }

  /**
   * What the client logs for --exec=launch <ProgramCode> (2026-09-19): the game start for a playable product it
   * knows; only the page selection for a product that needs an update or that it does not know (2026-09-24), or
   * whose game it sees running (2026-10-10).
   */
  launchLines(programCode: string): string[] {
    const lines = [
      'D 2026-09-13 04:21:00.000000 [CommandQueue] {Main} Received IPC Message: IPC_COMMAND',
      `D 2026-09-13 04:21:00.000100 [GameController] {Main} Selecting game family by id: ${programCode}`,
    ];
    const codename = Object.keys(PRODUCTS).find((c) => PRODUCTS[c]!.programCode.toLowerCase() === programCode.toLowerCase()) ?? null;
    if (!codename || !this.products.includes(codename) || this.knobs.updatesPending.includes(codename) || this.knobs.gamesRunning.includes(codename))
      return lines;
    const exe = (PRODUCTS[codename]?.name ?? codename).replace(/\s+/g, '');
    return [
      ...lines,
      `I 2026-09-13 04:21:00.000200 [GameLaunchController] {Main} LaunchBinary: uid=${codename} selectedRegion=US binaryType=game`,
      `D 2026-09-13 04:21:00.000300 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=Off newStatus=Pending agentUid=${codename}`,
      `D 2026-09-13 04:21:00.000400 [ProductState] {Main} InstallState (${codename}): GameLaunching=1`,
      `I 2026-09-13 04:21:00.600000 [InstallManager] {Main} Launched C:/Users/someone/Games/${exe}/_retail_/${exe}.exe with args: -uid ${codename}, pid: 15412`,
      `D 2026-09-13 04:21:00.650000 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=Pending newStatus=On agentUid=${codename}`,
      `D 2026-09-13 04:21:00.650100 [InstallManager] {Main} Game is running: ${codename}`,
      `D 2026-09-13 04:21:00.650200 [ProductState] {Main} InstallState (${codename}): gameRunning=1 isGameProcessRunning=1 GameLaunching=0`,
    ];
  }

  /** A game starts outside the client: its process appears under the game's folder, and every client start from now on logs it running. */
  gameStarts(codename: string): void {
    if (!this.gamesDir) throw new Error('BattlenetSim.gameStarts needs gamesDir');
    if (!this.knobs.gamesRunning.includes(codename)) this.knobs.gamesRunning.push(codename);
    const image = this.gameImage(codename);
    if (this.processes.processes.some((p) => p.name.toLowerCase() === image.toLowerCase())) return;
    const folder = image.replace(/\.exe$/, '');
    this.processes.processes.push({ name: image, pid: 15412 + this.processes.processes.length, path: join(this.gamesDir, folder, '_retail_', image) });
  }

  /** The running game exits: its process goes, and a running client logs the end as the real one does. */
  async gameExits(codename: string): Promise<void> {
    const image = this.gameImage(codename).toLowerCase();
    this.processes.processes = this.processes.processes.filter((p) => p.name.toLowerCase() !== image);
    this.knobs.gamesRunning.splice(0, this.knobs.gamesRunning.length, ...this.knobs.gamesRunning.filter((c) => c !== codename));
    if (!(await this.processes.isRunning(BATTLENET_EXE))) return;
    this.appendLog([
      `D 2026-09-13 04:40:00.000000 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=On newStatus=Off agentUid=${codename}`,
      `D 2026-09-13 04:40:00.000100 [ProductState] {Main} InstallState (${codename}): gameRunning=0 isGameProcessRunning=0`,
    ]);
  }

  private gameImage(codename: string): string {
    return `${(PRODUCTS[codename]?.name ?? codename).replace(/\s+/g, '')}.exe`;
  }

  /** What a starting client logs for a game it finds running (2026-10-10), a few seconds after its install states. */
  private runningGameLines(): string[] {
    return this.knobs.gamesRunning.flatMap((codename) => [
      `D 2026-09-13 03:20:56.000000 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=Off newStatus=On agentUid=${codename}`,
      `D 2026-09-13 03:20:56.000100 [ProductState] {Main} InstallState (${codename}): gameRunning=1 isGameProcessRunning=1`,
    ]);
  }

  /** Stands in for the user signing in on the client's login page. */
  signInByHand(as: string | null = this.knobs.signInAs, opts: { writeToken?: boolean } = {}): void {
    if (as === null) throw new Error('BattlenetSim.signInByHand needs a uid: pass one or set knobs.signInAs');
    if (opts.writeToken !== false) {
      const fresh = this.freshHex();
      this.servers.set(fresh, as);
      this.registry.setBinaryValue(this.tokenPath(), fresh);
    }
    this.clientSignedIn(as);
    this.appendLog(['I 2026-09-13 03:21:00.000000 [GSAccountProvider] {Main} Login triggered. entityId=1:0:' + as, this.signedInLine(as)]);
  }

  private react(): void {
    this.processes.setRunning(BATTLENET_EXE, true);
    void (async () => {
      const tokens = await this.currentTokens();
      const lines = [
        LOGGING_STARTED_LINE,
        ...this.installStateLines(),
        ...this.runningGameLines(),
        'I 2026-09-13 03:20:55.118026 [Frontend] {Main} Attempting to show main window. isMinimizedOnStartup=false',
      ];
      const token = tokens[0];
      let signedIn = false;
      if (token) {
        const id = this.servers.get(token.hex);
        if (!id || this.firstSaved() !== this.logins[id]) {
          // What the real client does with a token for another login than the first in SavedAccountNames (2026-09-13).
          lines.push('I 2026-09-13 03:20:54.000000 [BNLogin] {Main} BattleNetLogin::DeleteToken(): Deleting registry token because !m_lastEmailUsed.empty()');
          this.registry.delete(this.tokenPath(token.name));
        } else if (this.rejects(token.hex, id)) {
          lines.push('E 2026-09-13 03:20:54.000000 [BNLogin] {Main} Login failed. error=ERROR_AUTH_TOKEN_EXPIRED');
          this.registry.delete(this.tokenPath(token.name));
        } else {
          lines.push(this.signedInLine(id));
          this.clientSignedIn(id);
          signedIn = true;
          if (this.knobs.rotateOnSignIn) {
            const fresh = this.freshHex();
            this.servers.set(fresh, id);
            this.registry.setBinaryValue(this.tokenPath(token.name), fresh);
          }
        }
      }
      this.writeLog(lines);
      if (!signedIn) this.landsOnLoginPage();
    })();
  }

  private landsOnLoginPage(): void {
    const { signInWhenAskedMs } = this.knobs;
    if (signInWhenAskedMs === null) return;
    setTimeout(() => this.signInByHand(), signInWhenAskedMs);
  }

  private rejects(hex: string, id: string): boolean {
    return this.knobs.rejected.some((r) => r.toLowerCase() === hex || r === id);
  }
}
