import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  net,
  protocol,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type Rectangle,
  type Tray,
} from 'electron';
import appIconPath from '../../build/icon.png?asset';
import {
  isBattlenetLaunchForm,
  isEpicLaunchUriForm,
  isLogLevel,
  LAUNCHER_DISPLAY_NAMES,
  LAUNCHER_EXE_NAMES,
  LAUNCHER_PATH_SETTINGS,
  type LauncherId,
  type LibraryScanResult,
  type StartupMetrics,
} from '@shared/models';
import { backupDatabase, migrate, openDatabase, type Db } from './db';
import { registerIpcHandlers } from './ipc';
import { BattlenetAdapter } from './launchers/battlenet/adapter';
import { EpicAdapter } from './launchers/epic/adapter';
import { RiotAdapter } from './launchers/riot/adapter';
import { SteamAdapter } from './launchers/steam/adapter';
import { configureAppPaths, ensureAppDirs, getAppPaths, type DataDirSource } from './platform/paths';
import { createPlatform, resolveFakeLaunchersDir } from './platform/wiring';
import { AccountsService } from './services/accounts';
import { ArtworkService } from './services/artwork';
import { ARTWORK_SCHEME, resolveArtworkPath } from './services/artwork-url';
import { BackupService, DEFAULT_BACKUPS_TO_KEEP } from './services/backup';
import { writeClipboardPrivately } from './platform/clipboard-private';
import { ClipboardService, DEFAULT_CLIPBOARD_CLEAR_MS } from './services/clipboard';
import { LaunchService } from './services/launch';
import { accountDirectory, LauncherService } from './services/launchers';
import { LibraryService } from './services/library';
import { scanLibrary } from './services/library-scan';
import { createLogger, initLogging, setLogLevel } from './services/logger';
import { SecretStore } from './services/secrets';
import { LauncherSessionStore } from './services/sessions';
import { SettingsService } from './services/settings';
import { SwitchJournal, SwitchRecoveryService } from './services/switch-journal';
import { seedWhatsNewSeen } from './services/whats-new';
import { SafeStorageVault } from './services/vault';
import { VaultHealth } from './services/vault-health';
import { createTray } from './tray';
import { INSTALL_REGISTRY_KEY, updateAvailability } from './updates/availability';
import { RELEASE_KEYS } from './updates/release-keys';
import { resolveUpdateTestFeed, type UpdateTestFeed } from './updates/test-feed';
import { UpdateService } from './updates/update-service';
import { closeRequestAction, isTrustedRendererUrl, placementFrom } from './window-guard';

// The first statement of the module body runs once every static import above has been evaluated.
const moduleLoadedAt = Date.now();

// ---------------------------------------------------------------------------
// Process-level setup. Everything here runs before 'ready'.
// ---------------------------------------------------------------------------

const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
const isDev = !app.isPackaged && Boolean(rendererDevUrl);

let dataDirSource: DataDirSource = 'default';
let fakeLaunchersDir: string | null = null;
let updateTestFeed: UpdateTestFeed | null = null;
try {
  dataDirSource = configureAppPaths();
  fakeLaunchersDir = resolveFakeLaunchersDir(process.env, app.isPackaged);
  updateTestFeed = resolveUpdateTestFeed(process.env, app.isPackaged);
} catch (err) {
  // Before 'ready' app.exit() ends the process on the spot, so a bad --data-dir never reaches the real data folder.
  process.stderr.write(`One Launch: ${err instanceof Error ? err.message : String(err)}\n`);
  app.exit(2);
}
app.setAppUserModelId('dev.onelaunch.app');

// A second instance hands over to the first (see 'second-instance' below) and leaves at once, before
// it opens the log, the database, or a window of its own.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// Cached artwork reaches the renderer through this scheme only (spec section 9). Must run before 'ready'.
protocol.registerSchemesAsPrivileged([{ scheme: ARTWORK_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);

const paths = getAppPaths();
ensureAppDirs(paths);
initLogging({ dir: paths.logsDir, level: isDev ? 'debug' : 'info', console: isDev });
const log = createLogger('main');

// process.uptime() only starts once Node runs inside the process; the user's wait starts at the process's creation.
const processCreatedAt = process.getCreationTime();
const nodeStartedAt = Date.now() - process.uptime() * 1000;
const moduleLoadedMs = processCreatedAt === null ? null : Math.round(moduleLoadedAt - processCreatedAt);
const startup: StartupMetrics = {
  processToNodeMs: processCreatedAt === null ? null : Math.round(nodeStartedAt - processCreatedAt),
  windowShownMs: null,
  readyToShowMs: null,
  didFinishLoadMs: null,
};
const phases: { ready?: number; db?: number; vault?: number; ipc?: number; windowCreated?: number } = {};
const DB_COPIES_TO_KEEP = 5;
const sinceStart = (): number => Math.round(processCreatedAt === null ? process.uptime() * 1000 : Date.now() - processCreatedAt);

let mainWindow: BrowserWindow | null = null;
let db: Db | null = null;
let launch: LaunchService | null = null;
let updates: UpdateService | null = null;
/** The notification-area icon; present while the close-to-tray setting is on and the icon could be created. */
let tray: Tray | null = null;
/** The window.closeToTray setting, read at close time. Set by bootstrap. */
let closeToTray: () => boolean = () => false;
/** True from app.quit() on: closes are real closes, not a hide to the tray. Reset if the quit prompt keeps the app running. */
let quitting = false;
/** Set once the user has chosen to quit during a running switch, so the next close goes through. */
let quitConfirmed = false;
let quitPromptOpen = false;
/** A fake-launcher scenario can answer the quit-during-switch prompt, which cannot be driven over CDP. */
let quitDuringSwitchAnswer: 'keep' | 'quit' | null = null;
/** Clears a copied password and stops background work. Set by bootstrap, run once from 'before-quit'. */
let quitCleanup: (() => Promise<void>) | null = null;
let quitCleanupDone = false;
/** Every wait in a switch ends within one poll of an abort; the rest of the budget covers a restore of files written before the launcher restart. */
const QUIT_WAIT_MS = 10_000;
/** A status pass or a library scan may still be reading the launchers when the window closes; the database closes at will-quit, so they get this long to finish. */
const LAUNCHER_IDLE_AT_QUIT_MS = 1_500;

/** Aborts the running switch and waits for it to wind down. A switch that outlives the wait leaves its journal for the next start. */
async function stopRunningSwitch(reason: string): Promise<void> {
  if (!launch?.isBusy()) return;
  log.warn('stopping the running switch', { reason });
  launch.stop();
  const finished = await launch.whenIdle(QUIT_WAIT_MS);
  if (!finished) log.warn('switch still running at quit', { reason });
}

/** Brings the window back from the tray, from minimized, or from behind other windows. */
function showMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/** Creates or removes the tray icon. A failure to create it is logged, and closing the window then quits as if the setting were off. */
function setTrayEnabled(on: boolean, tooltip: string): void {
  if (on === (tray !== null)) return;
  if (!on) {
    tray?.destroy();
    tray = null;
    return;
  }
  try {
    tray = createTray({
      iconPath: appIconPath,
      scaleFactor: screen.getPrimaryDisplay().scaleFactor,
      tooltip,
      onOpen: showMainWindow,
      onQuit: () => app.quit(),
    });
  } catch (err) {
    log.warn('tray icon unavailable; closing the window quits', { error: err });
  }
}

/**
 * A switch in progress writes launcher files and waits on the launcher. Ask first; on "Quit anyway"
 * abort the job and give the adapter time to stop or put its writes back before the window goes.
 */
async function confirmQuitDuringSwitch(win: BrowserWindow): Promise<void> {
  const job = launch?.currentJob();
  if (!job) {
    await stopRunningSwitch('quit while a switch was starting');
    quitConfirmed = true;
    win.close();
    return;
  }
  if (quitPromptOpen) return;
  quitPromptOpen = true;
  try {
    const launcherName = LAUNCHER_DISPLAY_NAMES[job.launcher];
    let response = 0;
    if (quitDuringSwitchAnswer) {
      log.info('quit prompt answered by the fake scenario', { answer: quitDuringSwitchAnswer });
      response = quitDuringSwitchAnswer === 'quit' ? 1 : 0;
    } else {
      // A quit from the tray reaches here with the window hidden; a prompt owned by a hidden window cannot be seen.
      showMainWindow();
      ({ response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'A switch is still running',
        message: `One Launch is still switching to ${job.account.displayName}.`,
        detail: `Quitting stops the switch. If ${launcherName} has not been started again yet, its files are put back first; after that ${launcherName} carries on signing in on its own. Left alone, the switch finishes once the launcher reports the sign-in.`,
        buttons: ['Keep running', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }));
    }
    if (response !== 1) return;
    await stopRunningSwitch('quit confirmed during a switch');
    quitConfirmed = true;
    win.close();
  } finally {
    quitPromptOpen = false;
  }
}

// ---------------------------------------------------------------------------
// Hardening: no navigation away from our renderer, no popups, no webviews.
// ---------------------------------------------------------------------------

const rendererFileUrl = pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).toString();

function isTrustedUrl(url: string | undefined): boolean {
  return isTrustedRendererUrl(url, { rendererFileUrl, devUrl: isDev && rendererDevUrl ? rendererDevUrl : null });
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return isTrustedUrl(event.senderFrame?.url);
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) {
      log.warn('blocked navigation', { url });
      event.preventDefault();
    }
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    log.warn('blocked window.open', { url });
    return { action: 'deny' };
  });
});

// ---------------------------------------------------------------------------
// Window.
// ---------------------------------------------------------------------------

/** The last window placement, when it still lands on a connected display. */
function savedBounds(settings: SettingsService): { bounds: Rectangle | null; maximized: boolean } {
  return placementFrom(
    settings.get('window.bounds'),
    screen.getAllDisplays().map((d) => d.workArea),
  );
}

function rememberBounds(win: BrowserWindow, settings: SettingsService): void {
  let timer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.isMaximized() ? (win.getNormalBounds?.() ?? win.getBounds()) : win.getBounds();
    settings.set('window.bounds', JSON.stringify({ ...b, maximized: win.isMaximized() }));
  };
  const later = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on('resize', later);
  win.on('move', later);
  win.on('maximize', later);
  win.on('unmaximize', later);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    timer = null;
    save();
  });
}

function createMainWindow(settings: SettingsService, title: string): BrowserWindow {
  const placement = savedBounds(settings);
  const win = new BrowserWindow({
    width: placement.bounds?.width ?? 1280,
    height: placement.bounds?.height ?? 800,
    ...(placement.bounds ? { x: placement.bounds.x, y: placement.bounds.y } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    title,
    // Packaged builds take the icon from the exe; in dev, point at the build resource so the taskbar shows it too.
    ...(app.isPackaged ? {} : { icon: appIconPath }),
    // The renderer draws the title bar; Windows keeps drawing the caption buttons (snap layouts, hover states) in our colours.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#12151c', symbolColor: '#8f97ab', height: 35 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isDev,
    },
  });
  phases.windowCreated = sinceStart();

  // Shown before the page loads: the window is on screen at once, in its background colour, and the renderer's first frame is already at the final size and state.
  if (placement.maximized) win.maximize();
  win.show();
  startup.windowShownMs = sinceStart();
  rememberBounds(win, settings);

  // One line with every mark, once both the first paint and the bundle load have been timed, in whichever order they come.
  const logStartup = (): void => {
    if (startup.readyToShowMs === null || startup.didFinishLoadMs === null) return;
    log.info('startup', {
      creationEpochMs: processCreatedAt === null ? null : Math.round(processCreatedAt),
      processToNodeMs: startup.processToNodeMs,
      moduleLoadedMs,
      readyMs: phases.ready,
      dbMs: phases.db,
      vaultMs: phases.vault,
      ipcMs: phases.ipc,
      windowCreatedMs: phases.windowCreated,
      windowShownMs: startup.windowShownMs,
      readyToShowMs: startup.readyToShowMs,
      didFinishLoadMs: startup.didFinishLoadMs,
    });
  };

  win.once('ready-to-show', () => {
    startup.readyToShowMs = sinceStart();
    logStartup();
  });

  win.webContents.once('did-finish-load', () => {
    startup.didFinishLoadMs = sinceStart();
    logStartup();
  });

  // A crashed or killed renderer comes back on its own once; a second loss within a minute stays down so a crash loop cannot spin.
  let lastRendererLossAt = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('renderer process gone', { reason: details.reason, exitCode: details.exitCode });
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    if (Date.now() - lastRendererLossAt < 60_000) return;
    lastRendererLossAt = Date.now();
    win.webContents.reload();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12') win.webContents.toggleDevTools();
      if (input.control && input.key.toLowerCase() === 'r') win.webContents.reload();
    });
  }

  win.on('close', (event) => {
    const action = closeRequestAction({
      quitting: quitting || quitConfirmed,
      closeToTray: tray !== null && closeToTray(),
      switchBusy: launch?.isBusy() ?? false,
    });
    if (action === 'close') return;
    event.preventDefault();
    if (action === 'hide') {
      win.hide();
      log.info('window hidden to the tray');
      return;
    }
    void confirmQuitDuringSwitch(win);
  });

  // Logoff or shutdown: Windows will not wait for a prompt, so abort the switch at once and clear a copied password.
  win.on('session-end', () => {
    quitConfirmed = true;
    updates?.onSessionEnd();
    launch?.stop();
    void quitCleanup?.();
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  if (isDev && rendererDevUrl) {
    void win.loadURL(rendererDevUrl);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

// ---------------------------------------------------------------------------
// Startup.
// ---------------------------------------------------------------------------

function bootstrap(): void {
  phases.ready = sinceStart();
  log.info('starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    dev: isDev,
    dataDir: paths.dataDir,
    dataDirSource,
    platformSource: fakeLaunchersDir ? 'fake' : 'real',
  });

  db = openDatabase(paths.dbPath);
  const migration = migrate(db);
  phases.db = sinceStart();
  if (migration.applied.length > 0) {
    log.info('database migrated', { from: migration.from, to: migration.to, applied: migration.applied });
  }

  const settings = new SettingsService(db);
  seedWhatsNewSeen(settings, migration.from === 0, app.getVersion());
  const configuredLevel = settings.get('logLevel');
  if (!isDev && isLogLevel(configuredLevel)) setLogLevel(configuredLevel);
  closeToTray = () => settings.getBool('window.closeToTray', true);

  const vault = new SafeStorageVault();
  const secrets = new SecretStore(db, vault);
  const vaultHealth = new VaultHealth(db, vault, secrets, log.child('vault'));
  vaultHealth.ensureProbe();
  const vaultStatus = vaultHealth.status();
  phases.vault = sinceStart();
  log.info('vault', vaultStatus);
  if (!vaultStatus.available) log.warn('secure storage unavailable; secrets cannot be stored on this system');
  if (vaultStatus.readable === false) log.error('stored secrets cannot be decrypted; the vault key was lost or belongs to another Windows user');
  const accounts = new AccountsService(db, vault);
  const platform = createPlatform({
    fakeDir: fakeLaunchersDir,
    dataDir: paths.dataDir,
    log: log.child('platform'),
    openExternal: (url) => shell.openExternal(url),
  });
  const clipboardService = new ClipboardService(
    platform.clipboard?.clipboard ?? clipboard,
    DEFAULT_CLIPBOARD_CLEAR_MS,
    platform.clipboard?.writePrivately ?? writeClipboardPrivately,
    (reason) => log.warn('clipboard history exclusion unavailable; copied with the plain clipboard', { reason }),
  );
  const library = new LibraryService(db);

  // Launcher adapters. The only writes to launcher files or registry keys happen inside
  // switchAccount({ dryRun: false }) and restoreBackup, reachable only through LaunchService
  // (dry-run setting + confirmation) and the Settings restore button.
  const backupsToKeep = (): number => settings.getInt('backups.keep', DEFAULT_BACKUPS_TO_KEEP);
  const backups = new BackupService(paths.backupsDir, { keep: backupsToKeep, log: log.child('backup'), vault });
  const steam = new SteamAdapter({
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
  // Epic and Battle.net sign in from a remembered-session blob; the snapshots live vault-encrypted
  // in launcher_sessions. Each adapter links accounts through its launcher's own account id.
  const sessions = new LauncherSessionStore(db, vault);
  platform.seed?.({ accounts, sessions, settings });
  quitDuringSwitchAnswer = platform.quitDuringSwitch ?? null;
  const epic = new EpicAdapter({
    registry: platform.registry,
    processes: platform.processes,
    backups,
    sessions,
    accounts: accountDirectory(accounts, 'epic'),
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
  const battlenet = new BattlenetAdapter({
    registry: platform.registry,
    processes: platform.processes,
    backups,
    sessions,
    accounts: accountDirectory(accounts, 'battlenet'),
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
  // Riot swaps the client's one session file between the accounts' saved copies, refuses while a Riot game
  // runs, and never touches a game or Vanguard (docs/adapters/riot.md).
  const riot = new RiotAdapter({
    registry: platform.registry,
    processes: platform.processes,
    backups,
    sessions,
    accounts: accountDirectory(accounts, 'riot'),
    log: log.child('riot'),
    backupsToKeep,
    installDir: () => settings.get(LAUNCHER_PATH_SETTINGS.riot),
    pressPlay: () => settings.getBool('riot.pressPlay', true),
    localLaunch: platform.riotLocalLaunch,
    ...platform.roots.riot,
    timing: platform.timing.riot,
  });
  const launchers = new LauncherService([steam, epic, battlenet, riot], accounts, log.child('launchers'), sessions);
  const journal = new SwitchJournal(paths.journalPath, log.child('journal'));
  // Read what the last run left behind before anything in this run can start a switch and overwrite it.
  const recovery = new SwitchRecoveryService({ journal, accounts, backups, launchers, log: log.child('recovery') });
  recovery.load();
  launch = new LaunchService(db, { launchers, accounts, library, settings, log: log.child('launch'), journal });
  const artwork = new ArtworkService(db, {
    dir: paths.artworkDir,
    fetch: platform.fetch,
    apiKey: () => secrets.get('steamgriddb.apiKey'),
    hasApiKey: () => secrets.has('steamgriddb.apiKey'),
    autoFetch: () => settings.getBool('artwork.autoFetch', true),
    launcherIcon: (game) => launchers.gameIcon(game.launcher, game),
    library,
    log: log.child('artwork'),
  });
  const updateService = new UpdateService({
    availability: () =>
      updateAvailability({
        testFeed: updateTestFeed !== null,
        isPackaged: app.isPackaged,
        dataDirSource,
        execPath: process.execPath,
        fileExists: existsSync,
        perUserInstallLocation: () => platform.registry.getString('HKCU', INSTALL_REGISTRY_KEY, 'InstallLocation'),
      }),
    engine: async () => (await import('./updates/engine')).createUpdateEngine({ log: log.child('updater'), dataDir: paths.dataDir, testFeed: updateTestFeed }),
    keys: updateTestFeed?.keys ?? RELEASE_KEYS,
    auto: settings.getBool('updates.auto', true),
    quit: () => app.quit(),
    log: log.child('updates'),
  });
  updates = updateService;

  quitCleanup = async (): Promise<void> => {
    updateService.stop();
    artwork.stop();
    launchers.closing();
    if (!(await launchers.whenIdle(LAUNCHER_IDLE_AT_QUIT_MS))) log.warn('launcher work still running at quit');
    const cleared = await clipboardService.clearIfUnchanged();
    if (cleared) log.info('cleared a copied value from the clipboard at quit');
  };

  // The interface uses no permission-gated web API, and without handlers Electron grants every request, clipboard reads included.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  // Strictly files under the artwork folder; anything else is a 404. See resolveArtworkPath.
  protocol.handle(ARTWORK_SCHEME, async (request) => {
    const file = resolveArtworkPath(request.url, paths.artworkDir);
    if (!file) return new Response(null, { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    if (!res.ok) return new Response(null, { status: 404 });
    // URLs carry ?v=<fetchedAt>, so the renderer may cache each version indefinitely.
    return new Response(res.body, {
      status: 200,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' },
    });
  });

  const rescan = async (): Promise<LibraryScanResult[]> => {
    const scanned = await scanLibrary({ launchers, library, log: log.child('scan') });
    artwork.prune();
    const queued = artwork.enqueueAfterScan();
    if (queued > 0) log.info('artwork queued', { queued });
    return scanned;
  };

  const pickImage = async (): Promise<string | null> => {
    const opts = {
      title: 'Choose an image',
      properties: ['openFile' as const],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };

  const pickLauncherExe = async (launcher: LauncherId): Promise<string | null> => {
    const opts = {
      title: `Locate ${LAUNCHER_EXE_NAMES[launcher]}`,
      properties: ['openFile' as const],
      filters: [{ name: LAUNCHER_DISPLAY_NAMES[launcher], extensions: ['exe'] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };

  const windowTitle = platform.source === 'fake' ? 'One Launch (fake launchers)' : 'One Launch';
  registerIpcHandlers({
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
    rescan,
    pickImage,
    pickLauncherExe,
    getStartupMetrics: () => ({ ...startup }),
    isTrustedSender,
    platformSource: platform.source,
    onSettingChanged: (key, value) => {
      if (key === 'window.closeToTray') setTrayEnabled(value === 'true', windowTitle);
      if (key === 'updates.auto') updateService.setAuto(value === 'true');
    },
  });
  phases.ipc = sinceStart();

  Menu.setApplicationMenu(null);
  mainWindow = createMainWindow(settings, windowTitle);

  // Background work starts only once the window is up, so it never delays first paint. A failing
  // adapter is logged and the library keeps showing the last scan.
  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      // A quit inside this delay has already closed the database (a scenario's restart on a fast runner does this).
      if (quitting || !db?.open) return;
      setTrayEnabled(closeToTray(), windowTitle);
      rescan().catch((err: unknown) => log.warn('startup library scan failed', { error: err }));
      // The database holds every account; a copy per start (newest 5 kept) is the way back from a damaged file.
      if (db) {
        backupDatabase(db, join(paths.backupsDir, 'db'), DB_COPIES_TO_KEEP)
          .then((dest) => log.info('database copied', { dest }))
          .catch((err: unknown) => log.warn('database copy failed', { error: err }));
      }
      updateService.start().catch((err: unknown) => log.warn('updater did not start', { error: err }));
    }, 250);
  });
}

app
  .whenReady()
  .then(bootstrap)
  .catch((err: unknown) => {
    log.error('fatal during startup', err);
    const reason = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      'One Launch could not start',
      `${reason}\n\nDetails are in the log:\n${join(paths.logsDir, 'onelaunch.log')}\n\nData folder:\n${paths.dataDir}`,
    );
    app.exit(1);
  });

app.on('second-instance', () => {
  showMainWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

// Every quit path except app.exit() passes through here: ask about a running switch, then run the cleanup once before the database closes.
app.on('before-quit', (event) => {
  quitting = true;
  if (!quitConfirmed && launch?.isBusy() && mainWindow) {
    event.preventDefault();
    void confirmQuitDuringSwitch(mainWindow).finally(() => {
      if (!quitConfirmed) quitting = false;
    });
    return;
  }
  if (quitCleanupDone || !quitCleanup) return;
  event.preventDefault();
  quitCleanupDone = true;
  const cleanup = quitCleanup;
  void stopRunningSwitch('quit')
    .then(() => Promise.race([cleanup(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]))
    .catch((err: unknown) => log.warn('quit cleanup failed', { error: err }))
    .finally(() => app.quit());
});

app.on('will-quit', () => {
  tray?.destroy();
  tray = null;
  try {
    db?.close();
  } catch (err) {
    log.warn('error closing database', err);
  }
  log.info('exit');
});

// After will-quit has closed the database, so the installer's wait-then-kill never lands on our own cleanup.
app.on('quit', (_event, exitCode) => {
  updates?.installAtQuit(exitCode);
});

/**
 * After startup an uncaught exception means main is in an unknown state (a handler half-run, a
 * statement mid-transaction). Log it, then tell the user once and offer a relaunch; a second
 * exception within a minute only logs, so a tight failure loop cannot stack dialogs.
 */
let lastCrashDialogAt = 0;
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err);
  updates?.onCrash();
  if (!mainWindow || Date.now() - lastCrashDialogAt < 60_000) return;
  lastCrashDialogAt = Date.now();
  const reason = err instanceof Error ? err.message : String(err);
  showMainWindow();
  void dialog
    .showMessageBox(mainWindow, {
      type: 'error',
      title: 'One Launch hit an unexpected error',
      message: 'Something went wrong inside One Launch.',
      detail: `${reason}\n\nThe details are in ${join(paths.logsDir, 'onelaunch.log')}. Relaunching is the safe choice; keeping it running may leave things half-done.`,
      buttons: ['Relaunch', 'Keep running'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response !== 0) return;
      quitConfirmed = true;
      app.relaunch();
      // quit(), not exit(): the running switch is stopped, the clipboard cleared, and the database closed. exit() is the fallback if main is too far gone for that.
      app.quit();
      setTimeout(() => app.exit(0), QUIT_WAIT_MS + 5_000).unref();
    })
    .catch((e: unknown) => log.warn('could not show the crash dialog', { error: e }));
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason);
});
