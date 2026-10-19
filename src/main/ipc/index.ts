import { app, shell, type IpcMainInvokeEvent } from 'electron';
import {
  ACCOUNT_LIMITS,
  ARTWORK_KINDS,
  isBattlenetLaunchForm,
  isEpicLaunchUriForm,
  isLogLevel,
  LAUNCHER_DISPLAY_NAMES,
  LAUNCHER_EXE_NAMES,
  LAUNCHER_IDS,
  LAUNCHER_PATH_SETTINGS,
  MAIN_ONLY_SETTING_KEYS,
  OPEN_URL_TARGETS,
  RENDERER_SECRET_KEYS,
  SETTING_KEYS,
  type AccountPatch,
  type AppInfo,
  type OpenUrlTarget,
  type PlatformSource,
  type LauncherId,
  type LibraryScanResult,
  type SettingKey,
  type StartupMetrics,
} from '@shared/models';

const OPEN_URLS: Readonly<Record<OpenUrlTarget, string>> = {
  'steamgriddb-api-key': 'https://www.steamgriddb.com/profile/preferences/api',
};
import { isVersionString } from '@shared/whats-new';
import type { AppPaths } from '../platform/paths';
import type { AccountsService } from '../services/accounts';
import type { ArtworkService } from '../services/artwork';
import type { BackupService } from '../services/backup';
import type { ClipboardService } from '../services/clipboard';
import { LaunchBusyError, type LaunchService } from '../services/launch';
import type { LauncherService } from '../services/launchers';
import type { LibraryService } from '../services/library';
import { setLogLevel, type Logger } from '../services/logger';
import type { SecretStore } from '../services/secrets';
import type { SettingsService } from '../services/settings';
import type { SwitchRecoveryService } from '../services/switch-journal';
import type { Vault } from '../services/vault';
import type { VaultHealth } from '../services/vault-health';
import type { UpdateService } from '../updates/update-service';
import {
  createRegistrar,
  expectNullableString,
  expectObject,
  expectOneOf,
  expectOptionalString,
  expectOptionalStringArray,
  expectString,
  expectStringArray,
  IpcRequestError,
} from './handle';

export interface IpcDeps {
  log: Logger;
  paths: AppPaths;
  vault: Vault;
  vaultHealth: VaultHealth;
  secrets: SecretStore;
  settings: SettingsService;
  accounts: AccountsService;
  clipboard: ClipboardService;
  library: LibraryService;
  launchers: LauncherService;
  backups: BackupService;
  launch: LaunchService;
  recovery: SwitchRecoveryService;
  artwork: ArtworkService;
  updates: UpdateService;
  /** Re-reads every implemented launcher and syncs the games table; shared with the startup scan. */
  rescan: () => Promise<LibraryScanResult[]>;
  /** Native open-file dialog for images, owned by main. Null when the user cancels. */
  pickImage: () => Promise<string | null>;
  /** Native open-file dialog for a launcher's executable, owned by main. Null when the user cancels. */
  pickLauncherExe: (launcher: LauncherId) => Promise<string | null>;
  getStartupMetrics: () => StartupMetrics;
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
  /** Reported in app:info so the renderer can mark a fake-launcher run. Defaults to 'real'. */
  platformSource?: PlatformSource;
  /** Called after settings:set has stored a value, for settings main applies at once (the tray icon). */
  onSettingChanged?: (key: SettingKey, value: string) => void;
}

const MAX_SECRET_LENGTH = 4096;
const MAX_SETTING_LENGTH = 4096;
const MAX_ID_LENGTH = 64;
const MAX_IMPORT_BATCH = 64;
const MAX_RECENT = 50;
const MAX_ERROR_TEXT = 8192;
const MAX_BACKUPS_TO_KEEP = 200;

export function registerIpcHandlers(deps: IpcDeps): void {
  const log = deps.log.child('ipc');
  const handle = createRegistrar({ log, isTrustedSender: deps.isTrustedSender });
  // A switch closes the launcher and rewrites its files; anything that changes accounts, sessions, or those files waits until it is done.
  const requireIdle = (): void => {
    if (deps.launch.isBusy()) throw new LaunchBusyError();
  };

  // --- app ---------------------------------------------------------------

  handle('app:ping', (req) => {
    const body = expectObject(req, 'app:ping');
    const message = expectString(body['message'], 'message', 1000);
    return { echo: message, receivedAt: new Date().toISOString() };
  });

  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node,
    chrome: process.versions.chrome ?? 'unknown',
    isPackaged: app.isPackaged,
    dataDir: deps.paths.dataDir,
    logDir: deps.paths.logsDir,
    dbPath: deps.paths.dbPath,
    startup: deps.getStartupMetrics(),
    platformSource: deps.platformSource ?? 'real',
  }));

  handle('app:openPath', async (req) => {
    const body = expectObject(req, 'app:openPath');
    const target = expectOneOf(body['target'], 'target', ['logs', 'data', 'backups'] as const);
    const dir = target === 'logs' ? deps.paths.logsDir : target === 'backups' ? deps.paths.backupsDir : deps.paths.dataDir;
    const problem = await shell.openPath(dir);
    if (problem) throw new IpcRequestError('OPEN_FAILED', problem);
    return { ok: true };
  });

  handle('app:openUrl', async (req) => {
    const body = expectObject(req, 'app:openUrl');
    const target = expectOneOf(body['target'], 'target', OPEN_URL_TARGETS);
    await shell.openExternal(OPEN_URLS[target]);
    return { ok: true };
  });

  handle('app:reportError', (req) => {
    const body = expectObject(req, 'app:reportError');
    const source = expectOneOf(body['source'], 'source', ['render', 'window', 'promise'] as const);
    const message = expectString(body['message'], 'message', MAX_ERROR_TEXT);
    const stack = expectNullableString(body['stack'], 'stack', MAX_ERROR_TEXT) ?? null;
    log.error('renderer error', { source, message, stack });
    return { ok: true };
  });

  // --- vault -------------------------------------------------------------

  handle('vault:status', () => deps.vaultHealth.status());

  handle('vault:reset', () => {
    const removed = deps.vaultHealth.reset();
    log.warn('vault reset by user', removed);
    return removed;
  });

  handle('vault:setSecret', (req) => {
    const body = expectObject(req, 'vault:setSecret');
    const key = expectOneOf(body['key'], 'key', RENDERER_SECRET_KEYS);
    const value = expectString(body['value'], 'value', MAX_SECRET_LENGTH);
    deps.secrets.set(key, value);
    log.info('secret stored', { key });
    return { ok: true };
  });

  handle('vault:getSecret', (req) => {
    const body = expectObject(req, 'vault:getSecret');
    const key = expectOneOf(body['key'], 'key', ['diagnostics.roundtrip'] as const);
    return { value: deps.secrets.get(key) };
  });

  handle('vault:deleteSecret', (req) => {
    const body = expectObject(req, 'vault:deleteSecret');
    const key = expectOneOf(body['key'], 'key', RENDERER_SECRET_KEYS);
    deps.secrets.delete(key);
    log.info('secret deleted', { key });
    return { ok: true };
  });

  // --- settings ----------------------------------------------------------

  handle('settings:get', (req) => {
    const body = expectObject(req, 'settings:get');
    const key = expectOneOf(body['key'], 'key', SETTING_KEYS);
    return { value: deps.settings.get(key) };
  });

  handle('settings:set', (req) => {
    const body = expectObject(req, 'settings:set');
    const key = expectOneOf(body['key'], 'key', SETTING_KEYS);
    const value = expectString(body['value'], 'value', MAX_SETTING_LENGTH);
    if (MAIN_ONLY_SETTING_KEYS.includes(key)) throw new IpcRequestError('BAD_REQUEST', `${key} is not user-settable`);
    if (key === 'logLevel') {
      if (!isLogLevel(value)) throw new IpcRequestError('BAD_REQUEST', 'logLevel must be debug, info, warn, or error');
      setLogLevel(value);
    }
    if (key === 'epic.launchUri' && !isEpicLaunchUriForm(value)) throw new IpcRequestError('BAD_REQUEST', 'epic.launchUri must be catalog or appname');
    if (key === 'battlenet.launch' && !isBattlenetLaunchForm(value)) throw new IpcRequestError('BAD_REQUEST', 'battlenet.launch must be uri or exec');
    if (key === 'whatsNew.lastSeen' && !isVersionString(value)) throw new IpcRequestError('BAD_REQUEST', 'whatsNew.lastSeen must be a version');
    if (
      (key === 'dryRun' ||
        key === 'artwork.autoFetch' ||
        key === 'steam.autoLogin' ||
        key === 'riot.pressPlay' ||
        key === 'firstRun.dismissed' ||
        key === 'window.closeToTray' ||
        key === 'updates.auto' ||
        key === 'whatsNew.enabled') &&
      value !== 'true' &&
      value !== 'false'
    ) {
      throw new IpcRequestError('BAD_REQUEST', `${key} must be true or false`);
    }
    if (key === 'backups.keep' && !(/^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_BACKUPS_TO_KEEP)) {
      throw new IpcRequestError('BAD_REQUEST', `backups.keep must be a whole number from 1 to ${MAX_BACKUPS_TO_KEEP}`);
    }
    const turnsArtworkOn = key === 'artwork.autoFetch' && value === 'true' && deps.settings.get(key) === 'false';
    deps.settings.set(key, value);
    log.info('setting updated', { key, value });
    deps.onSettingChanged?.(key, value);
    if (turnsArtworkOn) {
      const queued = deps.artwork.enqueueAfterScan();
      if (queued > 0) log.info('artwork queued', { queued });
    }
    return { ok: true };
  });

  handle('settings:getAll', () => ({ settings: deps.settings.getAll() }));

  // --- accounts ----------------------------------------------------------
  // Password fields are validated for shape only and handed straight to the service, which
  // encrypts them. They are never included in log metadata.

  handle('accounts:list', () => ({ accounts: deps.accounts.list() }));

  handle('accounts:get', (req) => {
    const body = expectObject(req, 'accounts:get');
    const id = expectString(body['id'], 'id', MAX_ID_LENGTH);
    return { account: deps.accounts.require(id) };
  });

  handle('accounts:create', (req) => {
    const body = expectObject(req, 'accounts:create');
    const launcher = expectOneOf(body['launcher'], 'launcher', LAUNCHER_IDS);
    const displayName = expectString(body['displayName'], 'displayName', ACCOUNT_LIMITS.displayName);
    const login = expectString(body['login'], 'login', ACCOUNT_LIMITS.login);
    const password = expectNullableString(body['password'], 'password', ACCOUNT_LIMITS.password) ?? null;
    const launcherUid = expectNullableString(body['launcherUid'], 'launcherUid', ACCOUNT_LIMITS.launcherUid) ?? null;
    const tags = expectOptionalStringArray(body['tags'], 'tags', ACCOUNT_LIMITS.tagCount, ACCOUNT_LIMITS.tagLength) ?? [];
    const notes = expectOptionalString(body['notes'], 'notes', ACCOUNT_LIMITS.notes) ?? '';
    const account = deps.accounts.create({ launcher, displayName, login, password, launcherUid, tags, notes });
    log.info('account created', { id: account.id, launcher, hasSecret: account.hasSecret });
    return { account };
  });

  handle('accounts:update', (req) => {
    requireIdle();
    const body = expectObject(req, 'accounts:update');
    const id = expectString(body['id'], 'id', MAX_ID_LENGTH);
    const raw = expectObject(body['patch'], 'accounts:update.patch');
    const patch: AccountPatch = {};
    const displayName = expectOptionalString(raw['displayName'], 'displayName', ACCOUNT_LIMITS.displayName);
    if (displayName !== undefined) patch.displayName = displayName;
    const login = expectOptionalString(raw['login'], 'login', ACCOUNT_LIMITS.login);
    if (login !== undefined) patch.login = login;
    const launcherUid = expectNullableString(raw['launcherUid'], 'launcherUid', ACCOUNT_LIMITS.launcherUid);
    if (launcherUid !== undefined) patch.launcherUid = launcherUid;
    const tags = expectOptionalStringArray(raw['tags'], 'tags', ACCOUNT_LIMITS.tagCount, ACCOUNT_LIMITS.tagLength);
    if (tags !== undefined) patch.tags = tags;
    const notes = expectOptionalString(raw['notes'], 'notes', ACCOUNT_LIMITS.notes);
    if (notes !== undefined) patch.notes = notes;
    const account = deps.accounts.update(id, patch);
    log.info('account updated', { id, fields: Object.keys(patch) });
    return { account };
  });

  handle('accounts:delete', (req) => {
    requireIdle();
    const body = expectObject(req, 'accounts:delete');
    const id = expectString(body['id'], 'id', MAX_ID_LENGTH);
    deps.accounts.delete(id);
    log.info('account deleted', { id });
    return { ok: true };
  });

  handle('accounts:setPassword', (req) => {
    requireIdle();
    const body = expectObject(req, 'accounts:setPassword');
    const id = expectString(body['id'], 'id', MAX_ID_LENGTH);
    const password = expectString(body['password'], 'password', ACCOUNT_LIMITS.password);
    const account = deps.accounts.setPassword(id, password);
    log.info('account password updated', { id });
    return { account };
  });

  handle('accounts:clearPassword', (req) => {
    requireIdle();
    const body = expectObject(req, 'accounts:clearPassword');
    const id = expectString(body['id'], 'id', MAX_ID_LENGTH);
    const account = deps.accounts.clearPassword(id);
    log.info('account password removed', { id });
    return { account };
  });

  handle('accounts:copy', async (req) => {
    const body = expectObject(req, 'accounts:copy');
    const id = expectString(body['id'], 'id', MAX_ID_LENGTH);
    const field = expectOneOf(body['field'], 'field', ['login', 'password'] as const);
    let text: string | null;
    if (field === 'login') {
      text = deps.accounts.require(id).login;
    } else {
      text = deps.accounts.decryptPassword(id);
      if (text === null) throw new IpcRequestError('NO_PASSWORD', 'No password is stored for this account');
    }
    const result = await deps.clipboard.copySensitive(text);
    log.info('copied to clipboard', { id, field, clearAfterMs: result.clearAfterMs });
    return result;
  });

  // --- library -------------------------------------------------------------

  handle('library:list', () => ({ games: deps.library.list(), revision: deps.library.revision }));

  handle('library:rescan', async () => {
    const scanned = await deps.rescan();
    return { games: deps.library.list(), scanned };
  });

  // --- artwork ---------------------------------------------------------------
  // Outbound traffic is limited to game names and IDs. The API key never appears in these logs.

  handle('artwork:refresh', (req) => {
    const body = expectObject(req, 'artwork:refresh');
    const gameId = expectNullableString(body['gameId'], 'gameId', MAX_ID_LENGTH) ?? null;
    const force = body['force'] === true;
    const queued = deps.artwork.refresh(gameId, force);
    log.info('artwork refresh queued', { gameId, force, queued });
    return { queued };
  });

  handle('artwork:status', () => ({ status: deps.artwork.status() }));

  handle('artwork:setManual', async (req) => {
    const body = expectObject(req, 'artwork:setManual');
    const gameId = expectString(body['gameId'], 'gameId', MAX_ID_LENGTH);
    const kind = expectOneOf(body['kind'], 'kind', ARTWORK_KINDS);
    deps.library.require(gameId);
    const file = await deps.pickImage();
    if (!file) return { game: null };
    return { game: deps.artwork.setManual(gameId, kind, file) };
  });

  // --- launcher adapters ---------------------------------------------------------
  // Read-only in Phase 2 step 2. Nothing here writes to a launcher file or registry key.

  handle('launchers:status', async () => ({ launchers: await deps.launchers.status() }));

  // The folder a launcher is started from is chosen in main's own dialog and checked by the adapter; the renderer only names the launcher.
  // Not awaited: a scan reads every launcher and can take seconds on a busy PC, and the Library follows the revision on its own.
  const rescanAfterPathChange = (launcher: LauncherId): void => {
    void deps.rescan().catch((err: unknown) => log.warn('rescan after a launcher folder change failed', { launcher, error: err }));
  };

  handle('launchers:locate', async (req) => {
    requireIdle();
    const body = expectObject(req, 'launchers:locate');
    const launcher = expectOneOf(body['launcher'], 'launcher', LAUNCHER_IDS);
    const file = await deps.pickLauncherExe(launcher);
    if (!file) return { install: null };
    const install = await deps.launchers.installFromExe(launcher, file);
    if (!install) {
      throw new IpcRequestError(
        'NOT_A_LAUNCHER',
        `That file is not ${LAUNCHER_DISPLAY_NAMES[launcher]}. Choose ${LAUNCHER_EXE_NAMES[launcher]} in the folder ${LAUNCHER_DISPLAY_NAMES[launcher]} is installed in.`,
      );
    }
    // The dialog can stay open for minutes; a switch may have started meanwhile.
    requireIdle();
    deps.settings.set(LAUNCHER_PATH_SETTINGS[launcher], install.installDir);
    log.info('launcher folder chosen by user', { launcher });
    rescanAfterPathChange(launcher);
    return { install };
  });

  handle('launchers:resetPath', (req) => {
    requireIdle();
    const body = expectObject(req, 'launchers:resetPath');
    const launcher = expectOneOf(body['launcher'], 'launcher', LAUNCHER_IDS);
    deps.settings.delete(LAUNCHER_PATH_SETTINGS[launcher]);
    log.info('launcher folder reset to automatic detection', { launcher });
    rescanAfterPathChange(launcher);
    return { ok: true };
  });

  handle('launchers:games', async (req) => {
    const body = expectObject(req, 'launchers:games');
    const launcher = expectOneOf(body['launcher'], 'launcher', LAUNCHER_IDS);
    return { games: await deps.launchers.installedGames(launcher) };
  });

  handle('launchers:rememberedAccounts', async (req) => {
    const body = expectObject(req, 'launchers:rememberedAccounts');
    const launcher = expectOneOf(body['launcher'], 'launcher', LAUNCHER_IDS);
    return { accounts: await deps.launchers.rememberedAccounts(launcher) };
  });

  handle('launchers:importAccounts', async (req) => {
    const body = expectObject(req, 'launchers:importAccounts');
    const launcher = expectOneOf(body['launcher'], 'launcher', LAUNCHER_IDS);
    // Keys are launcher account ids, or logins for launchers that record none (Battle.net).
    const launcherUids = expectStringArray(body['launcherUids'], 'launcherUids', MAX_IMPORT_BATCH, ACCOUNT_LIMITS.login);
    const result = await deps.launchers.importAccounts(launcher, launcherUids);
    log.info('imported launcher accounts', { launcher, created: result.accounts.length, skipped: result.skipped.length });
    return result;
  });

  handle('launchers:switchPlan', async (req) => {
    const body = expectObject(req, 'launchers:switchPlan');
    const accountId = expectString(body['accountId'], 'accountId', MAX_ID_LENGTH);
    const plan = await deps.launchers.switchPlan(accountId);
    log.info('switch plan generated', { accountId, launcher: plan.launcher, strategy: plan.strategy, steps: plan.steps.length });
    return { plan };
  });

  // --- session snapshots (Phase 4) ------------------------------------------------------
  // The blob never crosses the bridge. sessions:capture reads a launcher file; nothing here writes one.

  handle('sessions:get', async (req) => {
    const body = expectObject(req, 'sessions:get');
    const accountId = expectString(body['accountId'], 'accountId', MAX_ID_LENGTH);
    return deps.launchers.session(accountId);
  });

  handle('sessions:capture', async (req) => {
    requireIdle();
    const body = expectObject(req, 'sessions:capture');
    const accountId = expectString(body['accountId'], 'accountId', MAX_ID_LENGTH);
    const result = await deps.launchers.captureSession(accountId);
    log.info('session captured by user', { accountId, launcher: result.session.launcher });
    return result;
  });

  handle('sessions:forget', (req) => {
    requireIdle();
    const body = expectObject(req, 'sessions:forget');
    const accountId = expectString(body['accountId'], 'accountId', MAX_ID_LENGTH);
    deps.launchers.forgetSession(accountId);
    return { ok: true };
  });

  // --- backups ---------------------------------------------------------------------

  handle('backups:list', (req) => {
    const body = expectObject(req, 'backups:list');
    const launcher = expectOneOf(body['launcher'], 'launcher', LAUNCHER_IDS);
    return { snapshots: deps.backups.list(launcher) };
  });

  handle('backups:restore', async (req) => {
    requireIdle();
    const body = expectObject(req, 'backups:restore');
    const launcher = expectOneOf(body['launcher'], 'launcher', LAUNCHER_IDS);
    const id = expectString(body['id'], 'id', 128);
    if (!deps.backups.get(launcher, id)) throw new IpcRequestError('NOT_FOUND', 'That snapshot no longer exists');
    const result = await deps.launchers.restoreBackup(launcher, id);
    log.warn('backup restored by user', { launcher, id, files: result.files.length, registry: result.registry.length });
    deps.recovery.restoredFromBackups(launcher);
    return { result };
  });

  // --- switch + launch ---------------------------------------------------------------
  // The only path that writes to launcher files and registry keys. Guarded three ways: the dryRun
  // setting, an explicit confirmClose from the UI when the launcher would be closed, and a backup
  // snapshot before the first modification.

  handle('launch:preflight', async (req) => {
    const body = expectObject(req, 'launch:preflight');
    const accountId = expectString(body['accountId'], 'accountId', MAX_ID_LENGTH);
    const gameId = expectNullableString(body['gameId'], 'gameId', MAX_ID_LENGTH) ?? null;
    return { preflight: await deps.launch.preflight(accountId, gameId) };
  });

  handle('launch:start', async (req) => {
    const body = expectObject(req, 'launch:start');
    const accountId = expectString(body['accountId'], 'accountId', MAX_ID_LENGTH);
    const gameId = expectNullableString(body['gameId'], 'gameId', MAX_ID_LENGTH) ?? null;
    const confirmClose = body['confirmClose'] === true;
    const job = await deps.launch.start({ accountId, gameId, confirmClose });
    log.info('launch job accepted', { jobId: job.id, accountId, gameId, confirmClose });
    return { job };
  });

  handle('launch:status', (req) => {
    const body = expectObject(req, 'launch:status');
    const jobId = expectString(body['jobId'], 'jobId', MAX_ID_LENGTH);
    return { job: deps.launch.status(jobId) };
  });

  handle('launch:cancel', (req) => {
    const body = expectObject(req, 'launch:cancel');
    const jobId = expectString(body['jobId'], 'jobId', MAX_ID_LENGTH);
    return { job: deps.launch.cancel(jobId) };
  });

  handle('launch:recent', (req) => {
    const body = expectObject(req, 'launch:recent');
    const raw = body['limit'];
    const limit = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_RECENT) : 10;
    return { recent: deps.launch.recentLaunches(limit) };
  });

  // --- recovery: a switch the last run did not finish ------------------------------------------
  // The restore is the same adapter path as backups:restore; no launcher file is touched any other way.

  handle('recovery:get', () => ({ recovery: deps.recovery.get() }));

  handle('recovery:restore', async () => {
    requireIdle();
    const result = await deps.recovery.restore();
    return { result };
  });

  handle('recovery:dismiss', () => {
    deps.recovery.dismiss();
    return { ok: true as const };
  });

  // --- updates -------------------------------------------------------------

  handle('updates:status', () => deps.updates.status());

  handle('updates:check', () => deps.updates.check());

  handle('updates:install', () => {
    requireIdle();
    deps.updates.requestInstall();
    return { ok: true as const };
  });
}
