import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcChannel, IpcEnvelope, IpcRequest } from '../src/shared/ipc-contract';
import type { LaunchJob } from '../src/shared/models';

/** The main-process handlers register through ipcMain; capture them instead of touching Electron. */
const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', isPackaged: false },
  shell: { openPath: async () => '' },
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
}));

const { registerIpcHandlers } = await import('../src/main/ipc');
import type { IpcDeps } from '../src/main/ipc';
import { migrate, openDatabase } from '../src/main/db';
import { BattlenetAdapter } from '../src/main/launchers/battlenet/adapter';
import { EpicAdapter, EPIC_EXE } from '../src/main/launchers/epic/adapter';
import {
  fingerprintOf as epicFingerprint,
  readSessionFromIni,
  serializeBlob as serializeEpicBlob,
  sessionBlobFromIni,
} from '../src/main/launchers/epic/session';
import { SteamAdapter, STEAM_HKCU_KEY } from '../src/main/launchers/steam/adapter';
import { BattlenetSim } from '../src/main/launchers/sim/battlenet';
import { EpicSim } from '../src/main/launchers/sim/epic';
import { SimProcessController } from '../src/main/launchers/sim/processes';
import { SteamSim } from '../src/main/launchers/sim/steam';
import { StaticRegistry } from '../src/main/platform/registry';
import { AccountsService } from '../src/main/services/accounts';
import { ArtworkService } from '../src/main/services/artwork';
import { BackupService } from '../src/main/services/backup';
import { LaunchService } from '../src/main/services/launch';
import { accountDirectory, LauncherService } from '../src/main/services/launchers';
import { scanLibrary } from '../src/main/services/library-scan';
import { LibraryService } from '../src/main/services/library';
import { createLogger } from '../src/main/services/logger';
import { SecretStore } from '../src/main/services/secrets';
import { LauncherSessionStore } from '../src/main/services/sessions';
import { SettingsService } from '../src/main/services/settings';
import { SwitchJournal, SwitchRecoveryService } from '../src/main/services/switch-journal';
import { VaultHealth } from '../src/main/services/vault-health';
import { FakeVault } from './helpers/fake-vault';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const steamFixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'steam', name), 'utf8');
const epicFixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'epic', name), 'utf8');
const bnetFixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'battlenet', name), 'utf8');
const vdfPath = (p: string): string => p.replace(/\\/g, '\\\\');

const STEAM_USER3_UID = '76561198000000003';
const EPIC_ID2 = '2'.repeat(32);
const EPIC_ID3 = '3'.repeat(32);
const STEAM_APPID = '252950';

const STEAM_TIMING = { pollMs: 2, shutdownMs: 200, killGraceMs: 100, startupMs: 500, signInMs: 200, guardMs: 200, readyGraceMs: 0 };
const EPIC_TIMING = {
  pollMs: 2,
  shutdownMs: 3_000,
  killGraceMs: 500,
  restartWatchMs: 25,
  restartSettleMs: 60,
  startupMs: 3_000,
  signInMs: 200,
  manualSignInMs: 2_000,
  captureMs: 40,
  readyGraceMs: 0,
  cleanExitWatchMs: 10,
};
const BNET_TIMING = {
  pollMs: 5,
  shutdownMs: 200,
  killGraceMs: 100,
  restartWatchMs: 20,
  restartSettleMs: 100,
  startupMs: 500,
  signInMs: 500,
  manualSignInMs: 1_000,
  captureMs: 300,
  readyGraceMs: 0,
  launchConfirmMs: 50,
};

interface Pipeline {
  root: string;
  paths: { dataDir: string; dbPath: string; artworkDir: string; backupsDir: string; logsDir: string; journalPath: string };
  registry: StaticRegistry;
  processes: SimProcessController;
  epicSim: EpicSim;
  epicIniPath: string;
  steamLoginUsers: string;
  accounts: AccountsService;
  library: LibraryService;
  settings: SettingsService;
  backups: BackupService;
  sessions: LauncherSessionStore;
  launchers: LauncherService;
  launch: LaunchService;
  journal: SwitchJournal;
  recovery: SwitchRecoveryService;
  opened: string[];
  steamAccountId: string;
  epicAId: string;
  epicBId: string;
  epicDataB: string;
  baseDeps: IpcDeps;
  reregister: (overrides: Partial<IpcDeps>) => void;
}

function setup(): Pipeline {
  handlers.clear();
  const root = mkdtempSync(join(tmpdir(), 'onelaunch-pipeline-'));
  const log = createLogger('test:pipeline');
  const opened: string[] = [];

  // --- launcher trees -------------------------------------------------------
  const steamDir = join(root, 'Steam');
  const steamLib = join(root, 'SteamLib');
  const steamLoginUsers = join(steamDir, 'config', 'loginusers.vdf');
  mkdirSync(join(steamDir, 'config'), { recursive: true });
  mkdirSync(join(steamDir, 'steamapps', 'common'), { recursive: true });
  mkdirSync(join(steamLib, 'steamapps', 'common', 'rocketleague'), { recursive: true });
  writeFileSync(join(steamDir, 'steam.exe'), '');
  writeFileSync(steamLoginUsers, steamFixture('loginusers.vdf'));
  writeFileSync(
    join(steamDir, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(steamDir)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(steamLib)}"\n\t}\n}\n`,
  );
  writeFileSync(join(steamLib, 'steamapps', 'appmanifest_252950.acf'), steamFixture('appmanifest_252950.acf'));

  const epicInstallLocation = join(root, 'Epic Games');
  const epicLauncherDir = join(epicInstallLocation, 'Launcher');
  const programData = join(root, 'ProgramData');
  const localAppData = join(root, 'Local');
  const epicIniPath = join(localAppData, 'EpicGamesLauncher', 'Saved', 'Config', 'Windows', 'GameUserSettings.ini');
  const epicManifests = join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  mkdirSync(join(epicLauncherDir, 'Portal', 'Binaries', 'Win64'), { recursive: true });
  writeFileSync(join(epicLauncherDir, 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'), '');
  mkdirSync(epicManifests, { recursive: true });
  writeFileSync(join(epicManifests, 'A0000000000000000000000000000001.item'), epicFixture('A0000000000000000000000000000001.item'));
  mkdirSync(join(programData, 'Epic', 'UnrealEngineLauncher'), { recursive: true });
  writeFileSync(join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'), epicFixture('LauncherInstalled.dat'));
  mkdirSync(join(localAppData, 'EpicGamesLauncher', 'Saved', 'Config', 'Windows'), { recursive: true });
  writeFileSync(epicIniPath, epicFixture('GameUserSettings.ini'));

  const bnetInstallDir = join(root, 'Battle.net');
  const bnetAppData = join(root, 'Roaming');
  const bnetConfigPath = join(bnetAppData, 'Battle.net', 'Battle.net.config');
  const bnetGames = join(root, 'BnetGames');
  mkdirSync(bnetInstallDir, { recursive: true });
  writeFileSync(join(bnetInstallDir, 'Battle.net.exe'), '');
  writeFileSync(join(bnetInstallDir, 'Battle.net Launcher.exe'), '');
  mkdirSync(join(bnetAppData, 'Battle.net'), { recursive: true });
  writeFileSync(bnetConfigPath, bnetFixture('Battle.net.config'));
  writeFileSync(join(bnetAppData, 'Battle.net', '0a1b2c3d.config'), bnetFixture('0a1b2c3d.config'));
  mkdirSync(join(bnetGames, 'Overwatch'), { recursive: true });
  mkdirSync(join(programData, 'Battle.net', 'Agent'), { recursive: true });
  writeFileSync(
    join(programData, 'Battle.net', 'Agent', 'aggregate.json'),
    JSON.stringify({ installed: [{ name: 'Overwatch', product_id: 'pro', launch_uri: 'battlenet://game/pro', last_played_timestamp: 1771729603000 }] }),
  );
  writeFileSync(join(programData, 'Battle.net', 'Agent', 'product.db'), BattlenetSim.productDb());

  // --- fake platform: one registry, one process table, three simulators -----
  const registry = new StaticRegistry({
    ...SteamSim.defaultRegistry(steamDir),
    ...EpicSim.defaultRegistry({ installLocation: epicInstallLocation, programData }),
    ...BattlenetSim.defaultRegistry({ installDir: bnetInstallDir, gamesDir: bnetGames }),
  });
  const processes = new SimProcessController();
  const steamSim = new SteamSim({ steamDir, registry, processes });
  const epicSim = new EpicSim({ localAppData, processes });
  const bnetSim = new BattlenetSim({ appData: bnetAppData, localAppData, registry, processes });
  processes.addListener((exe, args) => steamSim.onStart(exe, args));
  processes.addListener((exe, args) => epicSim.onStart(exe, args));
  processes.addListener((exe, args) => bnetSim.onStart(exe, args));

  // --- services -------------------------------------------------------------
  const db = openDatabase(':memory:');
  migrate(db);
  const vault = new FakeVault();
  const paths = {
    dataDir: root,
    dbPath: join(root, 'onelaunch.db'),
    artworkDir: join(root, 'artwork'),
    backupsDir: join(root, 'backups'),
    logsDir: join(root, 'logs'),
    journalPath: join(root, 'switch.json'),
  };
  const settings = new SettingsService(db);
  const accounts = new AccountsService(db, vault);
  const secrets = new SecretStore(db, vault);
  const library = new LibraryService(db);
  const sessions = new LauncherSessionStore(db, vault);
  const backups = new BackupService(join(root, 'backups'), { keep: () => 20, vault });

  const steam = new SteamAdapter({
    registry,
    processes,
    backups,
    log,
    backupsToKeep: () => 20,
    openExternal: async (url) => {
      opened.push(url);
    },
    autoLogin: () => false,
    defaultInstallDir: join(root, 'nowhere'),
    timing: STEAM_TIMING,
  });
  const epic = new EpicAdapter({
    registry,
    processes,
    backups,
    sessions,
    accounts: accountDirectory(accounts, 'epic'),
    log,
    backupsToKeep: () => 20,
    openExternal: async (url) => {
      opened.push(url);
    },
    launchUriForm: () => 'catalog',
    localAppData,
    programData,
    defaultInstallDir: join(root, 'nowhere'),
    timing: EPIC_TIMING,
  });
  const battlenet = new BattlenetAdapter({
    registry,
    processes,
    backups,
    sessions,
    accounts: accountDirectory(accounts, 'battlenet'),
    vault,
    log,
    backupsToKeep: () => 20,
    openExternal: async (url) => {
      opened.push(url);
    },
    launchForm: () => 'exec',
    appData: bnetAppData,
    localAppData,
    programData,
    defaultInstallDir: join(root, 'nowhere'),
    timing: BNET_TIMING,
  });

  const launchers = new LauncherService([steam, epic, battlenet], accounts, log, sessions);
  const journal = new SwitchJournal(paths.journalPath, log);
  const recovery = new SwitchRecoveryService({ journal, accounts, backups, launchers, log });
  recovery.load();
  const launch = new LaunchService(db, { launchers, accounts, library, settings, log, journal });
  const artwork = new ArtworkService(db, {
    dir: paths.artworkDir,
    fetch: async () => new Response(null, { status: 404 }),
    apiKey: () => null,
    hasApiKey: () => false,
    autoFetch: () => false,
    library,
    log,
  });

  // --- accounts and remembered sessions -------------------------------------
  const steamAccount = accounts.create({ launcher: 'steam', displayName: 'Third', login: 'user_3', launcherUid: STEAM_USER3_UID });
  const epicA = accounts.create({ launcher: 'epic', displayName: 'Main', login: 'main@example.com', launcherUid: EPIC_ID3, password: 'pw-a' });
  const epicB = accounts.create({ launcher: 'epic', displayName: 'Alt', login: 'alt@example.com', launcherUid: EPIC_ID2 });
  const onDisk = sessionBlobFromIni(epicFixture('GameUserSettings.ini'))!;
  const epicDataA = onDisk.rememberMe.data;
  sessions.save({ accountId: epicA.id, launcher: 'epic', launcherUid: EPIC_ID3, fingerprint: epicFingerprint(epicDataA), blob: serializeEpicBlob(onDisk) });
  const epicDataB = Buffer.from(`blob-for-alt-${'b'.repeat(60)}`).toString('base64');
  sessions.save({
    accountId: epicB.id,
    launcher: 'epic',
    launcherUid: EPIC_ID2,
    fingerprint: epicFingerprint(epicDataB),
    blob: serializeEpicBlob({
      v: 1,
      rememberMe: { enable: 'True', data: epicDataB },
      offline: { data: Buffer.from('offline-for-alt'.repeat(4)).toString('base64') },
    }),
  });
  epicSim.servers.set(epicDataA, EPIC_ID3);
  epicSim.servers.set(epicDataB, EPIC_ID2);

  const baseDeps = {
    log,
    paths,
    vault,
    vaultHealth: new VaultHealth(db, vault, secrets, log),
    secrets,
    settings,
    accounts,
    library,
    launchers,
    backups,
    launch,
    recovery,
    artwork,
    rescan: () => scanLibrary({ launchers, library, log }),
    pickImage: async () => null,
    pickLauncherExe: async () => null,
    getStartupMetrics: () => ({ processToNodeMs: null, windowShownMs: null, readyToShowMs: null, didFinishLoadMs: null }),
    isTrustedSender: () => true,
    platformSource: 'fake',
  } as unknown as IpcDeps;
  registerIpcHandlers(baseDeps);

  return {
    root,
    paths,
    registry,
    processes,
    epicSim,
    epicIniPath,
    steamLoginUsers,
    accounts,
    library,
    settings,
    backups,
    sessions,
    launchers,
    launch,
    journal,
    recovery,
    opened,
    steamAccountId: steamAccount.id,
    epicAId: epicA.id,
    epicBId: epicB.id,
    epicDataB,
    baseDeps,
    reregister: (overrides) => {
      handlers.clear();
      registerIpcHandlers({ ...baseDeps, ...overrides });
    },
  };
}

async function call<K extends IpcChannel>(channel: K, req?: IpcRequest<K>): Promise<IpcEnvelope<unknown>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return (await fn({ senderFrame: { url: 'file:///x' } }, req)) as IpcEnvelope<unknown>;
}

async function invoke<K extends IpcChannel>(channel: K, req?: IpcRequest<K>): Promise<unknown> {
  const env = await call(channel, req);
  if (!env.ok) throw Object.assign(new Error(env.error.message), { code: env.error.code });
  return env.data;
}

async function untilJob(jobId: string, predicate: (job: LaunchJob) => boolean, timeoutMs = 5_000): Promise<LaunchJob> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { job } = (await invoke('launch:status', { jobId })) as { job: LaunchJob };
    if (predicate(job)) return job;
    if (Date.now() > end) throw new Error(`launch:status predicate not met in time (last state: ${job.state})`);
    await sleep(2);
  }
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(2);
  }
}

const stepStatus = (job: LaunchJob, title: string): string | undefined => job.steps.find((s) => s.title === title)?.status;

let p: Pipeline;

beforeEach(() => {
  p = setup();
});

afterEach(() => {
  rmSync(p.root, { recursive: true, force: true });
});

async function startJob(req: { accountId: string; gameId: string | null; confirmClose: boolean }): Promise<string> {
  const { job } = (await invoke('launch:start', req)) as { job: LaunchJob };
  return job.id;
}

describe('switch/launch pipeline through IPC, real services and adapters, launcher simulators', () => {
  it('1. Full Play (Steam): rescans, switches, launches, records history and a backup, clears the journal', async () => {
    await invoke('library:rescan');
    const game = p.library.list().find((g) => g.launcher === 'steam' && g.launcherGameId === STEAM_APPID)!;
    expect(game).toBeDefined();

    const jobId = await startJob({ accountId: p.steamAccountId, gameId: game.id, confirmClose: true });
    const job = await untilJob(jobId, (j) => j.state !== 'running');

    expect(job.state).toBe('done');
    expect(job.error).toBeNull();
    expect(p.opened).toContain(`steam://rungameid/${STEAM_APPID}`);
    const recent = (await invoke('launch:recent', { limit: 10 })) as { recent: unknown[] };
    expect(recent.recent).toHaveLength(1);
    const list = (await invoke('backups:list', { launcher: 'steam' })) as { snapshots: unknown[] };
    expect(list.snapshots).toHaveLength(1);
    expect(existsSync(p.paths.journalPath)).toBe(false);
  });

  it('2. Rollback (Steam): a failed registry write rolls back to the snapshot and clears the journal', async () => {
    await invoke('library:rescan');
    const game = p.library.list().find((g) => g.launcher === 'steam' && g.launcherGameId === STEAM_APPID)!;
    const original = readFileSync(p.steamLoginUsers);

    p.registry.failNextWrite = 'reg add exploded';
    const jobId = await startJob({ accountId: p.steamAccountId, gameId: game.id, confirmClose: true });
    const job = await untilJob(jobId, (j) => j.state !== 'running');

    expect(job.state).toBe('failed');
    // A mid-switch failure comes back as a result, not a thrown AdapterError, so it carries no "Steam:" prefix.
    expect(job.error).toBe('reg add exploded');
    expect(job.restored).toBe(true);
    expect(readFileSync(p.steamLoginUsers)).toEqual(original);
    expect(await p.registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_1');
    expect(existsSync(p.paths.journalPath)).toBe(false);
  });

  it('3a. Cancel (Epic) while the launcher is closing: nothing changed, no snapshot', async () => {
    p.processes.setRunning(EPIC_EXE, true);
    p.processes.shutdownPolls = 1_000_000;
    const original = readFileSync(p.epicIniPath, 'utf8');

    const jobId = await startJob({ accountId: p.epicBId, gameId: null, confirmClose: true });
    await untilJob(jobId, (j) => stepStatus(j, 'Close Epic Games Launcher') === 'running');
    await invoke('launch:cancel', { jobId });
    const job = await untilJob(jobId, (j) => j.state !== 'running');

    expect(job.state).toBe('cancelled');
    expect(job.restored).toBeNull();
    expect(job.backupId).toBeNull();
    expect(readFileSync(p.epicIniPath, 'utf8')).toBe(original);
    expect(p.backups.list('epic')).toEqual([]);
  });

  it('3b. Cancel (Epic) after the write but before the launcher starts: the file is put back', async () => {
    const original = readFileSync(p.epicIniPath, 'utf8');
    // Gate the process-list re-check the adapter runs after the write and before the start, so an abort
    // there lands at stopIfAborted() and the switch rolls back (restored: true). onProgress is not
    // exposed over IPC, so the gate stands in for the adapter test's abortWhen on the file step.
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((r) => (releaseGate = r));
    let gated = false;
    const baseIsRunning = p.processes.isRunning.bind(p.processes);
    p.processes.isRunning = async (image: string): Promise<boolean> => {
      if (image.toLowerCase() === EPIC_EXE.toLowerCase() && !gated && readFileSync(p.epicIniPath, 'utf8') !== original) {
        gated = true;
        await gate;
      }
      return baseIsRunning(image);
    };

    const jobId = await startJob({ accountId: p.epicBId, gameId: null, confirmClose: false });
    await until(() => gated);
    await invoke('launch:cancel', { jobId });
    releaseGate();
    const job = await untilJob(jobId, (j) => j.state !== 'running');

    expect(job.state).toBe('cancelled');
    expect(job.restored).toBe(true);
    expect(readFileSync(p.epicIniPath, 'utf8')).toBe(original);
    expect(existsSync(p.paths.journalPath)).toBe(false);
  });

  it('3c. Cancel (Epic) after the launcher started: the writes stand, nothing rolled back', async () => {
    p.epicSim.knobs.expired.push(p.epicDataB);

    const jobId = await startJob({ accountId: p.epicBId, gameId: null, confirmClose: false });
    await untilJob(jobId, (j) => j.attention !== null);
    await invoke('launch:cancel', { jobId });
    const job = await untilJob(jobId, (j) => j.state !== 'running');

    expect(job.state).toBe('cancelled');
    expect(job.restored).toBeNull();
    expect(readSessionFromIni(readFileSync(p.epicIniPath, 'utf8')).data).toBe(p.epicDataB);
  });

  it('4. Crash recovery (Epic): a fresh journal offers the interrupted switch, and restore puts the file back', async () => {
    const original = readFileSync(p.epicIniPath, 'utf8');
    // The switch hangs where the last process would have died: the launcher start never returns, so the
    // job stays running with a journal on disk that names the snapshot and a post-close step.
    const baseStart = p.processes.start.bind(p.processes);
    p.processes.start = (exe: string, args: readonly string[]): Promise<void> =>
      /epicgameslauncher\.exe$/i.test(exe) ? new Promise<void>(() => undefined) : baseStart(exe, args);

    await startJob({ accountId: p.epicBId, gameId: null, confirmClose: false });
    await until(() => {
      if (!existsSync(p.paths.journalPath)) return false;
      const entry = JSON.parse(readFileSync(p.paths.journalPath, 'utf8')) as { backupId: string | null; stepId: string | null };
      return entry.backupId !== null && entry.stepId === 'start';
    });
    const onDisk = JSON.parse(readFileSync(p.paths.journalPath, 'utf8')) as { backupId: string | null };
    expect(onDisk.backupId).not.toBeNull();

    // A fresh run: a new journal and recovery service on the same file, and a fresh idle IPC set.
    const freshLog = createLogger('test:pipeline:recovery');
    const freshJournal = new SwitchJournal(p.paths.journalPath, freshLog);
    const freshRecovery = new SwitchRecoveryService({ journal: freshJournal, accounts: p.accounts, backups: p.backups, launchers: p.launchers, log: freshLog });
    freshRecovery.load();
    const freshDb = openDatabase(':memory:');
    migrate(freshDb);
    const freshLaunch = new LaunchService(freshDb, { launchers: p.launchers, accounts: p.accounts, library: p.library, settings: p.settings, log: freshLog });
    p.reregister({ recovery: freshRecovery, launch: freshLaunch });

    const pending = (await invoke('recovery:get')) as { recovery: { phase: string; snapshotAvailable: boolean } | null };
    expect(pending.recovery).toMatchObject({ phase: 'signing-in', snapshotAvailable: true });

    // The hung switch never started the launcher, so it is closeable; the restore puts the file back.
    const restored = (await invoke('recovery:restore')) as { result: { files: string[] } };
    expect(restored.result.files).toContain(p.epicIniPath);
    expect(readFileSync(p.epicIniPath, 'utf8')).toBe(original);
    expect((await invoke('recovery:get')) as { recovery: unknown }).toEqual({ recovery: null });
    expect(existsSync(p.paths.journalPath)).toBe(false);
  });

  it('4b. Crash recovery (Epic): dismiss just deletes the journal', async () => {
    const freshLog = createLogger('test:pipeline:dismiss');
    const journal = new SwitchJournal(p.paths.journalPath, freshLog);
    journal.begin({ jobId: randomUUID(), launcher: 'epic', accountId: p.epicBId });
    journal.update({ backupId: '2026-09-24T00-00-00.000Z' });
    journal.update({ stepId: 'file' });
    expect(existsSync(p.paths.journalPath)).toBe(true);

    const recovery = new SwitchRecoveryService({ journal, accounts: p.accounts, backups: p.backups, launchers: p.launchers, log: freshLog });
    recovery.load();
    p.reregister({ recovery });

    const pending = (await invoke('recovery:get')) as { recovery: unknown };
    expect(pending.recovery).not.toBeNull();
    await invoke('recovery:dismiss');
    expect((await invoke('recovery:get')) as { recovery: unknown }).toEqual({ recovery: null });
    expect(existsSync(p.paths.journalPath)).toBe(false);
  });

  it('5. Restore from backups (Steam): the snapshot puts loginusers.vdf and AutoLoginUser back', async () => {
    await invoke('library:rescan');
    const game = p.library.list().find((g) => g.launcher === 'steam' && g.launcherGameId === STEAM_APPID)!;
    const original = readFileSync(p.steamLoginUsers);

    const jobId = await startJob({ accountId: p.steamAccountId, gameId: game.id, confirmClose: true });
    const job = await untilJob(jobId, (j) => j.state !== 'running');
    expect(job.state).toBe('done');
    expect(readFileSync(p.steamLoginUsers)).not.toEqual(original);
    expect(await p.registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_3');

    const [snapshot] = ((await invoke('backups:list', { launcher: 'steam' })) as { snapshots: { id: string }[] }).snapshots;
    p.processes.setRunning('steam.exe', false);
    const result = (await invoke('backups:restore', { launcher: 'steam', id: snapshot!.id })) as { result: { files: string[] } };
    // detectInstall normalizes the install path to lower case, so compare the restored path that way.
    expect(result.result.files.map((f) => f.toLowerCase())).toContain(p.steamLoginUsers.toLowerCase());
    expect(readFileSync(p.steamLoginUsers)).toEqual(original);
    expect(await p.registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_1');
  });
});
