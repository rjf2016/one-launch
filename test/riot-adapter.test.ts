import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RIOT_DIR,
  RIOT_CLIENT_EXE,
  RIOT_CLIENT_UNINSTALL_KEY,
  RIOT_CLIENT_WINDOW_EXE,
  RIOT_UNINSTALL_ROOT,
  RIOT_URI_COMMAND_KEY,
  RiotAdapter,
  SESSION_FILE,
  type RiotTiming,
} from '../src/main/launchers/riot/adapter';
import { currentRunEvents, gameStarted, lastSignIn, launchRequest } from '../src/main/launchers/riot/client-log';
import type { LocalLaunchRequest, RiotLocalLaunch } from '../src/main/launchers/riot/local-launch';
import { parseInstalls, parseLastSessionTimestamps, parseProductId, parseProductSettings, productWithRunningImage } from '../src/main/launchers/riot/products';
import { fingerprintOf, readSession, serializeBlob, spliceSessionBlock, type RiotSession } from '../src/main/launchers/riot/session';
import { fakeSessionFile, RiotSim, type RiotKnobs } from '../src/main/launchers/sim/riot';
import type { AccountRef } from '../src/main/launchers/types';
import { StaticProcessController } from '../src/main/platform/processes';
import { StaticRegistry } from '../src/main/platform/registry';
import { migrate, openDatabase } from '../src/main/db';
import { AccountsService } from '../src/main/services/accounts';
import { BackupService } from '../src/main/services/backup';
import { accountDirectory, accountRef } from '../src/main/services/launchers';
import { createLogger } from '../src/main/services/logger';
import { isRefusal } from '../src/main/services/refusals';
import { LauncherSessionStore } from '../src/main/services/sessions';
import type { Account, JobStep, LaunchAttention } from '../src/shared/models';
import { FakeVault } from './helpers/fake-vault';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'riot', name), 'utf8');
const SIGNED_IN = fixture('RiotGamesPrivateSettings.yaml');
const SIGNED_OUT = fixture('RiotGamesPrivateSettings-signed-out.yaml');
/** The account id the fixture's id token names, the one Alt's saved copy names, and one nobody holds. */
const SUB = '11111111-1111-4111-8111-111111111111';
const OTHER_SUB = '33333333-3333-4333-8333-333333333333';
const NEW_SUB = '44444444-4444-4444-8444-444444444444';
const REFRESH_TOKEN = /refresh_token: "([^"]+)"/.exec(SIGNED_IN)![1]!;
const FINGERPRINT = fingerprintOf(REFRESH_TOKEN);
const ALT_TOKEN = `placeholder-refresh-token-for-alt-${'b'.repeat(40)}`;
const ALT_FILE = fakeSessionFile(OTHER_SUB, ALT_TOKEN);
const ALT_FINGERPRINT = fingerprintOf(ALT_TOKEN);

let root: string;
let installDir: string;
let localAppData: string;
let programData: string;
let metadataDir: string;
let gamesDir: string;
let sessionPath: string;
let registry: StaticRegistry;
let processes: StaticProcessController;
let sim: RiotSim;
let backups: BackupService;
let sessions: LauncherSessionStore;
let accounts: AccountsService;
let A: Account;
let B: Account;
let C: Account;

const forward = (p: string): string => p.replace(/\\/g, '/');
/** A client log newer than the one beforeEach writes, so it is the current run. */
const writeLog = (text: string): void =>
  writeFileSync(join(localAppData, 'Riot Games', 'Riot Client', 'Logs', 'Riot Client Logs', '2026-10-06T10-00-00.000_2000_Riot Client.log'), text);
const uninstall = (id: string, name: string): string => `HKCU\\${RIOT_UNINSTALL_ROOT}\\Riot Game ${id}\\${name}`;
const ref = (a: Account): AccountRef => accountRef(accounts.require(a.id));
const statusOf = (steps: readonly JobStep[]): [string, string][] => steps.map((s) => [s.title, s.status]);
const onDisk = (): RiotSession | null => {
  const read = readSession(readFileSync(sessionPath, 'utf8'));
  return read.kind === 'session' ? read.session : null;
};
const noTokens = (text: string): void => {
  expect(text).not.toContain('eyJ');
  expect(text).not.toContain(REFRESH_TOKEN);
  expect(text).not.toContain(ALT_TOKEN);
  expect(text).not.toContain('placeholder-refresh-');
};
const kinds = (): string[] => processes.events.map((e) => `${e.kind} ${e.exe}${e.args.length ? ` ${e.args.join(' ')}` : ''}`);
const STEPS = {
  close: 'Close the Riot Client',
  backup: `Back up ${SESSION_FILE}`,
  file: "Put the account's sign-in in place",
  signOut: 'Sign the client out',
  start: 'Start the Riot Client',
  wait: 'Wait for the client to come up',
  verify: 'Confirm the client signed in',
  manual: 'Wait for you to sign in',
  recapture: 'Save the new sign-in',
};
/** Collects what the switch asks of the user, and optionally has the simulated user sign in once asked. */
function attentionLog(signInAs: string | null = null): { seen: (LaunchAttention | null)[]; onAttention: (a: LaunchAttention | null) => void } {
  const seen: (LaunchAttention | null)[] = [];
  return {
    seen,
    onAttention: (a) => {
      seen.push(a);
      if (a && signInAs) setTimeout(() => sim.signInByHand(signInAs), 5);
    },
  };
}

function product(id: string, opts: { installPath?: string; installRoot?: string; ok?: boolean; folder?: boolean; settings?: boolean } = {}): void {
  const dir = join(metadataDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.lockfile`), '');
  if (opts.settings !== false) {
    const lines = ['auto_patching_enabled_by_player: false', 'patching_policy: "manual"'];
    if (opts.installPath) lines.push(`product_install_full_path: "${forward(opts.installPath)}"`);
    if (opts.installRoot) lines.push(`product_install_root: "${forward(opts.installRoot)}"`);
    lines.push('should_repair: false');
    writeFileSync(join(dir, `${id}.product_settings.yaml`), `${lines.join('\n')}\n`);
  }
  if (opts.ok) writeFileSync(join(dir, `${id}.ok`), '');
  if (opts.folder !== false && opts.installPath) mkdirSync(opts.installPath, { recursive: true });
}

function adapter(
  overrides: {
    installDir?: () => string | null;
    defaultInstallDir?: string;
    timing?: Partial<RiotTiming>;
    /** The channel to the client's local server; with it, the press-Play setting is on unless `pressPlay` says otherwise. */
    localLaunch?: RiotLocalLaunch;
    pressPlay?: boolean;
  } = {},
): RiotAdapter {
  return new RiotAdapter({
    registry,
    processes,
    backups,
    sessions,
    accounts: accountDirectory(accounts, 'riot'),
    log: createLogger('test:riot'),
    backupsToKeep: () => 20,
    localAppData,
    programData,
    defaultInstallDir: overrides.defaultInstallDir ?? join(root, 'nowhere'),
    ...(overrides.installDir ? { installDir: overrides.installDir } : {}),
    ...(overrides.localLaunch ? { localLaunch: overrides.localLaunch, pressPlay: () => overrides.pressPlay ?? true } : {}),
    timing: {
      pollMs: 1,
      shutdownMs: 40,
      killGraceMs: 20,
      windowCloseMs: 40,
      restartWatchMs: 25,
      cleanExitWatchMs: 5,
      restartSettleMs: 60,
      startupMs: 40,
      signInMs: 40,
      manualSignInMs: 80,
      captureMs: 40,
      readyGraceMs: 0,
      launchConfirmMs: 40,
      playConfirmMs: 40,
      ...overrides.timing,
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'onelaunch-riot-'));
  installDir = join(root, 'Riot Games', 'Riot Client');
  localAppData = join(root, 'Local');
  programData = join(root, 'ProgramData');
  metadataDir = join(programData, 'Riot Games', 'Metadata');
  gamesDir = join(root, 'Riot Games');
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, RIOT_CLIENT_EXE), '');
  mkdirSync(join(metadataDir, 'Riot Client'), { recursive: true });
  mkdirSync(join(metadataDir, 'league_of_legends.live.game_patch'), { recursive: true });
  product('valorant.live', { installPath: join(gamesDir, 'VALORANT', 'live'), installRoot: gamesDir, ok: true });
  product('valorant.pbe', { installPath: join(gamesDir, 'VALORANT', 'pbe'), installRoot: gamesDir, ok: true });
  product('league_of_legends.live', { installPath: join(gamesDir, 'League of Legends'), installRoot: gamesDir, folder: false });
  product('teamfighttactics.live', { installPath: join(gamesDir, 'Teamfight Tactics', 'Live'), installRoot: gamesDir, ok: true, folder: false });
  product('bacon.live', { settings: false });
  writeFileSync(
    join(programData, 'Riot Games', 'RiotClientInstalls.json'),
    JSON.stringify({
      associated_client: { [`${forward(join(gamesDir, 'VALORANT', 'live'))}/`]: forward(join(installDir, RIOT_CLIENT_EXE)) },
      rc_default: forward(join(installDir, RIOT_CLIENT_EXE)),
    }),
  );
  const dataDir = join(localAppData, 'Riot Games', 'Riot Client');
  mkdirSync(join(dataDir, 'Config'), { recursive: true });
  mkdirSync(join(dataDir, 'Data'), { recursive: true });
  mkdirSync(join(dataDir, 'Logs', 'Riot Client Logs'), { recursive: true });
  writeFileSync(join(dataDir, 'Config', 'RiotClientSettings.yaml'), fixture('RiotClientSettings.yaml'));
  sessionPath = join(dataDir, 'Data', SESSION_FILE);
  writeFileSync(sessionPath, SIGNED_IN);
  writeFileSync(join(dataDir, 'Logs', 'Riot Client Logs', '2026-10-05T20-00-00.000_1234_Riot Client.log'), 'Logging started\n');

  registry = new StaticRegistry({
    [`HKCU\\${RIOT_CLIENT_UNINSTALL_KEY}\\InstallLocation`]: `${forward(installDir)}/`,
    [uninstall('valorant.live', 'DisplayName')]: 'VALORANT',
    [uninstall('valorant.live', 'InstallLocation')]: forward(join(gamesDir, 'VALORANT', 'live')),
    [`HKLM\\${RIOT_URI_COMMAND_KEY}\\`]: `"${join(installDir, RIOT_CLIENT_EXE)}" --app-command="%1"`,
  });
  processes = new StaticProcessController();
  sim = new RiotSim({ localAppData, processes });
  processes.onStart = (exe, args) => sim.onStart(exe, args);
  const db = openDatabase(':memory:');
  migrate(db);
  const vault = new FakeVault();
  backups = new BackupService(join(root, 'backups'), { keep: () => 20, vault });
  sessions = new LauncherSessionStore(db, vault);
  accounts = new AccountsService(db, vault);
  A = accounts.create({ launcher: 'riot', displayName: 'Main', login: 'riot_main', launcherUid: SUB });
  B = accounts.create({ launcher: 'riot', displayName: 'Alt', login: 'riot_alt', launcherUid: OTHER_SUB });
  C = accounts.create({ launcher: 'riot', displayName: 'New', login: 'riot_new', password: 'pw-new' });
});

/** Alt's saved copy of the session file, as a switch to Alt needs it. */
const saveAlt = (): void => {
  sessions.save({ accountId: B.id, launcher: 'riot', launcherUid: OTHER_SUB, fingerprint: ALT_FINGERPRINT, blob: serializeBlob({ v: 1, file: ALT_FILE }) });
};

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Riot detection', () => {
  it('prefers the chosen folder, then the Uninstall key with its forward slashes and trailing slash', async () => {
    const chosen = join(root, 'Chosen');
    mkdirSync(chosen);
    writeFileSync(join(chosen, RIOT_CLIENT_EXE), '');
    expect(await adapter({ installDir: () => chosen }).detectInstall()).toEqual({
      launcher: 'riot',
      installDir: chosen,
      exePath: join(chosen, RIOT_CLIENT_EXE),
      source: 'user',
    });
    expect(await adapter().detectInstall()).toEqual({ launcher: 'riot', installDir, exePath: join(installDir, RIOT_CLIENT_EXE), source: 'registry-hkcu' });
  });

  it('falls back to RiotClientInstalls.json, then the riotclient:// handler, then the default folder', async () => {
    registry.delete(`HKCU\\${RIOT_CLIENT_UNINSTALL_KEY}\\InstallLocation`);
    expect((await adapter().detectInstall())?.source).toBe('launcher-file');
    rmSync(join(programData, 'Riot Games', 'RiotClientInstalls.json'));
    expect((await adapter().detectInstall())?.source).toBe('registry-hklm');
    registry.delete(`HKLM\\${RIOT_URI_COMMAND_KEY}\\`);
    expect(await adapter().detectInstall()).toBeNull();
    expect((await adapter({ defaultInstallDir: installDir }).detectInstall())?.source).toBe('default-path');
    expect(DEFAULT_RIOT_DIR).toBe('C:\\Riot Games\\Riot Client');
  });

  it('accepts only RiotClientServices.exe from Locate and refuses the library when not installed', async () => {
    const a = adapter();
    expect(a.installFromExe(join(installDir, RIOT_CLIENT_EXE))?.source).toBe('user');
    expect(a.installFromExe(join(installDir, 'RiotClientCrashHandler.exe'))).toBeNull();
    registry.delete(`HKCU\\${RIOT_CLIENT_UNINSTALL_KEY}\\InstallLocation`);
    registry.delete(`HKLM\\${RIOT_URI_COMMAND_KEY}\\`);
    rmSync(join(programData, 'Riot Games', 'RiotClientInstalls.json'));
    await expect(adapter().listInstalledGames()).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    await expect(adapter().listRememberedAccounts()).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });
});

describe('Riot library', () => {
  it('lists the products with an .ok marker and an install folder, named from the Uninstall key or the table', async () => {
    const games = await adapter().listInstalledGames();
    expect(games.map((g) => [g.launcherGameId, g.name])).toEqual([
      ['valorant.live', 'VALORANT'],
      ['valorant.pbe', 'VALORANT (PBE)'],
    ]);
    const valorant = games[0]!;
    expect(valorant).toMatchObject({
      launcher: 'riot',
      installPath: join(gamesDir, 'VALORANT', 'live'),
      libraryPath: gamesDir,
      sizeOnDiskBytes: null,
      lastPlayedAt: new Date(1760000000 * 1000).toISOString(),
      needsUpdate: false,
    });
    expect(games[1]!.lastPlayedAt).toBeNull();
  });

  it('lists the one account the session file names, and never writes to the registry or the process list', async () => {
    const a = adapter();
    expect(await a.listRememberedAccounts()).toEqual([
      {
        launcher: 'riot',
        launcherUid: SUB,
        login: 'riot_main',
        personaName: 'Main',
        rememberPassword: true,
        mostRecent: true,
        lastLoginAt: null,
        sessionMayBeExpired: false,
      },
    ]);
    await a.listInstalledGames();
    await a.healthCheck();
    expect(registry.writes).toEqual([]);
    expect(processes.events).toEqual([]);
  });

  it('suggests the Riot ID as the name for an id no account holds, and lists nobody for a signed-out client', async () => {
    accounts.update(A.id, { launcherUid: null });
    expect(await adapter().listRememberedAccounts()).toMatchObject([{ launcherUid: SUB, login: '', personaName: 'Placeholder#0000' }]);
    writeFileSync(sessionPath, SIGNED_OUT);
    expect(await adapter().listRememberedAccounts()).toEqual([]);
    rmSync(sessionPath);
    expect(await adapter().listRememberedAccounts()).toEqual([]);
  });

  it('names the product’s own icon: beside its metadata first, else the Uninstall key’s DisplayIcon when that is an .ico file', async () => {
    const a = adapter();
    const game = { launcherGameId: 'valorant.live', name: 'VALORANT' };
    expect(await a.gameIcon(game)).toBeNull();

    const elsewhere = join(root, 'elsewhere', 'valorant.ico');
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(elsewhere, 'placeholder');
    registry.set(uninstall('valorant.live', 'DisplayIcon'), `${forward(elsewhere)},0`);
    expect(await a.gameIcon(game)).toBe(elsewhere);
    registry.set(uninstall('valorant.live', 'DisplayIcon'), `${forward(join(gamesDir, 'VALORANT', 'live', 'VALORANT.exe'))},0`);
    expect(await a.gameIcon(game)).toBeNull();

    const beside = join(metadataDir, 'valorant.live', 'valorant.live.ico');
    writeFileSync(beside, 'placeholder');
    registry.set(uninstall('valorant.live', 'DisplayIcon'), `${forward(elsewhere)},0`);
    expect(await a.gameIcon(game)).toBe(beside);
    expect(await a.gameIcon({ launcherGameId: 'not a product', name: 'Nothing' })).toBeNull();
    expect(registry.writes).toEqual([]);
    expect(processes.events).toEqual([]);
  });
});

describe('Riot session state', () => {
  it('reports the saved sign-in and whose it is: a stored snapshot first, then the account id the file names', async () => {
    expect(await adapter().sessionState()).toEqual({
      launcher: 'riot',
      remembered: true,
      fingerprint: FINGERPRINT,
      launcherUid: SUB,
      linkedAccountId: A.id,
      launcherRunning: false,
      lastSignIn: null,
    });

    accounts.update(A.id, { launcherUid: null });
    expect(await adapter().sessionState()).toMatchObject({ remembered: true, launcherUid: SUB, linkedAccountId: null });

    sessions.save({ accountId: C.id, launcher: 'riot', launcherUid: SUB, fingerprint: FINGERPRINT, blob: '{"v":1,"file":"placeholder"}' });
    expect((await adapter().sessionState()).linkedAccountId).toBe(C.id);

    processes.setRunning(RIOT_CLIENT_EXE, true);
    expect(await adapter().sessionState()).toMatchObject({ remembered: true, launcherUid: SUB, linkedAccountId: C.id, launcherRunning: true });
  });

  it('takes the last sign-in verdict from the client’s newest log, and treats a start with no saved sign-in as no attempt', async () => {
    const verdict = async () => (await adapter().sessionState()).lastSignIn;
    writeLog(fixture('2026-10-04T20-34-14_10001_Riot Client.log'));
    expect(await verdict()).toEqual({ ok: true, reason: null });
    writeLog(fixture('2026-10-04T20-42-52_10003_Riot Client.log'));
    expect(await verdict()).toEqual({ ok: false, reason: 'the client refused the saved sign-in (401 invalid_grant)' });
    const manual = fixture('2026-10-04T20-56-32_10002_Riot Client.log');
    writeLog(manual.slice(0, manual.indexOf('Using direct token exchange')));
    expect(await verdict()).toBeNull();
    writeLog(manual.slice(0, manual.lastIndexOf('Using direct token exchange')));
    expect(await verdict()).toEqual({ ok: false, reason: 'signed out' });
    writeLog(manual);
    expect(await verdict()).toEqual({ ok: true, reason: null });
  });

  it('reports a signed-out client and a missing file as nobody, and a file in an unknown shape as an error', async () => {
    writeFileSync(sessionPath, SIGNED_OUT);
    expect(await adapter().sessionState()).toMatchObject({ remembered: false, fingerprint: null, launcherUid: null, linkedAccountId: null });
    rmSync(sessionPath);
    expect(await adapter().sessionState()).toMatchObject({ remembered: false, fingerprint: null, launcherUid: null, linkedAccountId: null });
    writeFileSync(sessionPath, 'private:\n    riot-login:\n        persist: null\n');
    await expect(adapter().sessionState()).rejects.toMatchObject({
      code: 'LAUNCHER_FILE',
      message: /RiotGamesPrivateSettings\.yaml is not in the shape One Launch knows \(no psl block\)/,
    });
    await expect(adapter().listRememberedAccounts()).rejects.toMatchObject({ code: 'LAUNCHER_FILE' });
  });
});

describe('Riot captureSession', () => {
  it('stores the whole file for its owner, links the Riot account id, and refuses it for anyone else', async () => {
    accounts.update(A.id, { launcherUid: null });
    const captured = await adapter().captureSession(ref(A));
    expect(captured.launcherUid).toBe(SUB);
    expect(captured.session).toMatchObject({
      accountId: A.id,
      launcher: 'riot',
      launcherUid: SUB,
      fingerprint: FINGERPRINT,
      verifiedAt: null,
      staleReason: null,
    });
    expect(accounts.require(A.id).launcherUid).toBe(SUB);
    expect(JSON.parse(sessions.decrypt(A.id)!)).toEqual({ v: 1, file: SIGNED_IN });
    expect(JSON.stringify(captured)).not.toContain('eyJ');

    await expect(adapter().captureSession(ref(C))).rejects.toMatchObject({
      code: 'SWITCH_BLOCKED',
      message: /saved belongs to Main\. Sign in to the Riot Client as riot_new first/,
    });
    await expect(adapter().captureSession(ref(B))).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: /belongs to Main/ });
    expect(sessions.get(C.id)).toBeNull();
    expect(sessions.get(B.id)).toBeNull();

    sessions.delete(A.id);
    expect((await adapter().captureSession(ref(A))).session.accountId).toBe(A.id);
  });

  it('refuses an account linked to another Riot id when nobody owns the saved sign-in', async () => {
    accounts.update(A.id, { launcherUid: null });
    await expect(adapter().captureSession(ref(B))).rejects.toMatchObject({
      code: 'SWITCH_BLOCKED',
      message: /saved sign-in is Riot account …1111, but Alt is linked to …3333\. Check the Riot account id/,
    });
    expect(sessions.list('riot')).toEqual([]);

    const adopted = await adapter().captureSession(ref(C));
    expect(adopted.launcherUid).toBe(SUB);
    expect(accounts.require(C.id).launcherUid).toBe(SUB);
    expect((await adapter().sessionState()).linkedAccountId).toBe(C.id);
  });

  it('needs the client closed, a saved account, and a saved sign-in', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    await expect(adapter().captureSession(ref(A))).rejects.toMatchObject({
      code: 'SWITCH_BLOCKED',
      message: /The Riot Client is running\. Right-click its tray icon, choose Exit, then save again\./,
    });
    processes.setRunning(RIOT_CLIENT_EXE, false);
    await expect(adapter().captureSession({ ...ref(A), id: null })).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: /Save the account first/ });
    writeFileSync(sessionPath, SIGNED_OUT);
    await expect(adapter().captureSession(ref(A))).rejects.toMatchObject({
      code: 'SWITCH_BLOCKED',
      message: /has no saved sign-in\. Sign in to it as riot_main with “Stay signed in” ticked, exit the client, then save again\./,
    });
    rmSync(sessionPath);
    await expect(adapter().captureSession(ref(A))).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: /no saved sign-in/ });
    writeFileSync(sessionPath, 'psl:\n    authorization:\n        riot-client: "later"\n');
    await expect(adapter().captureSession(ref(A))).rejects.toMatchObject({ code: 'LAUNCHER_FILE', message: /neither null nor a block/ });
    expect(sessions.list('riot')).toEqual([]);
    expect(accounts.require(C.id).launcherUid).toBeNull();
  });

  it('reads the session file and nothing else: no write to it, the registry, a process, or a backup', async () => {
    await adapter().captureSession(ref(A));
    await adapter().sessionState();
    await adapter().listRememberedAccounts();
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(registry.writes).toEqual([]);
    expect(processes.events).toEqual([]);
    expect(backups.list('riot')).toEqual([]);
  });
});

describe('Riot running state', () => {
  it('reports the client by image name and a game by its process name alone', async () => {
    const a = adapter();
    expect(await a.isRunning()).toBe(false);
    processes.setRunning(RIOT_CLIENT_EXE, true);
    expect(await a.isRunning()).toBe(true);
    expect(await a.runningGame()).toBeNull();

    processes.processes = [{ name: 'VALORANT-Win64-Shipping', pid: 4242, path: null }];
    expect(await a.runningGame()).toEqual({ launcher: 'riot', launcherGameId: 'valorant.live', name: 'VALORANT', source: 'process' });

    processes.processes = [{ name: 'LeagueClient', pid: 4243, path: null }];
    expect(await a.runningGame()).toEqual({ launcher: 'riot', launcherGameId: 'league_of_legends.live', name: 'League of Legends', source: 'process' });

    processes.processes = [
      { name: 'vgtray', pid: 1, path: null },
      { name: 'RiotClientServices', pid: 2, path: null },
    ];
    expect(await a.runningGame()).toBeNull();
  });

  it('treats a process list that cannot be read as no game for the status, and refuses a launch, a switch and a restore on it', async () => {
    processes.runningNames = async () => {
      throw new Error('access denied');
    };
    expect(await adapter().runningGame()).toBeNull();
    // Nothing goes on past a game the adapter could not see (hard rule 2): the error comes back, before anything is sent or touched.
    await expect(adapter().launchGame({ launcherGameId: 'valorant.live', name: 'VALORANT' })).rejects.toThrow('access denied');
    await expect(adapter().preflight(ref(B))).rejects.toThrow('access denied');
    await expect(adapter().switchAccount(ref(B), { dryRun: true })).rejects.toThrow('access denied');
    await expect(adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true })).rejects.toThrow('access denied');
    await expect(adapter().restoreBackup('any')).rejects.toThrow('access denied');
    expect(processes.events).toEqual([]);
    expect(backups.list('riot')).toEqual([]);
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
  });
});

describe('Riot shutdown', () => {
  const kinds = (): string[] => processes.events.map((e) => `${e.kind} ${e.exe}${e.args.length ? ` ${e.args.join(' ')}` : ''}`);

  it('closes the core, then the window processes, politely, and touches nothing else', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    processes.setRunning(RIOT_CLIENT_WINDOW_EXE, true);
    await adapter().shutdown();
    expect(kinds()).toEqual([`close ${RIOT_CLIENT_EXE}`, `close ${RIOT_CLIENT_WINDOW_EXE}`]);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(false);
    expect(await processes.isRunning(RIOT_CLIENT_WINDOW_EXE)).toBe(false);
    expect(registry.writes).toEqual([]);
    expect(backups.list('riot')).toEqual([]);
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
  });

  it('does nothing when the client is not running, and closes window processes left behind without a core', async () => {
    await adapter().shutdown();
    expect(processes.events).toEqual([]);
    processes.setRunning(RIOT_CLIENT_WINDOW_EXE, true);
    await adapter().shutdown();
    expect(kinds()).toEqual([`close ${RIOT_CLIENT_WINDOW_EXE}`]);
    expect(await processes.isRunning(RIOT_CLIENT_WINDOW_EXE)).toBe(false);
  });

  it('ends a process that ignores its window close, without its tree, and only after the polite close ran out', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    processes.setRunning(RIOT_CLIENT_WINDOW_EXE, true);
    processes.shutdownPolls = 1_000_000;
    await adapter().shutdown();
    expect(kinds()).toEqual([`close ${RIOT_CLIENT_EXE}`, `kill ${RIOT_CLIENT_EXE}`, `close ${RIOT_CLIENT_WINDOW_EXE}`, `kill ${RIOT_CLIENT_WINDOW_EXE}`]);
    expect(processes.events.filter((e) => e.kind === 'kill').every((e) => e.args.length === 0)).toBe(true);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(false);
    expect(await processes.isRunning(RIOT_CLIENT_WINDOW_EXE)).toBe(false);
  });

  it('waits out a client that restarts itself after the close, closes it again, and gives up after three rounds', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    let restarts = 1;
    const close = processes.close.bind(processes);
    processes.close = async (name) => {
      await close(name);
      if (restarts-- > 0) {
        setTimeout(() => {
          processes.setRunning(name, true);
          writeLog(fixture('2026-10-04T20-34-14_10001_Riot Client.log'));
        }, 8);
      }
    };
    await adapter().shutdown();
    expect(kinds()).toEqual([`close ${RIOT_CLIENT_EXE}`, `close ${RIOT_CLIENT_EXE}`]);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(false);

    processes.events.length = 0;
    processes.setRunning(RIOT_CLIENT_EXE, true);
    restarts = 10;
    await expect(adapter().shutdown()).rejects.toThrow(/keeps restarting itself after being closed/);
    expect(kinds()).toEqual([`close ${RIOT_CLIENT_EXE}`, `close ${RIOT_CLIENT_EXE}`, `close ${RIOT_CLIENT_EXE}`]);
  });

  it('watches only briefly for a restart when the log shows the lock file removed, the client’s last line of a clean exit', async () => {
    const slow = adapter({ timing: { restartWatchMs: 600, cleanExitWatchMs: 10 } });
    const logPath = join(localAppData, 'Riot Games', 'Riot Client', 'Logs', 'Riot Client Logs', '2026-10-05T20-00-00.000_1234_Riot Client.log');
    const close = processes.close.bind(processes);
    processes.close = async (name) => {
      await close(name);
      if (name === RIOT_CLIENT_EXE) {
        writeFileSync(
          logPath,
          `${readFileSync(logPath, 'utf8')}000040.933|   OKAY| riot-client-lifecycle: Attempting to quit. SwitchToBackgroundMode: False\r\n000041.555| ALWAYS| ProcessSingleton: Removal of LockFile complete: "C:/x/lockfile_"\r\n`,
        );
      }
    };
    processes.setRunning(RIOT_CLIENT_EXE, true);
    let started = Date.now();
    await slow.shutdown();
    expect(Date.now() - started).toBeLessThan(400);

    // A log that says nothing (a core that went without its last line): the full watch.
    processes.close = close;
    processes.setRunning(RIOT_CLIENT_EXE, true);
    started = Date.now();
    await slow.shutdown();
    expect(Date.now() - started).toBeGreaterThanOrEqual(590);
  });

  it('cuts the restart watch short as soon as the lock-file line lands, even after the core is already gone', async () => {
    const slow = adapter({ timing: { restartWatchMs: 600, cleanExitWatchMs: 10 } });
    const logPath = join(localAppData, 'Riot Games', 'Riot Client', 'Logs', 'Riot Client Logs', '2026-10-05T20-00-00.000_1234_Riot Client.log');
    const close = processes.close.bind(processes);
    processes.close = async (name) => {
      await close(name);
      if (name !== RIOT_CLIENT_EXE) return;
      setTimeout(() => {
        writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}000041.555| ALWAYS| ProcessSingleton: Removal of LockFile complete: "C:/x/lockfile_"\r\n`);
      }, 60);
    };
    processes.setRunning(RIOT_CLIENT_EXE, true);
    const started = Date.now();
    await slow.shutdown();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(55);
    expect(took).toBeLessThan(400);
  });

  it('watches only briefly for a restart after a forced close: an ended core has no updater left to bring it back', async () => {
    const slow = adapter({ timing: { restartWatchMs: 600, cleanExitWatchMs: 10 } });
    processes.setRunning(RIOT_CLIENT_EXE, true);
    processes.shutdownPolls = 1_000_000;
    const started = Date.now();
    await slow.shutdown();
    expect(kinds()).toEqual([`close ${RIOT_CLIENT_EXE}`, `kill ${RIOT_CLIENT_EXE}`]);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('stops at once when the signal aborts, without ending the process', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    processes.shutdownPolls = 1_000_000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(adapter({ timing: { shutdownMs: 5_000 } }).shutdown({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(kinds()).toEqual([`close ${RIOT_CLIENT_EXE}`]);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(true);
  });

  it('needs the client installed', async () => {
    registry.delete(`HKCU\\${RIOT_CLIENT_UNINSTALL_KEY}\\InstallLocation`);
    registry.delete(`HKLM\\${RIOT_URI_COMMAND_KEY}\\`);
    rmSync(join(programData, 'Riot Games', 'RiotClientInstalls.json'));
    processes.setRunning(RIOT_CLIENT_EXE, true);
    await expect(adapter().shutdown()).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    expect(processes.events).toEqual([]);
  });
});

describe('Riot switch plan (dry run)', () => {
  beforeEach(saveAlt);

  it('names the game’s launch arguments in the start step when a launch follows the switch', async () => {
    const exe = join(installDir, RIOT_CLIENT_EXE);
    const plan = await adapter().switchAccount(ref(B), { dryRun: true, game: { launcherGameId: 'valorant.live', name: 'VALORANT' } });
    expect(plan.steps[4]).toMatchObject({ id: 'start', target: `"${exe}" --launch-product=valorant --launch-patchline=live` });
    expect(plan.steps[4]!.detail).toBe(
      "Start the client with VALORANT's launch arguments, as the game's own shortcut does. It signs in as riot_alt on its own from the saved sign-in and opens the game's page.",
    );
    const bare = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(bare.steps[4]).toMatchObject({ id: 'start', target: `"${exe}"` });
    expect(bare.steps[4]!.detail).toBe(
      'Start the client with no arguments, as its own shortcut does. It signs in as riot_alt on its own from the saved sign-in.',
    );
  });

  it('plans the saved-copy path for an account with a saved sign-in without decrypting or touching anything', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan).toMatchObject({
      launcher: 'riot',
      strategy: 'remembered',
      executable: true,
      account: { id: B.id, displayName: 'Alt', login: 'riot_alt', launcherUid: OTHER_SUB },
      current: { mostRecentLogin: 'riot_main', autoLoginUser: null, running: true },
    });
    expect(plan.steps.map((s) => [s.id, s.skipped])).toEqual([
      ['close', false],
      ['capture', false],
      ['backup', false],
      ['file', false],
      ['start', false],
      ['wait', false],
      ['verify', false],
      ['manual', true],
      ['recapture', true],
    ]);
    expect(plan.steps[0]!.detail).toContain('never with its children');
    expect(plan.steps[1]!.title).toBe('Save the outgoing sign-in');
    expect(plan.steps[3]).toMatchObject({
      title: STEPS.file,
      target: sessionPath,
      changes: [
        {
          where: 'psl.authorization.riot-client',
          before: `(saved sign-in for Riot account …1111, fingerprint ${FINGERPRINT.slice(0, 8)})`,
          after: expect.stringMatching(/^\(saved copy for Alt, fingerprint [0-9a-f]{8}, saved \d{4}-/),
        },
      ],
    });
    expect(plan.steps[3]!.detail).toContain('whole, as the client itself left it');
    expect(plan.steps[4]!.detail).toBe(
      'Start the client with no arguments, as its own shortcut does. It signs in as riot_alt on its own from the saved sign-in.',
    );
    expect(plan.steps[6]!.detail).toContain('which must be …3333');
    expect(plan.warnings).toEqual(['The Riot Client is running as Main. It will be closed.']);
    noTokens(JSON.stringify(plan));
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(processes.events).toEqual([]);
    expect(registry.writes).toEqual([]);
    expect(backups.list('riot')).toEqual([]);
    expect(sessions.get(A.id)).toBeNull();

    const preflight = await adapter().preflight(ref(B));
    expect(preflight).toMatchObject({
      launcherRunning: true,
      runningGame: null,
      alreadyActive: false,
      closeMessage: 'The Riot Client is running. Switching closes it.',
    });
    expect(preflight.plan.steps.map((s) => s.skipped)).toEqual(plan.steps.map((s) => s.skipped));
  });

  it('treats the account whose sign-in the file holds as in place, and as active once the running client has signed in', async () => {
    let plan = await adapter().switchAccount(ref(A), { dryRun: true });
    expect(plan.strategy).toBe('remembered');
    expect(plan.steps.map((s) => [s.id, s.skipped])).toEqual([
      ['close', true],
      ['capture', false],
      ['backup', true],
      ['file', true],
      ['start', false],
      ['wait', false],
      ['verify', false],
      ['manual', true],
      ['recapture', true],
    ]);
    expect(plan.steps[1]!.title).toBe("Save this account's sign-in");
    expect(plan.steps[1]!.detail).toContain('no copy yet');
    expect(plan.steps[3]!.detail).toBe(`No change: ${SESSION_FILE} already holds Main's sign-in (fingerprint ${FINGERPRINT.slice(0, 8)}).`);
    expect(plan.notes).toEqual(["The Riot Client already holds Main's sign-in, so it is only started."]);
    expect(plan.warnings).toEqual([]);

    processes.setRunning(RIOT_CLIENT_EXE, true);
    plan = await adapter().switchAccount(ref(A), { dryRun: true });
    expect(plan.steps[0]!.skipped).toBe(false);
    expect(plan.warnings).toEqual(['The Riot Client is running as Main. It will be closed.']);

    writeLog(fixture('2026-10-04T20-34-14_10001_Riot Client.log'));
    plan = await adapter().switchAccount(ref(A), { dryRun: true });
    expect(plan.steps.every((s) => s.skipped)).toBe(true);
    expect(plan.notes).toEqual(['The Riot Client is running and signed in as Main. The real switch would change nothing and would leave the client running.']);
    expect(plan.warnings).toEqual([]);
    expect(await adapter().preflight(ref(A))).toMatchObject({ launcherRunning: true, alreadyActive: true });
  });

  it('plans the sign-out path (null, a manual sign-in, a capture) for an account without a saved sign-in', async () => {
    let plan = await adapter().switchAccount(ref(C), { dryRun: true });
    expect(plan).toMatchObject({ strategy: 'credentials', executable: true, account: { launcherUid: null } });
    expect(plan.steps.map((s) => [s.id, s.skipped])).toEqual([
      ['close', true],
      ['capture', false],
      ['backup', false],
      ['file', false],
      ['start', false],
      ['wait', false],
      ['verify', false],
      ['manual', false],
      ['recapture', false],
    ]);
    expect(plan.steps[3]).toMatchObject({
      title: STEPS.signOut,
      changes: [{ where: 'psl.authorization.riot-client', before: expect.stringContaining('…1111'), after: 'null (signed out)' }],
    });
    expect(plan.steps[3]!.detail).toContain('the device cookie included');
    expect(plan.steps[7]!.detail).toContain('with “Stay signed in” ticked (the password can be copied from One Launch)');
    expect(plan.steps[7]!.detail).toContain('ends the switch and puts the file back');
    expect(plan.warnings).toEqual([
      'No sign-in is saved for New yet. The client will open on its login page; sign in once with “Stay signed in” ticked and One Launch saves it for later switches.',
    ]);

    writeFileSync(sessionPath, SIGNED_OUT);
    plan = await adapter().switchAccount(ref(C), { dryRun: true });
    expect(plan.steps[1]!.skipped).toBe(true);
    expect(plan.steps[3]).toMatchObject({ skipped: true, detail: 'No change: the client holds no saved sign-in, so it opens on its login page.', changes: [] });

    sessions.markStale(B.id, 'the client refused the saved sign-in (401 invalid_grant)');
    plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.strategy).toBe('credentials');
    expect(plan.warnings[0]).toBe(
      "Alt's saved sign-in no longer works: the client refused the saved sign-in (401 invalid_grant). You will sign in once by hand, with “Stay signed in” ticked, and One Launch stores the fresh sign-in.",
    );
  });

  it('cannot run without the session file, which One Launch never creates', async () => {
    rmSync(sessionPath);
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.executable).toBe(false);
    expect(plan.warnings[0]).toBe(
      `${sessionPath} does not exist. One Launch never creates it: start the Riot Client once by hand (it writes the file at its first start), then try again.`,
    );
    expect(plan.steps[3]!.changes[0]!.before).toBe('(absent)');
    await expect(adapter().switchAccount(ref(B), { dryRun: false })).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: plan.warnings[0] });
    expect(existsSync(sessionPath)).toBe(false);
    expect(processes.events).toEqual([]);
  });

  it('refuses the switch while a Riot game runs, before anything is touched, with its own refusal code', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    processes.processes = [{ name: 'VALORANT-Win64-Shipping', pid: 4242, path: null }];
    const message = 'VALORANT is running. Close it, then switch: One Launch never closes a Riot game.';
    let err: unknown;
    await adapter()
      .preflight(ref(B))
      .catch((e: unknown) => {
        err = e;
      });
    expect(err).toMatchObject({ code: 'GAME_RUNNING', message, runningGame: { launcherGameId: 'valorant.live', name: 'VALORANT' } });
    expect(isRefusal(err)).toBe(true);
    await expect(adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true })).rejects.toMatchObject({ code: 'GAME_RUNNING', message });
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.warnings[0]).toBe('VALORANT is running. Close it first: One Launch never closes a Riot game, and no switch runs while one does.');
    expect(processes.events).toEqual([]);
    expect(backups.list('riot')).toEqual([]);
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(true);
  });
});

describe('Riot switch (real)', () => {
  beforeEach(saveAlt);

  it('closes the client, saves the outgoing sign-in, backs up, swaps the whole file, restarts, and confirms from the log and the file', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    processes.setRunning(RIOT_CLIENT_WINDOW_EXE, true);
    const progress: [string, string][][] = [];
    const result = await adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true, onProgress: (s) => progress.push(statusOf(s)) });

    expect(result).toMatchObject({ ok: true, error: null, restored: null, cancelled: false, needsSignIn: false, strategy: 'remembered' });
    expect(statusOf(result.steps)).toEqual([
      [STEPS.close, 'done'],
      ['Save the outgoing sign-in', 'done'],
      [STEPS.backup, 'done'],
      [STEPS.file, 'done'],
      [STEPS.start, 'done'],
      [STEPS.wait, 'done'],
      [STEPS.verify, 'done'],
      [STEPS.manual, 'skipped'],
      [STEPS.recapture, 'skipped'],
    ]);
    expect(result.steps[1]!.detail).toBe(`Saved Main's sign-in (fingerprint ${FINGERPRINT.slice(0, 8)}).`);
    expect(result.steps[3]!.detail).toBe(`${SESSION_FILE} now holds the saved copy (fingerprint ${ALT_FINGERPRINT.slice(0, 8)}).`);
    expect(result.steps[6]!.detail).toBe('Signed in as riot_alt.');
    expect(progress[0]![0]).toEqual([STEPS.close, 'running']);
    noTokens(JSON.stringify(result));

    expect(kinds()).toEqual([`close ${RIOT_CLIENT_EXE}`, `close ${RIOT_CLIENT_WINDOW_EXE}`, `start ${join(installDir, RIOT_CLIENT_EXE)}`]);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(true);

    // The outgoing sign-in went to Main before the file was overwritten; the client then rotated Alt's token at start.
    expect(sessions.get(A.id)).toMatchObject({ launcherUid: SUB, fingerprint: FINGERPRINT });
    expect(JSON.parse(sessions.decrypt(A.id)!)).toEqual({ v: 1, file: SIGNED_IN });
    const after = onDisk()!;
    expect(after).toMatchObject({ accountId: OTHER_SUB, writeCount: 2 });
    expect(after.fingerprint).not.toBe(ALT_FINGERPRINT);
    expect(sessions.get(B.id)).toMatchObject({ fingerprint: ALT_FINGERPRINT, staleReason: null });
    expect(sessions.get(B.id)!.verifiedAt).not.toBeNull();

    const snapshot = backups.get('riot', result.backupId!)!;
    expect(snapshot).toMatchObject({ reason: 'Before switching to Alt', files: ['Data/RiotGamesPrivateSettings.yaml'], pinned: null });
    expect(backups.readFile('riot', snapshot.id, 'Data/RiotGamesPrivateSettings.yaml').toString('utf8')).toBe(SIGNED_IN);
    expect(existsSync(join(snapshot.path, 'Data', SESSION_FILE))).toBe(false);
    expect(readFileSync(join(snapshot.path, 'Data', `${SESSION_FILE}.enc`), 'latin1')).not.toContain(REFRESH_TOKEN);
  });

  it("saves the outgoing account's rotated sign-in before replacing it, and the saved copy is written back whole", async () => {
    const first = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(first.ok).toBe(true);
    const rotated = onDisk()!;
    const rotatedText = readFileSync(sessionPath, 'utf8');
    expect(rotated.fingerprint).not.toBe(ALT_FINGERPRINT);
    expect(sessions.get(B.id)?.fingerprint).toBe(ALT_FINGERPRINT);

    const second = await adapter().switchAccount(ref(A), { dryRun: false, confirmClose: true });
    expect(second.ok).toBe(true);
    expect(second.steps[1]!.detail).toBe(`Saved Alt's sign-in (fingerprint ${rotated.fingerprint.slice(0, 8)}).`);
    expect(sessions.get(B.id)?.fingerprint).toBe(rotated.fingerprint);
    expect(JSON.parse(sessions.decrypt(B.id)!).file).toBe(rotatedText);
    // Main's copy went back whole: the client then started from it and rotated once more.
    expect(onDisk()).toMatchObject({ accountId: SUB, writeCount: 4 });

    const third = await adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true });
    expect(third.ok).toBe(true);
    expect(third.steps[3]!.detail).toBe(`${SESSION_FILE} now holds the saved copy (fingerprint ${rotated.fingerprint.slice(0, 8)}).`);
  });

  it('starts the client with the game’s launch arguments when a launch follows, naming the game instead of a ready time', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    processes.setRunning(RIOT_CLIENT_WINDOW_EXE, true);
    const result = await adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true, game: { launcherGameId: 'valorant.live', name: 'VALORANT' } });
    expect(result).toMatchObject({ ok: true, startedWithGame: 'valorant.live', readyAt: null });
    expect(result.steps[4]!.detail).toBe("Client started with VALORANT's launch arguments.");
    expect(kinds()).toEqual([
      `close ${RIOT_CLIENT_EXE}`,
      `close ${RIOT_CLIENT_WINDOW_EXE}`,
      `start ${join(installDir, RIOT_CLIENT_EXE)} --launch-product=valorant --launch-patchline=live`,
    ]);
    const logs = join(localAppData, 'Riot Games', 'Riot Client', 'Logs', 'Riot Client Logs');
    expect(launchRequest(currentRunEvents(logs))).toEqual({ product: 'valorant', patchline: 'live' });
  });

  it('starts a closed client that already holds the account’s sign-in without writing, saving the newer copy first', async () => {
    const result = await adapter().switchAccount(ref(A), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(statusOf(result.steps).slice(0, 4)).toEqual([
      [STEPS.close, 'skipped'],
      ["Save this account's sign-in", 'done'],
      [STEPS.backup, 'skipped'],
      [STEPS.file, 'skipped'],
    ]);
    expect(result.backupId).toBeNull();
    expect(result.readyAt).not.toBeNull();
    expect(sessions.get(A.id)).toMatchObject({ fingerprint: FINGERPRINT, launcherUid: SUB });
    expect(sessions.get(A.id)!.verifiedAt).not.toBeNull();
    expect(kinds()).toEqual([`start ${join(installDir, RIOT_CLIENT_EXE)}`]);
    expect(onDisk()).toMatchObject({ accountId: SUB, writeCount: 4 });
  });

  it('changes nothing when the running client is already signed in as the account', async () => {
    sim = new RiotSim({ localAppData, processes, knobs: { runningAs: SUB } });
    processes.onStart = (exe, args) => sim.onStart(exe, args);
    const result = await adapter().switchAccount(ref(A), { dryRun: false });
    expect(result).toMatchObject({ ok: true, backupId: null, restored: null, readyAt: null });
    expect(result.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(processes.events).toEqual([]);
    expect(backups.list('riot')).toEqual([]);
  });

  it('refuses to close a running client without confirmation', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    await expect(adapter().switchAccount(ref(B), { dryRun: false })).rejects.toMatchObject({
      code: 'CONFIRM_REQUIRED',
      message: 'The Riot Client is running. Switching closes it.',
      runningGame: null,
    });
    expect(processes.events).toEqual([]);
  });

  it('stops before changing anything when something else starts the client before the write', async () => {
    // The plan's listing saw no client; every look after it does.
    processes.isRunning = async () => true;
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: null, backupId: null });
    expect(result.error).toBe(
      'The Riot Client was started by something else while One Launch was switching accounts, so the switch stopped before changing anything. Try again.',
    );
    expect(result.steps[0]).toMatchObject({ title: STEPS.close, status: 'failed' });
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(sessions.get(A.id)).toBeNull();
    expect(backups.list('riot')).toEqual([]);
  });

  it('rolls the file back when something else starts the client while it is being written', async () => {
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      onProgress: (steps) => {
        if (steps.some((s) => s.title === STEPS.file && s.status === 'done')) processes.setRunning(RIOT_CLIENT_EXE, true);
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: true });
    expect(result.error).toBe('The Riot Client was started by something else while One Launch was switching accounts, so the switch was stopped. Try again.');
    expect(statusOf(result.steps).slice(4, 7)).toEqual([
      [STEPS.start, 'failed'],
      [STEPS.wait, 'pending'],
      [STEPS.verify, 'pending'],
    ]);
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(kinds()).toEqual([`close ${RIOT_CLIENT_EXE}`]);
  });

  it('an abort while the client is closing stops at once with nothing changed', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    processes.shutdownPolls = 1_000_000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await adapter({ timing: { shutdownMs: 5_000 } }).switchAccount(ref(B), { dryRun: false, confirmClose: true, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: null, backupId: null });
    expect(result.error).toBe('Stopped before the Riot Client was started as riot_alt. Nothing had been changed.');
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(backups.list('riot')).toEqual([]);
  });

  it('an abort after the write but before the client is started puts the file back', async () => {
    const controller = new AbortController();
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      signal: controller.signal,
      onProgress: (steps) => {
        if (steps.some((s) => s.title === STEPS.file && s.status === 'done')) controller.abort();
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: true });
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(kinds()).toEqual([]);
  });

  it('an abort once the client has been started ends the wait and leaves the write alone', async () => {
    sim.knobs.reactMs = 30;
    const controller = new AbortController();
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      signal: controller.signal,
      onProgress: (steps) => {
        if (steps.some((s) => s.title === STEPS.wait && s.status === 'done')) controller.abort();
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: null });
    expect(result.error).toBe('Stopped while the Riot Client was starting as riot_alt. Nothing was rolled back: the client carries on signing in on its own.');
    expect(result.backupId).not.toBeNull();
    expect(readFileSync(sessionPath, 'utf8')).toBe(ALT_FILE);
  });

  it('rolls the file back when the client never comes up', async () => {
    processes.startFails = true;
    const result = await adapter({ timing: { startupMs: 10 } }).switchAccount(ref(B), { dryRun: false });
    expect(result).toMatchObject({ ok: false, restored: true });
    expect(result.error).toBe(`${RIOT_CLIENT_EXE} did not appear within 0.01 s`);
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
  });
});

describe('Riot hand-over', () => {
  beforeEach(saveAlt);

  it('hands over when the client refuses the saved sign-in, marks it stale, then stores the fresh sign-in', async () => {
    sim.knobs.rejected = [OTHER_SUB];
    const staleWhenAsked: (string | null)[] = [];
    const { seen, onAttention } = attentionLog(OTHER_SUB);
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      onAttention: (a) => {
        if (a) staleWhenAsked.push(sessions.get(B.id)?.staleReason ?? null);
        onAttention(a);
      },
    });
    expect(result).toMatchObject({ ok: true, needsSignIn: false, cancelled: false });
    expect(statusOf(result.steps).slice(6)).toEqual([
      [STEPS.verify, 'failed'],
      [STEPS.manual, 'done'],
      [STEPS.recapture, 'done'],
    ]);
    expect(result.steps[6]!.detail).toBe('The client ended on its login page: the client refused the saved sign-in (401 invalid_grant).');
    expect(result.steps[7]!.detail).toBe('Signed in as riot_alt.');
    expect(result.steps[8]!.detail).toMatch(/^Stored Alt's sign-in \(fingerprint [0-9a-f]{8}\)\.$/);
    expect(staleWhenAsked).toEqual(['the client refused the saved sign-in (401 invalid_grant)']);
    expect(seen.map((a) => a && a.title)).toEqual(['The Riot Client is asking you to sign in as riot_alt', null]);
    expect(seen[0]).toMatchObject({ kind: 'sign-in', reason: 'the client refused the saved sign-in (401 invalid_grant)', canCopyPassword: false });
    expect(seen[0]!.message).toBe(
      "The client refused its saved sign-in. Sign in once in the Riot Client window with “Stay signed in” ticked. One Launch saves the sign-in and continues on its own as soon as the client reports it; later switches are automatic. To change accounts afterwards, switch through One Launch rather than the client's Sign out, which ends the saved sign-in for good.",
    );
    const fresh = onDisk()!;
    expect(sessions.get(B.id)).toMatchObject({ fingerprint: fresh.fingerprint, staleReason: null });
    expect(sessions.get(B.id)!.verifiedAt).not.toBeNull();
    expect(JSON.parse(sessions.decrypt(B.id)!).file).toBe(readFileSync(sessionPath, 'utf8'));
  });

  it('does not mark the saved sign-in stale on a service failure, and still hands over', async () => {
    sim.knobs.authError = 'request_failed';
    const staleWhenAsked: (string | null)[] = [];
    const { onAttention } = attentionLog(OTHER_SUB);
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      onAttention: (a) => {
        if (a) staleWhenAsked.push(sessions.get(B.id)?.staleReason ?? null);
        onAttention(a);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.steps[6]!.detail).toBe('The client ended on its login page: the sign-in did not complete (request_failed).');
    expect(staleWhenAsked).toEqual([null]);
  });

  it('runs the sign-out path: writes null and nothing else, waits for the sign-in, links the id, stores the file', async () => {
    const { seen, onAttention } = attentionLog(NEW_SUB);
    let signedOutText: string | null = null;
    const result = await adapter().switchAccount(ref(C), {
      dryRun: false,
      getPassword: () => 'pw-new',
      onAttention,
      onProgress: (steps) => {
        if (signedOutText === null && steps.some((s) => s.title === STEPS.signOut && s.status === 'done')) signedOutText = readFileSync(sessionPath, 'utf8');
      },
    });
    expect(result).toMatchObject({ ok: true, strategy: 'credentials' });
    expect(statusOf(result.steps)).toEqual([
      [STEPS.close, 'skipped'],
      ['Save the outgoing sign-in', 'done'],
      [STEPS.backup, 'done'],
      [STEPS.signOut, 'done'],
      [STEPS.start, 'done'],
      [STEPS.wait, 'done'],
      [STEPS.verify, 'failed'],
      [STEPS.manual, 'done'],
      [STEPS.recapture, 'done'],
    ]);
    expect(signedOutText).toBe(spliceSessionBlock(SIGNED_IN, null));
    expect(signedOutText).toBe(SIGNED_OUT);
    expect(result.steps[6]!.detail).toBe('The client ended on its login page: no saved sign-in.');
    expect(result.steps[7]!.detail).toBe('Signed in as riot_new. Linked to Riot account …4444.');
    expect(seen[0]).toMatchObject({ title: 'Sign in to the Riot Client as riot_new', reason: null, canCopyPassword: true });
    expect(seen[0]!.message).toMatch(/^No sign-in is saved for this account yet\. Sign in once/);
    expect(accounts.require(C.id).launcherUid).toBe(NEW_SUB);
    expect(sessions.get(C.id)).toMatchObject({ launcherUid: NEW_SUB, fingerprint: onDisk()!.fingerprint, staleReason: null });
    expect(sessions.get(C.id)!.verifiedAt).not.toBeNull();
    expect(sessions.get(A.id)?.fingerprint).toBe(FINGERPRINT);
    noTokens(JSON.stringify({ result, seen }));
  });

  it('a sign-in without “Stay signed in” is stored, and the client forgets it at exit', async () => {
    sim.knobs.staySignedIn = false;
    const result = await adapter().switchAccount(ref(C), { dryRun: false, onAttention: attentionLog(NEW_SUB).onAttention });
    expect(result.ok).toBe(true);
    expect(sessions.get(C.id)).not.toBeNull();
    await adapter().shutdown();
    expect(onDisk()).toBeNull();
    expect((await adapter().sessionState()).remembered).toBe(false);
  });

  it('fails and rolls back when the user signs in as another One Launch account, storing that sign-in for its owner first', async () => {
    const result = await adapter().switchAccount(ref(C), { dryRun: false, onAttention: attentionLog(SUB).onAttention });
    expect(result).toMatchObject({ ok: false, restored: true, cancelled: false, needsSignIn: false });
    expect(result.error).toBe(
      'The Riot Client signed in as Main (Riot account …1111), which is another One Launch account, instead of New. Sign in to the client as riot_new.',
    );
    expect(result.steps[7]).toMatchObject({ status: 'failed', detail: 'Signed in as a different account.' });
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(accounts.require(C.id).launcherUid).toBeNull();
    expect(sessions.get(C.id)).toBeNull();
    // Main's copy is the one the user just made in the client (a fresh token), not the file the switch began with.
    expect(sessions.get(A.id)?.fingerprint).not.toBe(FINGERPRINT);
    expect(JSON.parse(sessions.decrypt(A.id)!).file).toContain('placeholder-refresh-');
    expect(kinds()).toEqual([`start ${join(installDir, RIOT_CLIENT_EXE)}`, `close ${RIOT_CLIENT_EXE}`, `close ${RIOT_CLIENT_WINDOW_EXE}`]);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(false);
  });

  it('fails and rolls back when a linked account signs in as a Riot account that is not its own', async () => {
    sim.knobs.rejected = [OTHER_SUB];
    const result = await adapter().switchAccount(ref(B), { dryRun: false, onAttention: attentionLog(NEW_SUB).onAttention });
    expect(result).toMatchObject({ ok: false, restored: true });
    expect(result.error).toBe(
      'The Riot Client signed in as Riot account …4444 instead of Alt (…3333). Sign in to the client as riot_alt, or fix the Riot account id on the account page.',
    );
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(sessions.get(B.id)?.fingerprint).toBe(ALT_FINGERPRINT);
  });

  it('reports cancelled when the user stops waiting, rolling nothing back', async () => {
    sim.knobs.rejected = [OTHER_SUB];
    const controller = new AbortController();
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      signal: controller.signal,
      onAttention: (a) => {
        if (a) controller.abort();
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: null });
    expect(result.error).toBe(
      'Stopped waiting for the sign-in as riot_alt. The Riot Client was left on its login page; signing in there with “Stay signed in” ticked finishes the switch, and the sign-in is saved at the next one.',
    );
    expect(result.steps[7]).toMatchObject({ status: 'failed', detail: 'Stopped waiting.' });
    expect(onDisk()).toBeNull();
  });

  it('ends in needs-sign-in when the manual wait runs out, with nothing rolled back', async () => {
    sim.knobs.rejected = [OTHER_SUB];
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result).toMatchObject({ ok: false, needsSignIn: true, cancelled: false, restored: null });
    expect(result.error).toMatch(
      /^One Launch waited .* for the sign-in as riot_alt and gave up\. The Riot Client is still on its login page: sign in there with “Stay signed in” ticked/,
    );
    expect(sessions.get(B.id)?.staleReason).toContain('invalid_grant');
  });

  it("the client's own Sign out during the manual wait is not final; the sign-in that follows finishes the switch", async () => {
    sim.knobs.rejected = [OTHER_SUB];
    const result = await adapter({ timing: { manualSignInMs: 300 } }).switchAccount(ref(B), {
      dryRun: false,
      onAttention: (a) => {
        if (!a) return;
        setTimeout(() => sim.signOut(), 5);
        setTimeout(() => sim.signInByHand(OTHER_SUB), 30);
      },
    });
    expect(result).toMatchObject({ ok: true, needsSignIn: false });
    expect(result.steps[7]).toMatchObject({ status: 'done', detail: 'Signed in as riot_alt.' });
    expect(sessions.get(B.id)?.fingerprint).toBe(onDisk()!.fingerprint);
  });
});

describe('Riot restore and sign-ins nobody owns', () => {
  const PIN = 'Holds a sign-in that no One Launch account owns';
  beforeEach(saveAlt);

  it('says in the plan that the backup keeps an unowned sign-in, and pins the snapshot the switch takes', async () => {
    accounts.update(A.id, { launcherUid: null });
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.steps[1]!.detail).toContain('that no One Launch account owns, so it is left alone and not saved');
    expect(plan.warnings.find((w) => w.includes('no One Launch account owns'))).toBe(
      'The Riot Client holds a sign-in that no One Launch account owns (Riot account …1111). It will be replaced. The backup taken before this switch keeps a copy and is left out of the usual clean-up, so restoring it from Settings › Backups brings that sign-in back.',
    );

    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.steps[1]!.status).toBe('skipped');
    const snapshot = backups.get('riot', result.backupId!)!;
    expect(snapshot.pinned).toBe(PIN);
    expect(backups.readFile('riot', snapshot.id, 'Data/RiotGamesPrivateSettings.yaml').toString('utf8')).toBe(SIGNED_IN);
    expect(sessions.list('riot').map((s) => s.accountId)).toEqual([B.id]);
  });

  it('does not pin a switch between two accounts One Launch knows', async () => {
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(backups.get('riot', result.backupId!)!.pinned).toBeNull();
  });

  it('refuses a restore while the client or a game runs, and otherwise stores what the file holds for its owner and puts the snapshot back', async () => {
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result.ok).toBe(true);
    const rotated = onDisk()!;
    await expect(adapter().restoreBackup(result.backupId!)).rejects.toMatchObject({
      code: 'LAUNCHER_RUNNING',
      message: `Exit the Riot Client from its tray icon before restoring: it rewrites ${SESSION_FILE} while it runs, which would undo the restore.`,
    });
    processes.setRunning(RIOT_CLIENT_EXE, false);
    processes.processes = [{ name: 'LeagueClient', pid: 7, path: null }];
    await expect(adapter().restoreBackup(result.backupId!)).rejects.toMatchObject({
      code: 'GAME_RUNNING',
      message: 'League of Legends is running. Close it, then restore: One Launch never closes a Riot game.',
    });
    processes.processes = [];
    expect(backups.list('riot')).toHaveLength(1);

    const restored = await adapter().restoreBackup(result.backupId!);
    expect(restored).toEqual({ launcher: 'riot', id: result.backupId, files: [sessionPath], registry: [] });
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    expect(sessions.get(B.id)?.fingerprint).toBe(rotated.fingerprint);
    const taken = backups.list('riot').find((s) => s.reason === `Before restoring ${result.backupId}`)!;
    expect(taken.pinned).toBeNull();
    expect(backups.readFile('riot', taken.id, 'Data/RiotGamesPrivateSettings.yaml').toString('utf8')).toContain(`refresh_token_write_count: 2`);
  });

  it('pins the snapshot a restore takes first when the state it replaces is a sign-in nobody owns', async () => {
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    processes.setRunning(RIOT_CLIENT_EXE, false);
    writeFileSync(sessionPath, fakeSessionFile(NEW_SUB, 'placeholder-refresh-token-of-a-stranger'));
    await adapter().restoreBackup(result.backupId!);
    const taken = backups.list('riot').find((s) => s.reason === `Before restoring ${result.backupId}`)!;
    expect(taken.pinned).toBe(PIN);
    expect(readFileSync(sessionPath, 'utf8')).toBe(SIGNED_IN);
    // Main's outgoing sign-in and Alt's: the stranger's was kept in the snapshot, never stored.
    expect(
      sessions
        .list('riot')
        .map((s) => s.accountId)
        .sort(),
    ).toEqual([A.id, B.id].sort());
  });
});

describe('Riot launch', () => {
  const EXE = (): string => join(installDir, RIOT_CLIENT_EXE);
  const VALORANT = { launcherGameId: 'valorant.live', name: 'VALORANT' };
  const LAUNCH = `--launch-product=valorant --launch-patchline=live`;
  const failing = async (call: Promise<unknown>): Promise<unknown> => {
    let err: unknown;
    await call.catch((e: unknown) => {
      err = e;
    });
    return err;
  };
  /** The client running and signed in as Main when the launch is asked for, as a switch leaves it. */
  const clientUp = (knobs: Partial<RiotKnobs> = {}): void => {
    sim = new RiotSim({ localAppData, processes, knobs: { runningAs: SUB, ...knobs } });
    processes.onStart = (exe, args) => sim.onStart(exe, args);
  };

  const HAND_OFF = 'Press Play in the Riot Client window to start VALORANT; it is open on the game’s page.'.replace('’', "'");
  const LOCKFILE = (): string => join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile');
  /** The channel to the client's local server as the fake platform wires it: the request recorded, then the simulator's Play (or `answer` instead). */
  const localLaunch = (answer?: () => void): { requests: LocalLaunchRequest[]; channel: RiotLocalLaunch } => {
    const requests: LocalLaunchRequest[] = [];
    return {
      requests,
      channel: {
        launch: async (req) => {
          requests.push(req);
          if (answer) answer();
          else sim.pressPlay(`${req.product}.${req.patchline}`);
        },
      },
    };
  };

  it('after a switch that started the client for the game, sends nothing and presses Play on the page the start opened', async () => {
    saveAlt();
    const { requests, channel } = localLaunch();
    const a = adapter({ localLaunch: channel });
    const switched = await a.switchAccount(ref(B), { dryRun: false, game: VALORANT });
    expect(switched).toMatchObject({ ok: true, startedWithGame: 'valorant.live', readyAt: null });
    processes.events.length = 0;
    const { command, handOff } = await a.launchGame(VALORANT, { startedBySwitch: true });
    expect(processes.events).toEqual([]);
    expect(requests.map((r) => r.product)).toEqual(['valorant']);
    expect(command).toBe(
      `"${EXE()}" ${LAUNCH} (the switch started the client with these arguments; One Launch pressed Play and the Riot Client started the game)`,
    );
    expect(handOff).toBeUndefined();
  });

  it('with startedBySwitch but a run without the product context (a bare start), hands the client the arguments as before', async () => {
    clientUp();
    const { requests, channel } = localLaunch();
    const { command } = await adapter({ localLaunch: channel }).launchGame(VALORANT, { startedBySwitch: true });
    expect(kinds()).toEqual([`start ${EXE()} ${LAUNCH}`]);
    expect(requests).toHaveLength(1);
    expect(command).toBe(`"${EXE()}" ${LAUNCH} (One Launch pressed Play and the Riot Client started the game)`);
  });

  it('presses Play for the user once the page is up: one launch request to the client’s local server, then the game confirmed by its name', async () => {
    clientUp();
    const { requests, channel } = localLaunch();
    const { command, handOff } = await adapter({ localLaunch: channel }).launchGame(VALORANT);
    expect(command).toBe(`"${EXE()}" ${LAUNCH} (One Launch pressed Play and the Riot Client started the game)`);
    expect(handOff).toBeUndefined();
    expect(requests).toEqual([{ product: 'valorant', patchline: 'live', lockfilePath: LOCKFILE(), signal: undefined }]);
    // The client was handed the arguments once; the game's process was never touched, only seen.
    expect(kinds()).toEqual([`start ${EXE()} ${LAUNCH}`]);
    expect(await processes.isRunning('VALORANT.exe')).toBe(true);
    expect(await adapter().runningGame()).toMatchObject({ launcherGameId: 'valorant.live', source: 'process' });
  });

  it('with the setting off, hands over as before and sends nothing to the local server', async () => {
    clientUp();
    const { requests, channel } = localLaunch();
    const { command, handOff } = await adapter({ localLaunch: channel, pressPlay: false }).launchGame(VALORANT);
    expect(command).toBe(`"${EXE()}" ${LAUNCH} (the Riot Client opened the game's page: Auto-launch is disabled)`);
    expect(handOff).toBe(HAND_OFF);
    expect(requests).toEqual([]);
  });

  it('hands over, saying what happened, when the client refuses the request or takes it and starts nothing', async () => {
    clientUp();
    const refused = localLaunch(() => {
      throw new Error('the Riot Client answered the launch request with HTTP 500');
    });
    const a = await adapter({ localLaunch: refused.channel }).launchGame(VALORANT);
    expect(a.command).toBe(
      `"${EXE()}" ${LAUNCH} (the Riot Client opened the game's page: Auto-launch is disabled; the launch request was not taken: the Riot Client answered the launch request with HTTP 500)`,
    );
    expect(a.handOff).toBe(HAND_OFF);
    expect(refused.requests).toHaveLength(1);

    const silent = localLaunch(() => {});
    const b = await adapter({ localLaunch: silent.channel }).launchGame(VALORANT);
    expect(b.command).toBe(
      `"${EXE()}" ${LAUNCH} (the Riot Client opened the game's page: Auto-launch is disabled; the Riot Client took the launch request but did not start the game within 0.04 s)`,
    );
    expect(b.handOff).toBe(HAND_OFF);
    expect(silent.requests).toHaveLength(1);
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);
  });

  it('never sends the request for a product the client reports out of date', async () => {
    clientUp({ updatesPending: ['valorant.live'] });
    const { requests, channel } = localLaunch();
    const err = await failing(adapter({ localLaunch: channel }).launchGame(VALORANT));
    expect(err).toMatchObject({ code: 'GAME_NOT_PLAYABLE' });
    expect(requests).toEqual([]);
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);
  });

  it('stops watching when the signal aborts during the press, with the request already sent', async () => {
    clientUp();
    const controller = new AbortController();
    const { requests, channel } = localLaunch(() => controller.abort());
    const { command, handOff } = await adapter({ localLaunch: channel, timing: { playConfirmMs: 500 } }).launchGame(VALORANT, { signal: controller.signal });
    expect(command).toBe(`"${EXE()}" ${LAUNCH} (stopped watching for the game start)`);
    expect(handOff).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('hands the running client the shortcut’s arguments; the client opens the game’s page, and the launch hands over to Play', async () => {
    clientUp();
    const { command, handOff } = await adapter().launchGame(VALORANT);
    expect(command).toBe(`"${EXE()}" ${LAUNCH} (the Riot Client opened the game's page: Auto-launch is disabled)`);
    expect(handOff).toBe(HAND_OFF);
    // The running client is left alone: one start with the arguments, which the singleton takes; no close, no kill, no game process.
    expect(kinds()).toEqual([`start ${EXE()} ${LAUNCH}`]);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(true);
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);
    expect(await adapter().runningGame()).toBeNull();
    // The user presses Play; the game is then seen by its process name.
    sim.pressPlay('valorant.live');
    expect(await adapter().runningGame()).toMatchObject({ launcher: 'riot', launcherGameId: 'valorant.live', name: 'VALORANT', source: 'process' });
  });

  it('starts a closed client with the arguments; it signs in from the saved sign-in, opens the game’s page, and hands over', async () => {
    const { command, handOff } = await adapter().launchGame(VALORANT);
    expect(command).toBe(`"${EXE()}" ${LAUNCH} (the Riot Client opened the game's page: Auto-launch is disabled)`);
    expect(handOff).toBe(HAND_OFF);
    expect(kinds()).toEqual([`start ${EXE()} ${LAUNCH}`]);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(true);
    expect(onDisk()?.accountId).toBe(SUB);
    expect(onDisk()?.fingerprint).not.toBe(FINGERPRINT);
    const events = currentRunEvents(join(localAppData, 'Riot Games', 'Riot Client', 'Logs', 'Riot Client Logs'));
    expect(lastSignIn(events)).toEqual({ ok: true, how: 'restored' });
    expect(launchRequest(events)).toEqual({ product: 'valorant', patchline: 'live' });
    expect(gameStarted(events, 'valorant', 'live')).toBe(false);
  });

  it('confirms the start from the game’s own process name when a client does start the game itself', async () => {
    // Build 77 did; a client with Riot's auto-launch flag off does not.
    sim = new RiotSim({ localAppData, processes, knobs: { directLaunch: true } });
    processes.onStart = (exe, args) => sim.onStart(exe, args);
    const { command, handOff } = await adapter().launchGame(VALORANT);
    expect(command).toBe(`"${EXE()}" ${LAUNCH} (the Riot Client started the game)`);
    expect(handOff).toBeUndefined();
    expect(await processes.isRunning('VALORANT.exe')).toBe(true);
    expect(await adapter().runningGame()).toMatchObject({ launcherGameId: 'valorant.live', source: 'process' });
  });

  it('fails with the client’s own reason when it lands on its login page', async () => {
    // The client refuses the saved sign-in: no page, no launch, and the saved copy is not touched here.
    sim.knobs.rejected = [SUB];
    const refused = await failing(adapter().launchGame(VALORANT));
    expect((refused as Error).message).toBe(
      'The Riot Client opened on its login page instead of signing in (the client refused the saved sign-in (401 invalid_grant)), so VALORANT was not started. Sign in there with “Stay signed in” ticked and press Play; One Launch saves the sign-in at the next switch.',
    );
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);
    expect(sessions.get(A.id)).toBeNull();

    // No saved sign-in at all.
    processes.setRunning(RIOT_CLIENT_EXE, false);
    processes.setRunning(RIOT_CLIENT_WINDOW_EXE, false);
    writeFileSync(sessionPath, SIGNED_OUT);
    sim = new RiotSim({ localAppData, processes });
    processes.onStart = (exe, args) => sim.onStart(exe, args);
    const signedOut = await failing(adapter().launchGame(VALORANT));
    expect((signedOut as Error).message).toContain('opened on its login page instead of signing in (no saved sign-in)');
  });

  it('refuses while a Riot game runs, before sending anything: the same game, or another one', async () => {
    clientUp();
    processes.processes = [{ name: 'VALORANT-Win64-Shipping', pid: 1, path: null }];
    const same = await failing(adapter().launchGame(VALORANT));
    expect(same).toMatchObject({ code: 'GAME_RUNNING', message: 'VALORANT is already running.' });
    const other = await failing(adapter().launchGame({ launcherGameId: 'teamfighttactics.live', name: 'Teamfight Tactics' }));
    expect(other).toMatchObject({
      code: 'GAME_RUNNING',
      message: 'VALORANT is running. Close it, then press Play again: One Launch never closes a Riot game.',
    });
    expect(isRefusal(same) && isRefusal(other)).toBe(true);
    expect(processes.events).toEqual([]);
  });

  it('refuses a product the client’s newest log reports out of date, and the library and health say so too', async () => {
    writeLog(
      [
        '000000.000| ALWAYS| Logging started at 2026-10-06T10:00:00.000',
        '000000.000| ALWAYS| Application Version: 140.0.6.5027',
        '000004.590|   OKAY| patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: OutOfDate, progress: 0',
        '000004.591|   OKAY| patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: pbe, status: UpToDate, progress: 0',
        '',
      ].join('\r\n'),
    );
    const err = await failing(adapter().launchGame(VALORANT));
    expect(err).toMatchObject({
      code: 'GAME_NOT_PLAYABLE',
      message: 'VALORANT needs an update before it can start. Update it in the Riot Client window, then press Play again.',
    });
    expect(isRefusal(err)).toBe(true);
    expect(processes.events).toEqual([]);

    const games = await adapter().listInstalledGames();
    expect(games.map((g) => [g.launcherGameId, g.needsUpdate])).toEqual([
      ['valorant.live', true],
      ['valorant.pbe', false],
    ]);
    const products = (await adapter().healthCheck()).checks.find((c) => c.id === 'products')!;
    expect(products.detail).toContain('valorant.live (installed, needs an update)');
    expect(products.detail).toContain('valorant.pbe (installed)');
  });

  it('fails with the client’s reason when it reports the product out of date after the command, and the game is never started', async () => {
    sim = new RiotSim({ localAppData, processes, knobs: { updatesPending: ['valorant.live'] } });
    processes.onStart = (exe, args) => sim.onStart(exe, args);
    const err = await failing(adapter().launchGame(VALORANT));
    expect(err).toMatchObject({ code: 'GAME_NOT_PLAYABLE', message: expect.stringContaining('VALORANT needs an update before it can start') });
    expect(kinds()).toEqual([`start ${EXE()} ${LAUNCH}`]);
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);
  });

  it('fails when the watch runs out, saying whether the client took the request', async () => {
    // The simulated install does not carry the PBE, so the client sets its context and nothing follows.
    const silent = await failing(adapter().launchGame({ launcherGameId: 'valorant.pbe', name: 'VALORANT (PBE)' }));
    expect(silent).toBeInstanceOf(Error);
    expect((silent as Error).message).toBe(
      'VALORANT (PBE) did not start within 0.04 s. Look at the Riot Client window: the game may need an update or a repair, or the client may be waiting for you.',
    );
    expect(isRefusal(silent)).toBe(false);

    // A client that has not got going by the time the watch runs out (updating itself) has logged nothing at all.
    processes.setRunning(RIOT_CLIENT_EXE, false);
    processes.setRunning(RIOT_CLIENT_WINDOW_EXE, false);
    sim = new RiotSim({ localAppData, processes, knobs: { reactMs: 200 } });
    processes.onStart = (exe, args) => sim.onStart(exe, args);
    const ignored = await failing(adapter().launchGame(VALORANT));
    expect((ignored as Error).message).toBe(
      'The Riot Client did not act on the launch within 0.04 s. Look at the Riot Client window: it may be updating itself or asking you to sign in.',
    );
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  it('stops watching when the signal aborts, with the client already started', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const { command } = await adapter({ timing: { launchConfirmMs: 500 } }).launchGame(
      { launcherGameId: 'valorant.pbe', name: 'VALORANT (PBE)' },
      { signal: controller.signal },
    );
    expect(command).toBe(`"${EXE()}" --launch-product=valorant --launch-patchline=pbe (stopped watching for the game start)`);
  });

  it('rejects an id that is not a product, and needs the client installed, before touching anything', async () => {
    const bad = await failing(adapter().launchGame({ launcherGameId: 'valorant', name: 'VALORANT' }));
    expect((bad as Error).message).toBe('Not a Riot product id: valorant');
    rmSync(join(installDir, RIOT_CLIENT_EXE));
    registry = new StaticRegistry({});
    const gone = await failing(adapter().launchGame(VALORANT));
    expect(gone).toMatchObject({ code: 'NOT_INSTALLED' });
    expect(processes.events).toEqual([]);
  });
});

describe('Riot health', () => {
  it('describes the install, the products, the data folder and the log', async () => {
    processes.setRunning(RIOT_CLIENT_EXE, true);
    const report = await adapter().healthCheck();
    expect(report.launcher).toBe('riot');
    expect(report.status).toBe('ok');
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId['install']).toMatchObject({ status: 'ok', detail: `${installDir} (from HKCU)` });
    expect(byId['process']).toMatchObject({ status: 'ok', detail: `${RIOT_CLIENT_EXE} is running` });
    expect(byId['installs']).toMatchObject({ status: 'ok' });
    expect(byId['installs']!.detail).toContain('1 game folder associated');
    expect(byId['products']).toMatchObject({ status: 'ok' });
    expect(byId['products']!.detail).toBe(
      '5 product folders in Metadata: bacon.live (not installed), league_of_legends.live (not installed), teamfighttactics.live (install folder missing), valorant.live (installed), valorant.pbe (installed)',
    );
    expect(byId['data']).toMatchObject({ status: 'ok' });
    expect(byId['data']!.detail).toContain(`${SESSION_FILE} holds a saved sign-in for Riot account …1111`);
    expect(byId['log']).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^1 run log in .*; the newest run reached no sign-in verdict$/) });
    expect(byId['sessions']).toMatchObject({ status: 'ok', detail: '0 snapshots stored' });
    expect(byId['backups']).toMatchObject({ status: 'ok', detail: 'No snapshots yet' });
    expect(JSON.stringify(report)).not.toContain('eyJ');
    expect(JSON.stringify(report)).not.toContain('Placeholder#0000');
  });

  it('reads the newest run’s build and sign-in verdict from the log, and warns when the saved sign-in was refused', async () => {
    const row = async () => (await adapter().healthCheck()).checks.find((c) => c.id === 'log')!;
    writeLog(fixture('2026-10-04T20-34-14_10001_Riot Client.log'));
    expect(await row()).toMatchObject({ status: 'ok', detail: expect.stringContaining('2 run logs in ') });
    expect((await row()).detail).toMatch(/; the newest run \(build 140\.0\.6\.5027\) signed in from the saved sign-in$/);
    writeLog(fixture('2026-10-04T20-56-32_10002_Riot Client.log'));
    expect((await row()).detail).toMatch(/signed in by hand$/);
    writeLog(fixture('2026-10-04T20-42-52_10003_Riot Client.log'));
    expect(await row()).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(
        /the newest run \(build 140\.0\.6\.5027\) ended on the login page \(the client refused the saved sign-in \(401 invalid_grant\)\)$/,
      ),
    });
    rmSync(join(localAppData, 'Riot Games', 'Riot Client', 'Logs'), { recursive: true });
    expect(await row()).toMatchObject({ status: 'warn', detail: expect.stringContaining('not found. Sign-ins cannot be confirmed') });
  });

  it('describes the session file without reading a value: signed out, device-bound, an unknown shape, absent', async () => {
    const data = async () => (await adapter().healthCheck()).checks.find((c) => c.id === 'data')!;
    writeFileSync(sessionPath, SIGNED_OUT);
    expect(await data()).toMatchObject({ status: 'ok', detail: expect.stringContaining(`${SESSION_FILE} present, signed out (no saved sign-in)`) });
    writeFileSync(sessionPath, SIGNED_IN.replace('is_dpop_bound: false', 'is_dpop_bound: true'));
    expect(await data()).toMatchObject({ status: 'warn', detail: expect.stringContaining('bound to a device key (is_dpop_bound)') });
    writeFileSync(sessionPath, 'nothing: here\n');
    expect(await data()).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining(`${SESSION_FILE} is not in the shape One Launch knows (no psl block)`),
    });
    rmSync(sessionPath);
    expect(await data()).toMatchObject({ status: 'ok', detail: expect.stringContaining(`${SESSION_FILE} absent (the client has not saved a sign-in yet)`) });
  });

  it('warns about a client that has never run for this user and about a product folder that is gone', async () => {
    rmSync(join(localAppData, 'Riot Games'), { recursive: true, force: true });
    rmSync(metadataDir, { recursive: true, force: true });
    const report = await adapter().healthCheck();
    expect(report.status).toBe('warn');
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId['data']).toMatchObject({ status: 'warn', detail: expect.stringContaining('has not run for this Windows user yet') });
    expect(byId['log']).toMatchObject({ status: 'warn' });
    expect(byId['products']).toMatchObject({ status: 'warn', detail: expect.stringContaining('not found') });
    expect(await adapter().listInstalledGames()).toEqual([]);
  });

  it('is absent when nothing finds the client, and warns when the chosen folder no longer holds it', async () => {
    registry.delete(`HKCU\\${RIOT_CLIENT_UNINSTALL_KEY}\\InstallLocation`);
    registry.delete(`HKLM\\${RIOT_URI_COMMAND_KEY}\\`);
    rmSync(join(programData, 'Riot Games', 'RiotClientInstalls.json'));
    const absent = await adapter().healthCheck();
    expect(absent.status).toBe('absent');
    expect(absent.checks[0]!.detail).toContain('not installed on this PC');

    const gone = await adapter({ installDir: () => join(root, 'Gone'), defaultInstallDir: installDir }).healthCheck();
    expect(gone.checks.find((c) => c.id === 'chosen-folder')).toMatchObject({ status: 'warn' });
    expect(gone.checks.find((c) => c.id === 'install')).toMatchObject({ status: 'ok', detail: `${installDir} (from default location)` });
  });

  it('uses what the status pass already found out', async () => {
    const a = adapter();
    const report = await a.healthCheck({
      install: { launcher: 'riot', installDir, exePath: join(installDir, RIOT_CLIENT_EXE), source: 'launcher-file' },
      running: false,
    });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId['install']!.detail).toBe(`${installDir} (from RiotClientInstalls.json)`);
    expect(byId['process']!.detail).toBe(`${RIOT_CLIENT_EXE} is not running`);
  });
});

describe('Riot metadata parsers', () => {
  it('reads RiotClientInstalls.json and shrugs at junk', () => {
    const installs = parseInstalls(fixture('RiotClientInstalls.json'));
    expect(installs.rcDefault).toBe('D:/Games/Riot Games/Riot Client/RiotClientServices.exe');
    expect(installs.rcLive).toBe('D:/Games/Riot Games/Riot Client/RiotClientServices.exe');
    expect([...installs.associatedClients]).toEqual([['D:/Games/Riot Games/VALORANT/live/', 'D:/Games/Riot Games/Riot Client/RiotClientServices.exe']]);
    for (const junk of ['', '{', '[]', '{"rc_default": 5, "associated_client": "x"}']) {
      expect(parseInstalls(junk)).toEqual({ rcDefault: null, rcLive: null, associatedClients: new Map() });
    }
  });

  it('reads the top-level scalars of a product settings file', () => {
    expect(parseProductSettings(fixture('valorant.live.product_settings.yaml'))).toEqual({
      installPath: 'D:/Games/Riot Games/VALORANT/live',
      installRoot: 'D:/Games/Riot Games',
      dependency: null,
    });
    expect(parseProductSettings(fixture('league_of_legends.live.product_settings.yaml'))).toEqual({
      installPath: 'D:/Games/Riot Games/League of Legends',
      installRoot: 'D:/Games/Riot Games',
      dependency: 'teamfighttactics.live',
    });
    expect(parseProductSettings('product_install_full_path: ""\nnested:\n    product_install_root: "x"\n')).toEqual({
      installPath: null,
      installRoot: null,
      dependency: null,
    });
  });

  it('reads the last-session timestamps and nothing else from the client settings', () => {
    const stamps = parseLastSessionTimestamps(fixture('RiotClientSettings.yaml'));
    expect([...stamps]).toEqual([
      ['valorant.live', '2025-10-09T08:53:20.000Z'],
      ['league_of_legends.live', '2025-09-27T19:06:40.000Z'],
    ]);
    expect(parseLastSessionTimestamps('install:\n    globals:\n        region: "NA"\n')).toEqual(new Map());
    expect(parseLastSessionTimestamps('last-session-timestamp:\n    valorant.live: soon\n')).toEqual(new Map());
  });

  it('tells product folders from the rest and games from their process names', () => {
    expect(parseProductId('valorant.live')).toEqual({ id: 'valorant.live', product: 'valorant', patchline: 'live' });
    expect(parseProductId('Riot Client')).toBeNull();
    expect(parseProductId('league_of_legends.live.game_patch')).toBeNull();
    expect(productWithRunningImage(['explorer', 'VALORANT.exe'])).toBe('valorant');
    expect(productWithRunningImage(['league of legends'])).toBe('league_of_legends');
    expect(productWithRunningImage(['LoR'])).toBe('bacon');
    expect(productWithRunningImage(['vgtray', 'vgc', 'RiotClientServices', 'Riot Client'])).toBeNull();
  });
});
