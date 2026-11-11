import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { SaltedFakeVault } from './vault';
import { appVersion, collectHandlers, type IpcHandlerFn } from './electron-mock';
import { clearTimers, newTimerSet, ownTimers, type TimerSet } from './timers';

export type TraceEvent = { seq: number; k: string } & Record<string, unknown>;

export interface StartOptions {
  launchersDir: string;
  dataDir: string;
  /** Where a dead instance's log lines go, so nothing it still says can reach the data folder. */
  graveyard: string;
  record: (event: TraceEvent) => void;
  /** Handed the bytes of each atomic write just before its event is recorded. */
  onWrite?: (data: Buffer | string) => void;
}

export interface RegistryValue {
  path: string;
  type: string;
  data: string;
}

export interface App {
  readonly alive: boolean;
  invoke(channel: string, req?: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  /** The startup scan, the database copy and the artwork queue have finished. */
  settled(): Promise<void>;
  /** No adapter call and no artwork job is running. */
  quiet(): Promise<void>;
  accounts(): { id: string; launcher: string; login: string }[];
  games(): { id: string; launcher: string; launcherGameId: string }[];
  registry(): RegistryValue[];
  vault: SaltedFakeVault;
  /** The quit path of src/main/index.ts: stop a running switch, the cleanup, the database closed. */
  quit(): Promise<void>;
  /** The end of the process with nothing run: every timer gone, the files as they are. */
  crash(): void;
}

const QUIT_WAIT_MS = 10_000;
const LAUNCHER_IDLE_AT_QUIT_MS = 1_500;
const DB_COPIES_TO_KEEP = 5;

/**
 * One start of the app, wired in the order of src/main/index.ts with `electron` mocked, the fake vault, and the fake
 * platform of the scenario folder. Each start loads the app's modules afresh, as a new process would.
 */
export async function startApp(opts: StartOptions): Promise<App> {
  vi.resetModules();
  const handlers = new Map<string, IpcHandlerFn>();
  const timers: TimerSet = newTimerSet();
  ownTimers(timers);

  const [
    models,
    dbMod,
    ipcMod,
    backupMod,
    loggerMod,
    wiringMod,
    loginItemMod,
    steamMod,
    epicMod,
    battlenetMod,
    riotMod,
    accountsMod,
    artworkMod,
    clipboardMod,
    launchMod,
    launchersMod,
    libraryMod,
    scanMod,
    secretsMod,
    sessionsMod,
    settingsMod,
    journalMod,
    whatsNewMod,
    vaultHealthMod,
    availabilityMod,
    releaseKeysMod,
    updateMod,
  ] = await Promise.all([
    import('../../../../src/shared/models'),
    import('../../../../src/main/db/index'),
    import('../../../../src/main/ipc/index'),
    import('../../../../src/main/services/backup'),
    import('../../../../src/main/services/logger'),
    import('../../../../src/main/platform/wiring'),
    import('../../../../src/main/platform/login-item'),
    import('../../../../src/main/launchers/steam/adapter'),
    import('../../../../src/main/launchers/epic/adapter'),
    import('../../../../src/main/launchers/battlenet/adapter'),
    import('../../../../src/main/launchers/riot/adapter'),
    import('../../../../src/main/services/accounts'),
    import('../../../../src/main/services/artwork'),
    import('../../../../src/main/services/clipboard'),
    import('../../../../src/main/services/launch'),
    import('../../../../src/main/services/launchers'),
    import('../../../../src/main/services/library'),
    import('../../../../src/main/services/library-scan'),
    import('../../../../src/main/services/secrets'),
    import('../../../../src/main/services/sessions'),
    import('../../../../src/main/services/settings'),
    import('../../../../src/main/services/switch-journal'),
    import('../../../../src/main/services/whats-new'),
    import('../../../../src/main/services/vault-health'),
    import('../../../../src/main/updates/availability'),
    import('../../../../src/main/updates/release-keys'),
    import('../../../../src/main/updates/update-service'),
  ]);
  const { isBattlenetLaunchForm, isEpicLaunchUriForm, isLogLevel, LAUNCHER_PATH_SETTINGS } = models;

  const fakeLaunchersDir = wiringMod.resolveFakeLaunchersDir({ [wiringMod.FAKE_LAUNCHERS_ENV]: opts.launchersDir }, false);
  const dataDirSource = 'flag' as const;
  const paths = {
    dataDir: opts.dataDir,
    dbPath: join(opts.dataDir, 'onelaunch.db'),
    artworkDir: join(opts.dataDir, 'artwork'),
    backupsDir: join(opts.dataDir, 'backups'),
    logsDir: join(opts.dataDir, 'logs'),
    journalPath: join(opts.dataDir, 'switch.json'),
  };
  for (const dir of [paths.dataDir, paths.artworkDir, paths.backupsDir, paths.logsDir]) mkdirSync(dir, { recursive: true });
  loggerMod.initLogging({ dir: paths.logsDir, level: 'info', console: false });
  const log = loggerMod.createLogger('main');
  log.info('starting', { version: appVersion(), electron: null, dev: false, dataDir: paths.dataDir, dataDirSource, platformSource: 'fake' });

  const db = dbMod.openDatabase(paths.dbPath);
  const migration = dbMod.migrate(db);
  if (migration.applied.length > 0) log.info('database migrated', { from: migration.from, to: migration.to, applied: migration.applied });

  const settings = new settingsMod.SettingsService(db);
  whatsNewMod.seedWhatsNewSeen(settings, migration.from === 0, appVersion());
  const configuredLevel = settings.get('logLevel');
  if (isLogLevel(configuredLevel)) loggerMod.setLogLevel(configuredLevel);

  const install = (registry: { getString: (hive: 'HKCU', key: string, name: string) => Promise<string | null> }) => ({
    isPackaged: false,
    dataDirSource,
    execPath: process.execPath,
    fileExists: existsSync,
    perUserInstallLocation: () => registry.getString('HKCU', availabilityMod.INSTALL_REGISTRY_KEY, 'InstallLocation'),
  });
  const platform = await wiringMod.createPlatform({
    fakeDir: fakeLaunchersDir,
    dataDir: paths.dataDir,
    log: log.child('platform'),
    openExternal: async () => {
      throw new Error('the fake platform opens nothing outside itself');
    },
    loginItem: { available: (registry) => loginItemMod.loginItemAvailable(install(registry)), execPath: process.execPath, app: {} as never },
  });
  const report = (
    platform as typeof platform & {
      report: { onEvent: ((event: TraceEvent) => void) | null; fileWrite: (path: string, data: Buffer | string) => void; job: (job: never) => void };
    }
  ).report;
  report.onEvent = opts.record;
  backupMod.atomicWrites.observer = (path, data) => {
    opts.onWrite?.(data);
    report.fileWrite(path, data);
  };

  const vault = new SaltedFakeVault();
  const secrets = new secretsMod.SecretStore(db, vault);
  const vaultHealth = new vaultHealthMod.VaultHealth(db, vault, secrets, log.child('vault'));
  vaultHealth.ensureProbe();
  log.info('vault', vaultHealth.status());
  const accounts = new accountsMod.AccountsService(db, vault);
  const clipboardService = new clipboardMod.ClipboardService(
    platform.clipboard!.clipboard,
    clipboardMod.DEFAULT_CLIPBOARD_CLEAR_MS,
    platform.clipboard!.writePrivately,
    (reason) => log.warn('clipboard history exclusion unavailable; copied with the plain clipboard', { reason }),
  );
  const library = new libraryMod.LibraryService(db);

  const backupsToKeep = (): number => settings.getInt('backups.keep', backupMod.DEFAULT_BACKUPS_TO_KEEP);
  const backups = new backupMod.BackupService(paths.backupsDir, { keep: backupsToKeep, log: log.child('backup'), vault });
  const steam = new steamMod.SteamAdapter({
    registry: platform.registry,
    processes: platform.processes,
    backups,
    log: log.child('steam'),
    backupsToKeep,
    openExternal: platform.openExternal,
    autoLogin: () => settings.getBool('steam.autoLogin', false),
    installDir: () => settings.get(LAUNCHER_PATH_SETTINGS.steam),
    ...platform.roots.steam,
    timing: platform.timing.steam,
  });
  const sessions = new sessionsMod.LauncherSessionStore(db, vault);
  platform.seed?.({ accounts, sessions, settings });
  const epic = new epicMod.EpicAdapter({
    registry: platform.registry,
    processes: platform.processes,
    backups,
    sessions,
    accounts: launchersMod.accountDirectory(accounts, 'epic'),
    log: log.child('epic'),
    backupsToKeep,
    openExternal: platform.openExternal,
    launchUriForm: () => {
      const v = settings.get('epic.launchUri');
      return isEpicLaunchUriForm(v) ? v : 'catalog';
    },
    installDir: () => settings.get(LAUNCHER_PATH_SETTINGS.epic),
    ...platform.roots.epic,
    timing: platform.timing.epic,
  });
  const battlenet = new battlenetMod.BattlenetAdapter({
    registry: platform.registry,
    processes: platform.processes,
    backups,
    sessions,
    accounts: launchersMod.accountDirectory(accounts, 'battlenet'),
    vault,
    log: log.child('battlenet'),
    backupsToKeep,
    openExternal: platform.openExternal,
    launchForm: () => {
      const v = settings.get('battlenet.launch');
      return isBattlenetLaunchForm(v) ? v : 'exec';
    },
    installDir: () => settings.get(LAUNCHER_PATH_SETTINGS.battlenet),
    ...platform.roots.battlenet,
    timing: platform.timing.battlenet,
  });
  const riot = new riotMod.RiotAdapter({
    registry: platform.registry,
    processes: platform.processes,
    backups,
    sessions,
    accounts: launchersMod.accountDirectory(accounts, 'riot'),
    log: log.child('riot'),
    backupsToKeep,
    installDir: () => settings.get(LAUNCHER_PATH_SETTINGS.riot),
    pressPlay: () => settings.getBool('riot.pressPlay', true),
    localLaunch: platform.riotLocalLaunch,
    ...platform.roots.riot,
    timing: platform.timing.riot,
  });
  const launchers = new launchersMod.LauncherService([steam, epic, battlenet, riot], accounts, log.child('launchers'), sessions);
  const journal = new journalMod.SwitchJournal(paths.journalPath, log.child('journal'));
  const recovery = new journalMod.SwitchRecoveryService({ journal, accounts, backups, launchers, log: log.child('recovery') });
  recovery.load();
  const launch = new launchMod.LaunchService(db, {
    launchers,
    accounts,
    library,
    settings,
    log: log.child('launch'),
    journal,
    trace: report.job.bind(report) as never,
  });
  const artwork = new artworkMod.ArtworkService(db, {
    dir: paths.artworkDir,
    fetch: platform.fetch,
    apiKey: () => secrets.get('steamgriddb.apiKey'),
    hasApiKey: () => secrets.has('steamgriddb.apiKey'),
    autoFetch: () => settings.getBool('artwork.autoFetch', true),
    launcherIcon: (game) => launchers.gameIcon(game.launcher, game),
    library,
    log: log.child('artwork'),
  });
  const updateService = new updateMod.UpdateService({
    availability: () => availabilityMod.updateAvailability({ testFeed: false, ...install(platform.registry) }),
    engine: async () => {
      throw new Error('the replay harness has no update engine; updates are ticket T06');
    },
    keys: releaseKeysMod.RELEASE_KEYS,
    auto: settings.getBool('updates.auto', true),
    quit: () => undefined,
    log: log.child('updates'),
  });

  const cleanup = async (): Promise<void> => {
    updateService.stop();
    artwork.stop();
    launchers.closing();
    if (!(await launchers.whenIdle(LAUNCHER_IDLE_AT_QUIT_MS))) log.warn('launcher work still running at quit');
    const cleared = await clipboardService.clearIfUnchanged();
    if (cleared) log.info('cleared a copied value from the clipboard at quit');
  };

  const rescan = async () => {
    const scanned = await scanMod.scanLibrary({ launchers, library, log: log.child('scan') });
    artwork.prune();
    const queued = artwork.enqueueAfterScan();
    if (queued > 0) log.info('artwork queued', { queued });
    return scanned;
  };

  collectHandlers(handlers);
  ipcMod.registerIpcHandlers({
    log,
    paths,
    vault,
    vaultHealth,
    secrets,
    settings,
    accounts,
    clipboard: clipboardService,
    library,
    launchers,
    backups,
    launch,
    recovery,
    artwork,
    updates: updateService,
    loginItem: platform.loginItem,
    rescan,
    pickImage: async () => null,
    pickLauncherExe: async () => null,
    getStartupMetrics: () => ({ processToNodeMs: null, windowShownMs: null, readyToShowMs: null, didFinishLoadMs: null }),
    isTrustedSender: () => true,
    platformSource: platform.source,
    onSettingChanged: (key, value) => {
      if (key === 'updates.auto') updateService.setAuto(value === 'true');
    },
  });
  collectHandlers(null);

  // What index.ts starts once the window is up: the library scan, the database copy, the updater.
  const startup = Promise.all([
    rescan().catch((err: unknown) => log.warn('startup library scan failed', { error: err })),
    dbMod
      .backupDatabase(db, join(paths.backupsDir, 'db'), DB_COPIES_TO_KEEP)
      .then((dest) => log.info('database copied', { dest }))
      .catch((err: unknown) => log.warn('database copy failed', { error: err })),
    updateService.start().catch((err: unknown) => log.warn('updater did not start', { error: err })),
  ]);

  let alive = true;
  const end = (): void => {
    alive = false;
    report.onEvent = null;
    backupMod.atomicWrites.observer = null;
    clearTimers(timers);
    ownTimers(null);
    loggerMod.initLogging({ dir: opts.graveyard, level: 'error', console: false });
  };

  const stopRunningSwitch = async (reason: string): Promise<void> => {
    if (!launch.isBusy()) return;
    log.warn('stopping the running switch', { reason });
    launch.stop();
    const finished = await launch.whenIdle(QUIT_WAIT_MS);
    if (!finished) log.warn('switch still running at quit', { reason });
  };

  const quiet = async (): Promise<void> => {
    await startup;
    for (;;) {
      await artwork.idle();
      if (await launchers.whenIdle(60_000)) return;
    }
  };

  return {
    get alive() {
      return alive;
    },
    vault,
    invoke: async (channel, req) => {
      if (!alive) throw new Error(`${channel}: the app is not running`);
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return (await fn({ senderFrame: { url: 'file:///replay' } }, req)) as never;
    },
    settled: quiet,
    quiet,
    accounts: () => accounts.list().map((a) => ({ id: a.id, launcher: a.launcher, login: a.login })),
    games: () => library.list().map((g) => ({ id: g.id, launcher: g.launcher, launcherGameId: g.launcherGameId })),
    registry: () =>
      [...(platform.registry as unknown as { values: Map<string, RegistryValue> }).values.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, entry]) => ({ path: entry.path, type: entry.type, data: entry.data })),
    quit: async () => {
      if (!alive) return;
      await stopRunningSwitch('quit')
        .then(() => Promise.race([cleanup(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]))
        .catch((err: unknown) => log.warn('quit cleanup failed', { error: err }));
      try {
        db.close();
      } catch (err) {
        log.warn('error closing database', err);
      }
      log.info('exit');
      end();
    },
    crash: () => {
      if (!alive) return;
      end();
      try {
        db.close();
      } catch {
        // the handle goes with the process either way
      }
    },
  };
}
