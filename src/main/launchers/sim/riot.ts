import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StaticProcessController } from '../../platform/processes';
import {
  RIOT_CLIENT_EXE,
  RIOT_CLIENT_UNINSTALL_KEY,
  RIOT_CLIENT_WINDOW_EXE,
  RIOT_INSTALLS_FILE,
  RIOT_UNINSTALL_ROOT,
  RIOT_URI_COMMAND_KEY,
  SESSION_FILE,
} from '../riot/adapter';
import { clientLogDir } from '../riot/client-log';
import { gameImagesOf, parseProductId, productDisplayName, type RiotProductId } from '../riot/products';
import { readSession, spliceSessionBlock, type RiotSession } from '../riot/session';
import { solidIco } from './artwork-fetch';

export const RIOT_SIM_BUILD = '140.0.7.5045';
/** The product the simulated install carries unless a caller says otherwise: the one verified on a real machine. */
export const RIOT_SIM_PRODUCTS: readonly string[] = ['valorant.live'];

export interface RiotKnobs {
  /** Saved sign-ins the client refuses at start with invalid_grant: a refresh token's fingerprint, or the account id it signs in as. */
  rejected: string[];
  /** The client swaps the refresh token for a new one and rewrites the file at every start from a saved sign-in, as the real one does. */
  rotateOnStart: boolean;
  /** The restore fails with this rso-auth error instead of a verdict on the saved sign-in (a service or network failure). */
  authError: string | null;
  /** Delay before the simulator reacts to a start; 0 = at once. */
  reactMs: number;
  /** After landing on its login page, the simulated user signs in by hand after this long; null = never. */
  signInWhenAskedMs: number | null;
  /** The account id a manual sign-in lands on; required when signInWhenAskedMs is set. */
  signInAs: string | null;
  /** The simulated user ticks "Stay signed in". Unticked, the client writes `riot-client: null` at exit and keeps nothing. */
  staySignedIn: boolean;
  /** An account id the client is already running and signed in as when the run begins. */
  runningAs: string | null;
  /** `<product>.<patchline>` ids the client reports as OutOfDate: a launch request for one only opens its page, with Update on it. */
  updatesPending: string[];
  /** A start with the shortcut's launch arguments starts the game once signed in, as build 77 did. Off (the default, as build 140 behaves with Riot's auto-launch flag off), the client only opens the game's page and says "Auto-launch is disabled". */
  directLaunch: boolean;
  /** The client refuses the launch request its Play button sends (One Launch pressing Play for the user), so the launch hands over to Play. */
  pressPlayFails: boolean;
}

export interface RiotSimOptions {
  localAppData: string;
  processes: StaticProcessController;
  knobs?: Partial<RiotKnobs>;
  /** The products the simulated client knows (and ensureProducts lays down); a launch request for any other only sets its context. */
  products?: readonly string[];
}

const LAUNCH_ARG = /^--launch-(product|patchline)=([a-z0-9_]+)$/i;

/** The product a command line asks the client to launch, as its shortcut passes it, or null. */
export function parseLaunchArgs(args: readonly string[]): RiotProductId | null {
  let product: string | null = null;
  let patchline = 'live';
  for (const arg of args) {
    const m = LAUNCH_ARG.exec(arg);
    if (!m) continue;
    if (m[1]!.toLowerCase() === 'product') product = m[2]!.toLowerCase();
    else patchline = m[2]!.toLowerCase();
  }
  return product ? parseProductId(`${product}.${patchline}`) : null;
}

/** Build 140's launch pipeline, as the client logged it from the product context to the point where the game can start. */
const LAUNCH_PIPELINE: readonly string[] = [
  'SelfUpdate',
  'LifecycleSync',
  'LeagueRegion',
  'Login',
  'HomeBaseCountry',
  'Eula',
  'ClientConfig',
  'VanguardHealthCheckStatus',
  'PatchlineData',
  'RiotIdRequired',
  'AccountAlias',
  'LeagueRegionElection',
  'PlayerAffinitySync',
  'AppRepairAndUpdate',
  'PatchStatus',
  'AgeRestriction',
  'Permissions',
  'LaunchRestriction',
  'PatchlineLaunchDisabled',
  'VngAccountRequired',
  'RestartRequired',
  'WaitForLaunch',
];

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const LOCKFILE = 'C:/Users/Placeholder/AppData/Local/Riot Games/Riot Client/Config/lockfile_';

/** A signed-out file in the build 140 shape, with a placeholder device cookie, for a session file built from nothing. */
const TEMPLATE = [
  'psl:',
  '    authorization:',
  '        riot-client: null',
  'riot-login:',
  '    persist: null',
  'rso-authenticator:',
  '    tdid:',
  '        domain: "placeholder.example"',
  '        expiryTime: 1790000000',
  '        hostOnly: false',
  '        httpOnly: true',
  '        name: "tdid"',
  '        path: "/"',
  '        persistent: true',
  '        secureOnly: true',
  `        value: "eyJ${'placeholder'.repeat(19)}"`,
  '',
].join('\r\n');

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** An id token whose payload names `uid`, in the shape the reader expects: three base64url parts, a UUID `sub`, a placeholder Riot ID. Signed by nobody. */
export function fakeIdToken(uid: string, riotId: { gameName: string; tagLine: string } = { gameName: 'Placeholder', tagLine: '0000' }): string {
  const payload = {
    sub: uid,
    acct: { game_name: riotId.gameName, tag_line: riotId.tagLine, state: 'ENABLED' },
    iss: 'https://auth.placeholder.example',
    iat: 1760000000,
    exp: 1760003600,
  };
  return `${b64url('{"alg":"none","typ":"JWT"}')}.${b64url(JSON.stringify(payload))}.placeholdersignature`;
}

/** The `riot-client` block's lines (at its field indent) for a sign-in as `uid` with the given refresh token. */
export function sessionBlockLines(uid: string, refreshToken: string, opts: { writeCount?: number; at?: number } = {}): string[] {
  const at = opts.at ?? 1760000000000;
  return [
    'claims: {}',
    `id_token: "${fakeIdToken(uid)}"`,
    'is_dpop_bound: false',
    `last_token_creation_time: ${at}`,
    `original_token_creation_time: ${at}`,
    `refresh_token: "${refreshToken}"`,
    `refresh_token_write_count: ${opts.writeCount ?? 1}`,
    `refresh_tokens_session_id: "${SESSION_ID}"`,
    'scopes:',
    '- "openid"',
    '- "link"',
    '- "ban"',
    '- "lol_region"',
    '- "lol"',
    '- "account"',
  ];
}

/** A whole session file holding a sign-in as `uid`: what One Launch stores per account, and what a scenario seeds. */
export function fakeSessionFile(uid: string, refreshToken: string, opts: { writeCount?: number } = {}): string {
  return spliceSessionBlock(TEMPLATE, sessionBlockLines(uid, refreshToken, opts));
}

function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function localIso(ms: number): string {
  return localStamp(ms).replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
}

/**
 * A scripted Riot Client (build 140): hooked to a StaticProcessController's onStart, it reads the session
 * file, signs in from it (or lands on its login page), rotates the refresh token, and writes a new run
 * log with the PSL states the real client logs (docs/adapters/riot.md › Log). A start with the shortcut's
 * --launch-product and --launch-patchline launches that game once signed in: the product context, the
 * patch state, the launch pipeline, "Launch starting", and the game's own process. The same request handed
 * to a running core (as the singleton does) only opens the game's page, as the real client did; a product
 * that needs an update only gets its page either way. The core's close appends the clean-exit lines; the
 * window processes are left to the controller, as the real ones are left behind.
 */
export class RiotSim {
  readonly knobs: RiotKnobs;
  readonly sessionPath: string;
  readonly logDir: string;
  private readonly processes: StaticProcessController;
  private readonly products: readonly string[];
  private runCounter = 0;
  private tokenCounter = 0;
  private lastStamp = 0;
  private logFile: string | null = null;
  private clock = 0;
  /** Refresh tokens the servers refuse for good: those of every sign-in the client's own Sign out ended. */
  private readonly revoked = new Set<string>();
  /** The current run signed in by hand without "Stay signed in", so the client forgets it at exit. */
  private forgetAtExit = false;
  /** The core is up (the simulator's own view: a kill through the controller is not seen, as it sends no start). */
  private coreRunning = false;
  private signedIn = false;

  constructor(options: RiotSimOptions) {
    this.sessionPath = join(options.localAppData, 'Riot Games', 'Riot Client', 'Data', SESSION_FILE);
    this.logDir = clientLogDir(options.localAppData);
    this.processes = options.processes;
    this.products = options.products ?? RIOT_SIM_PRODUCTS;
    this.knobs = {
      rejected: [],
      rotateOnStart: true,
      authError: null,
      reactMs: 0,
      signInWhenAskedMs: null,
      signInAs: null,
      staySignedIn: true,
      runningAs: null,
      updatesPending: [],
      directLaunch: false,
      pressPlayFails: false,
      ...options.knobs,
    };
    const { runningAs } = this.knobs;
    if (runningAs !== null) {
      if (this.currentSession()?.accountId !== runningAs) this.writeSessionFor(runningAs);
      this.processes.setRunning(RIOT_CLIENT_EXE, true);
      this.processes.setRunning(RIOT_CLIENT_WINDOW_EXE, true);
      this.coreRunning = true;
      this.signedIn = true;
      this.writeLog([...this.startLines(), ...this.restoredLines()]);
    }
  }

  static defaultRegistry(o: { installDir: string; gamesDir: string; programData: string; products?: readonly string[] }): Record<string, string> {
    const forward = (p: string): string => p.replace(/\\/g, '/');
    const seed: Record<string, string> = {
      [`HKCU\\${RIOT_CLIENT_UNINSTALL_KEY}\\InstallLocation`]: `${forward(o.installDir)}/`,
      [`HKLM\\${RIOT_URI_COMMAND_KEY}\\`]: `"${join(o.installDir, RIOT_CLIENT_EXE)}" --app-command="%1"`,
    };
    for (const id of o.products ?? RIOT_SIM_PRODUCTS) {
      const parsed = parseProductId(id);
      if (!parsed) continue;
      seed[`HKCU\\${RIOT_UNINSTALL_ROOT}\\Riot Game ${id}\\DisplayName`] = productDisplayName(parsed.product);
      seed[`HKCU\\${RIOT_UNINSTALL_ROOT}\\Riot Game ${id}\\InstallLocation`] = forward(RiotSim.installFolder(o.gamesDir, id));
      seed[`HKCU\\${RIOT_UNINSTALL_ROOT}\\Riot Game ${id}\\DisplayIcon`] = forward(RiotSim.iconPath(o.programData, id));
    }
    return seed;
  }

  /** The product's icon beside its metadata, `<product>.<patchline>.ico`, which the Uninstall key's DisplayIcon also names. */
  static iconPath(programData: string, id: string): string {
    return join(programData, 'Riot Games', 'Metadata', id, `${id}.ico`);
  }

  /** Where a product lives under the games folder: `<Name>\<patchline>`, as the real installer lays it out. */
  static installFolder(gamesDir: string, id: string): string {
    const parsed = parseProductId(id);
    return parsed ? join(gamesDir, productDisplayName(parsed.product), parsed.patchline) : join(gamesDir, id);
  }

  /**
   * Lays down what the real installer leaves under %ProgramData%\Riot Games and the games folder for each
   * product: the metadata folder with its settings file and `.ok` marker, the install folder, and
   * RiotClientInstalls.json naming the client. Files that exist are left alone.
   */
  static ensureProducts(o: { programData: string; installDir: string; gamesDir: string; products?: readonly string[] }): void {
    const forward = (p: string): string => p.replace(/\\/g, '/');
    const exe = forward(join(o.installDir, RIOT_CLIENT_EXE));
    const metadata = join(o.programData, 'Riot Games', 'Metadata');
    const associated: Record<string, string> = {};
    for (const id of o.products ?? RIOT_SIM_PRODUCTS) {
      const folder = join(metadata, id);
      const install = RiotSim.installFolder(o.gamesDir, id);
      mkdirSync(folder, { recursive: true });
      mkdirSync(install, { recursive: true });
      const settings = join(folder, `${id}.product_settings.yaml`);
      if (!existsSync(settings)) {
        writeFileSync(
          settings,
          [
            'auto_patching_enabled_by_player: false',
            'patching_policy: "manual"',
            `product_install_full_path: "${forward(install)}"`,
            `product_install_root: "${forward(o.gamesDir)}"`,
            'should_repair: false',
            '',
          ].join('\n'),
        );
      }
      const ok = join(folder, `${id}.ok`);
      if (!existsSync(ok)) writeFileSync(ok, '');
      const icon = RiotSim.iconPath(o.programData, id);
      if (!existsSync(icon)) writeFileSync(icon, solidIco(64, [224, 60, 72]));
      associated[`${forward(install)}/`] = exe;
    }
    const installs = join(o.programData, 'Riot Games', RIOT_INSTALLS_FILE);
    if (!existsSync(installs)) writeFileSync(installs, JSON.stringify({ associated_client: associated, rc_default: exe, rc_live: exe }, null, 2));
  }

  onStart(exe: string, args: readonly string[]): void {
    const image = exe.replace(/^.*[\\/]/, '').toLowerCase();
    if (image !== RIOT_CLIENT_EXE.toLowerCase()) return;
    if (args[0] === '<close>') {
      this.coreClosed();
      return;
    }
    const launch = parseLaunchArgs(args);
    // The core is a singleton: a launch request while it runs is handed to it. A plain start is always a new run, as the adapter never starts a running client.
    const run = (): void => (launch && this.coreRunning ? this.forwardedLaunch(launch) : this.react(launch));
    const { reactMs } = this.knobs;
    if (reactMs > 0) setTimeout(run, reactMs);
    else run();
  }

  freshToken(): string {
    this.tokenCounter++;
    return `placeholder-refresh-${this.tokenCounter}-${'x'.repeat(48)}`;
  }

  /** The session the file holds now, or null when it is absent, signed out, or not in a shape the reader knows. */
  currentSession(): RiotSession | null {
    if (!existsSync(this.sessionPath)) return null;
    const read = readSession(readFileSync(this.sessionPath, 'utf8'));
    return read.kind === 'session' ? read.session : null;
  }

  /** Writes a sign-in as `uid` with a fresh refresh token into the file (or into a fresh file when there is none), keeping everything else. */
  writeSessionFor(uid: string, opts: { writeCount?: number } = {}): string {
    const token = this.freshToken();
    const text = existsSync(this.sessionPath) ? readFileSync(this.sessionPath, 'utf8') : TEMPLATE;
    mkdirSync(join(this.sessionPath, '..'), { recursive: true });
    writeFileSync(this.sessionPath, spliceSessionBlock(text, sessionBlockLines(uid, token, { writeCount: opts.writeCount ?? 1, at: Date.now() })));
    return token;
  }

  /** The client's own signed-out state: `riot-client: null`, nothing else touched. */
  writeSignedOut(): void {
    const text = existsSync(this.sessionPath) ? readFileSync(this.sessionPath, 'utf8') : TEMPLATE;
    mkdirSync(join(this.sessionPath, '..'), { recursive: true });
    writeFileSync(this.sessionPath, spliceSessionBlock(text, null));
  }

  /** Starts a new run log the way the client does at every start, named by the local start time and a process id. */
  writeLog(lines: string[]): string {
    mkdirSync(this.logDir, { recursive: true });
    this.runCounter++;
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    this.logFile = join(this.logDir, `${localStamp(this.lastStamp)}_${10000 + this.runCounter}_Riot Client.log`);
    writeFileSync(this.logFile, `${lines.join('\r\n')}\r\n`);
    return this.logFile;
  }

  appendLog(lines: string[]): void {
    if (!this.logFile) throw new Error('RiotSim: no run log to append to; the client has not started');
    writeFileSync(this.logFile, `${lines.join('\r\n')}\r\n`, { flag: 'a' });
  }

  /** Stands in for the user signing in on the client's login page. With "Stay signed in" unticked the client forgets the sign-in at exit. */
  signInByHand(as: string | null = this.knobs.signInAs, opts: { staySignedIn?: boolean } = {}): void {
    if (as === null) throw new Error('RiotSim.signInByHand needs an account id: pass one or set knobs.signInAs');
    this.forgetAtExit = !(opts.staySignedIn ?? this.knobs.staySignedIn);
    this.writeSessionFor(as);
    this.signedIn = true;
    this.appendLog([
      this.line('OKAY', 'SDK: rso-auth: Using direct token exchange'),
      this.psl('LoginTokenExchange'),
      this.line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key psl.authorization.riot-client'),
      this.psl('PendingEulaData'),
      this.psl('PendingPersistentFlagsData'),
      this.psl('PendingProductContext'),
      this.line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key rso-authenticator.tdid'),
    ]);
  }

  /** Stands in for the client's own Sign out: the servers end the session, so every saved copy of it is refused from now on. */
  signOut(): void {
    const session = this.currentSession();
    if (session) this.revoked.add(session.fingerprint);
    this.forgetAtExit = false;
    this.signedIn = false;
    this.writeSignedOut();
    this.appendLog([
      this.line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key psl.authorization.riot-client'),
      this.line('OKAY', 'SDK: riot-client-auth: Deleted current RSO authorization.'),
      this.line('ALWAYS', 'SDK: rso-auth: Successfully deleted RSO authorization.'),
      this.psl('PendingInitialization'),
      this.psl('PendingPersistenceInitialization'),
      this.psl('PendingCreateAuthorization'),
      this.psl('PendingLoginStrategy'),
    ]);
  }

  private line(level: string, text: string): string {
    this.clock += 0.05;
    return `${this.clock.toFixed(3).padStart(10, '0')}| ${level.padStart(6)}| ${text}`;
  }

  private psl(state: string): string {
    return this.line('ALWAYS', `riot-client-lifecycle: PSLProvider: PSL state changed to ${state}`);
  }

  private startLines(launch: RiotProductId | null = null): string[] {
    this.clock = 0;
    return [
      `000000.000| ALWAYS| Logging started at ${localIso(Date.now())}`,
      `000000.000| ALWAYS| Application Version: ${RIOT_SIM_BUILD}`,
      this.line('OKAY', 'Sentry Enabled'),
      this.line('ALWAYS', 'Command Line Arguments (Riot Client App):'),
      ...(launch ? [`    --launch-product=${launch.product}`, `    --launch-patchline=${launch.patchline}`] : []),
      `    --session-id=00000000-0000-4000-8000-${String(this.runCounter + 1).padStart(12, '0')}`,
      this.line('OKAY', 'ProcessSingleton: Acquired process singleton'),
      this.psl('PendingInitialization'),
      this.psl('PendingClientId'),
      this.psl('PendingPersistenceInitialization'),
    ];
  }

  private restoredLines(): string[] {
    return [
      this.psl('RestoreAuthorization'),
      this.psl('PendingEulaData'),
      this.line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key psl.authorization.riot-client'),
      this.psl('PendingPersistentFlagsData'),
      this.psl('PendingProductContext'),
      this.line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key rso-authenticator.tdid'),
      ...this.products.map((id) => this.patchLine(id)),
    ];
  }

  private patchLine(id: string): string {
    const parsed = parseProductId(id);
    const status = this.knobs.updatesPending.includes(id) ? 'OutOfDate' : 'UpToDate';
    return this.line(
      'OKAY',
      `patch-proxy: HandleProductPatchlineStatusUpdate: productId: ${parsed?.product ?? id}, patchlineId: ${parsed?.patchline ?? 'live'}, status: ${status}, progress: 0`,
    );
  }

  /**
   * What the client logs for a launch request: the product context (auto-launch for a start with the
   * arguments, not for a request handed to the running core), the patch state, and the pipeline up to
   * WaitForLaunch; then either the launch itself and the game's process, or the line with which the real
   * client declined and showed the page instead. A product that needs an update only gets its page; one
   * the simulated install does not carry only gets its context.
   */
  private launchLines(launch: RiotProductId, mode: 'boot' | 'forwarded'): string[] {
    const boot = mode === 'boot';
    const direct = boot && this.knobs.directLaunch;
    const declined = (reason: string): string =>
      boot
        ? this.line('OKAY', `riot-client-lifecycle: Attempting to launch default product with reason (${reason})`)
        : this.line('OKAY', `riot-client-lifecycle: Client is already running. Explicitly request focus instead of launching (${reason})`);
    const context = (autoLaunch: boolean): string =>
      this.line('ALWAYS', `riot-client-lifecycle: Setting product context to ${launch.id}, willAutoLaunch=${autoLaunch}`);
    // At a start the context is set to auto-launch, then the feature flag takes it back (build 140.0.8).
    const lines = boot && !direct ? [context(true), context(false)] : [context(boot)];
    lines.push(this.patchLine(launch.id));
    if (!this.products.includes(launch.id)) return lines;
    if (this.knobs.updatesPending.includes(launch.id)) {
      lines.push(
        this.line('OKAY', `riot-client-lifecycle: Patchline '${launch.id}' is out of date, and needs patching before launch`),
        declined('Product is not up to date'),
      );
      return lines;
    }
    for (let i = 1; i < LAUNCH_PIPELINE.length; i++) {
      lines.push(this.line('ALWAYS', `riot-client-lifecycle: Context #1: Middleware transition (${LAUNCH_PIPELINE[i - 1]}) -> (${LAUNCH_PIPELINE[i]})`));
    }
    if (!direct) {
      lines.push(declined('Auto-launch is disabled'));
      return lines;
    }
    lines.push(context(false), ...this.gameStartLines(launch));
    return lines;
  }

  /** The launch itself (the client's own, or the user's Play): "Launch starting", the game's process, and the session state. */
  private gameStartLines(launch: RiotProductId): string[] {
    const image = gameImagesOf(launch.product)[0];
    if (image) {
      // Both views of the process list, as on a real machine: the running names and the table with paths.
      this.processes.setRunning(image, true);
      if (!this.processes.processes.some((p) => p.name.toLowerCase() === image.toLowerCase())) {
        this.processes.processes.push({ name: image, pid: 40000 + this.processes.processes.length, path: null });
      }
    }
    return [
      this.line('OKAY', `product-launcher: Launch starting: productId='${launch.product}' patchlineId='${launch.patchline}'`),
      this.line('OKAY', 'product-launcher: Stopping all patching jobs'),
      this.line('ALWAYS', 'riot-client-lifecycle: Context #1: Middleware transition (WaitForLaunch) -> (WaitForSessionExit)'),
    ];
  }

  /** Stands in for the user pressing Play on the game's page in the running, signed-in client. */
  pressPlay(id: string): void {
    const launch = parseProductId(id);
    if (!launch) throw new Error(`RiotSim.pressPlay: not a product id: ${id}`);
    if (!this.coreRunning || !this.signedIn) throw new Error('RiotSim.pressPlay: the client is not running and signed in');
    this.appendLog(this.gameStartLines(launch));
  }

  /** A launch request handed to the running client: it sets the context and shows the page, never the game (seen on build 140). On the login page the request waits for the user. */
  private forwardedLaunch(launch: RiotProductId): void {
    if (!this.signedIn) return;
    this.appendLog(this.launchLines(launch, 'forwarded'));
  }

  private rejects(session: RiotSession): boolean {
    return this.revoked.has(session.fingerprint) || this.knobs.rejected.some((r) => r === session.accountId || r.toLowerCase() === session.fingerprint);
  }

  private react(launch: RiotProductId | null = null): void {
    this.processes.setRunning(RIOT_CLIENT_WINDOW_EXE, true);
    this.coreRunning = true;
    this.forgetAtExit = false;
    const session = this.currentSession();
    const lines = this.startLines(launch);
    let signedIn = false;
    if (session && this.knobs.authError !== null) {
      lines.push(
        this.line('ERROR', `SDK: rso-auth: error '${this.knobs.authError}': in plugin library function HandleAuthorizationCreate: request failed`),
        this.psl('RestoreAuthorization'),
        this.psl('PendingLoginStrategy'),
      );
    } else if (session && this.rejects(session)) {
      lines.push(
        this.line(
          'ERROR',
          "SDK: rso-auth: error 'authorization_creation_failure_request_error': in plugin library function HandleAuthorizationCreate: Failed to create RSO authorization (401) invalid_grant:",
        ),
        this.line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key psl.authorization.riot-client'),
        this.psl('RestoreAuthorization'),
        this.psl('PendingLoginStrategy'),
      );
      this.writeSignedOut();
    } else if (session) {
      if (this.knobs.rotateOnStart) this.writeSessionFor(session.accountId, { writeCount: (session.writeCount ?? 0) + 1 });
      lines.push(...this.restoredLines());
      signedIn = true;
    } else {
      lines.push(
        this.line('OKAY', 'SDK: private-settings: Updated private settings for user localuser with key psl.authorization.riot-client'),
        this.psl('PendingLoginStrategy'),
      );
    }
    this.signedIn = signedIn;
    if (signedIn && launch) lines.push(...this.launchLines(launch, 'boot'));
    this.writeLog(lines);
    if (!signedIn) this.landsOnLoginPage();
  }

  /** The core's clean exit: its last log lines, and the file forgotten when "Stay signed in" was not ticked. */
  private coreClosed(): void {
    this.coreRunning = false;
    this.signedIn = false;
    if (!this.logFile) return;
    if (this.forgetAtExit) {
      this.writeSignedOut();
      this.forgetAtExit = false;
    }
    this.appendLog([
      this.line('OKAY', 'riot-client-lifecycle: Attempting to quit. SwitchToBackgroundMode: False'),
      this.line('ALWAYS', `ProcessSingleton: Removal of LockFile complete: "${LOCKFILE}"`),
    ]);
  }

  private landsOnLoginPage(): void {
    const { signInWhenAskedMs } = this.knobs;
    if (signInWhenAskedMs === null) return;
    setTimeout(() => this.signInByHand(), signInWhenAskedMs);
  }
}
