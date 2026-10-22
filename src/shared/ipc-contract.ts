/**
 * The IPC contract between renderer and main.
 *
 * Every channel is a request/response pair handled with ipcMain.handle / ipcRenderer.invoke.
 * The preload script only forwards channels listed in IPC_CHANNELS, and the main process only
 * registers handlers for keys of IpcContract, so this file is the single place to extend the API.
 */

import type {
  Account,
  AccountCreateInput,
  AccountPatch,
  AppInfo,
  ArtworkKind,
  ArtworkStatus,
  AutostartStatus,
  BackupSnapshot,
  Game,
  InstalledGame,
  LaunchJob,
  LaunchPreflight,
  LauncherId,
  LauncherInstall,
  LauncherSession,
  LauncherSessionState,
  LauncherStatus,
  LibraryScanResult,
  OpenUrlTarget,
  RecentLaunch,
  RememberedAccount,
  RestoreResult,
  RendererSecretKey,
  SettingKey,
  SwitchPlan,
  SwitchRecovery,
  UpdateStatus,
  VaultHealthStatus,
  VaultResetSummary,
} from './models';

export interface IpcContract {
  'app:ping': { req: { message: string }; res: { echo: string; receivedAt: string } };
  'app:info': { req: undefined; res: AppInfo };
  'app:openPath': { req: { target: 'logs' | 'data' | 'backups' }; res: { ok: true } };
  /** Opens one of a fixed list of web pages in the system browser; the renderer never names a URL. */
  'app:openUrl': { req: { target: OpenUrlTarget }; res: { ok: true } };
  /** A renderer-side error (render tree, window error, unhandled rejection), written to the main log after redaction. */
  'app:reportError': { req: { source: 'render' | 'window' | 'promise'; message: string; stack: string | null }; res: { ok: true } };

  /** Availability plus whether stored ciphertext still decrypts (false means the key was lost). */
  'vault:status': { req: undefined; res: VaultHealthStatus };
  /** Removes every stored password, session snapshot, and named secret. The only way back from a lost key. */
  'vault:reset': { req: undefined; res: VaultResetSummary };
  'vault:setSecret': { req: { key: RendererSecretKey; value: string }; res: { ok: true } };
  /** Only the diagnostics round-trip may be read back; real secrets never travel to the renderer. */
  'vault:getSecret': { req: { key: 'diagnostics.roundtrip' }; res: { value: string | null } };
  'vault:deleteSecret': { req: { key: RendererSecretKey }; res: { ok: true } };

  'settings:get': { req: { key: SettingKey }; res: { value: string | null } };
  'settings:set': { req: { key: SettingKey; value: string }; res: { ok: true } };
  'settings:getAll': { req: undefined; res: { settings: Partial<Record<SettingKey, string>> } };

  'accounts:list': { req: undefined; res: { accounts: Account[] } };
  'accounts:get': { req: { id: string }; res: { account: Account } };
  'accounts:create': { req: AccountCreateInput; res: { account: Account } };
  'accounts:update': { req: { id: string; patch: AccountPatch }; res: { account: Account } };
  'accounts:delete': { req: { id: string }; res: { ok: true } };
  /** Re-encrypts and overwrites the stored password. No launcher interaction (spec section 6). */
  'accounts:setPassword': { req: { id: string; password: string }; res: { account: Account } };
  'accounts:clearPassword': { req: { id: string }; res: { account: Account } };
  /**
   * Copies the login or password to the system clipboard from the main process, so plaintext never
   * enters the renderer. The clipboard is cleared after `clearAfterMs` unless the user has copied
   * something else in the meantime.
   */
  'accounts:copy': { req: { id: string; field: 'login' | 'password' }; res: { clearAfterMs: number; historyExcluded: boolean } };

  /** `revision` is the library revision the list was read at, for the Library's `artwork:status` poll to compare against. */
  'library:list': { req: undefined; res: { games: Game[]; revision: number } };
  /** Re-reads every implemented launcher's files and updates the games table. A launcher that is missing or fails never stops the others. */
  'library:rescan': { req: undefined; res: { games: Game[]; scanned: LibraryScanResult[] } };

  // --- artwork (spec section 9). Background queue; the renderer polls artwork:status. ---
  /** Queue one game (gameId) or every installed game (null). force re-downloads even when cached. */
  'artwork:refresh': { req: { gameId: string | null; force: boolean }; res: { queued: number } };
  /** Queue counters, whether a scan has run yet, and the library revision; the renderer reloads the list when the revision moves. */
  'artwork:status': { req: undefined; res: { status: ArtworkStatus } };
  /** Opens a file picker in the main process and copies the chosen image into the cache as the game's `kind`. */
  'artwork:setManual': { req: { gameId: string; kind: ArtworkKind }; res: { game: Game | null } };

  // --- launcher adapters (spec section 8). Read-only until the Steam switch path lands. ---
  /** Detection, running state, and health for every launcher. One failing adapter never fails the call. */
  'launchers:status': { req: undefined; res: { launchers: LauncherStatus[] } };
  /**
   * Opens a file picker in the main process for the launcher's executable and, when the file is that
   * launcher's, remembers its folder as the place to look first and starts a rescan in the background. `install` is null when
   * the user cancelled; NOT_A_LAUNCHER when the file is something else. The path never comes from the renderer.
   */
  'launchers:locate': { req: { launcher: LauncherId }; res: { install: LauncherInstall | null } };
  /** Forgets the chosen folder, back to automatic detection, and starts a rescan in the background. */
  'launchers:resetPath': { req: { launcher: LauncherId }; res: { ok: true } };
  /** Installed games read straight from launcher files (not the library table). */
  'launchers:games': { req: { launcher: LauncherId }; res: { games: InstalledGame[] } };
  /** Accounts the launcher itself remembers: names and IDs only, with any matching One Launch account. */
  'launchers:rememberedAccounts': { req: { launcher: LauncherId }; res: { accounts: RememberedAccount[] } };
  /**
   * Creates accounts (no password) for the chosen remembered entries, or links them to existing
   * accounts. Entries are keyed by launcherUid, or by login when the launcher records no id.
   */
  'launchers:importAccounts': {
    req: { launcher: LauncherId; launcherUids: string[] };
    res: { accounts: Account[]; skipped: { launcherUid: string; reason: string }[] };
  };
  /** switchAccount({ dryRun: true }): every process, file, and registry key a switch would touch. Changes nothing. */
  'launchers:switchPlan': { req: { accountId: string }; res: { plan: SwitchPlan } };

  // --- session snapshots (Phase 4, Epic). The blob never crosses the bridge; only its fingerprint. ---
  /** The account's stored snapshot plus what the launcher's own files say right now. */
  'sessions:get': {
    req: { accountId: string };
    res: { session: LauncherSession | null; state: LauncherSessionState | null; stateError: string | null };
  };
  /** Stores the launcher's current remembered session as this account's snapshot and links the launcher id. */
  'sessions:capture': { req: { accountId: string }; res: { session: LauncherSession; account: Account } };
  'sessions:forget': { req: { accountId: string }; res: { ok: true } };

  'backups:list': { req: { launcher: LauncherId }; res: { snapshots: BackupSnapshot[] } };
  /** Puts a snapshot back (files + recorded registry values). Refuses while the launcher is running. */
  'backups:restore': { req: { launcher: LauncherId; id: string }; res: { result: RestoreResult } };

  // --- switch + launch (spec section 10, "launch flow") -------------------------------------
  /** Read-only: the plan plus whether continuing would close the launcher or a running game. */
  'launch:preflight': { req: { accountId: string; gameId?: string | null }; res: { preflight: LaunchPreflight } };
  /**
   * Starts a switch (and, with a gameId, a launch) and returns the job at once. Refuses with DRY_RUN
   * while the setting is on, CONFIRM_REQUIRED when the launcher would be closed without confirmClose,
   * and BUSY while another job runs. Poll launch:status for progress.
   */
  'launch:start': { req: { accountId: string; gameId: string | null; confirmClose: boolean }; res: { job: LaunchJob } };
  'launch:status': { req: { jobId: string }; res: { job: LaunchJob } };
  /** Aborts the job. Before the launcher has been started again, anything written is put back; after that the launcher is left where it is. */
  'launch:cancel': { req: { jobId: string }; res: { job: LaunchJob } };
  /** Successful game + account pairs, newest first, one per pair. Feeds the library's Recent strip. */
  'launch:recent': { req: { limit: number }; res: { recent: RecentLaunch[] } };

  // --- recovery: a switch the last run did not finish (the switch journal) -------------------
  'recovery:get': { req: undefined; res: { recovery: SwitchRecovery | null } };
  /** Puts the journal's snapshot back, exactly as backups:restore would. Refuses while the launcher runs; the prompt stays. */
  'recovery:restore': { req: undefined; res: { result: RestoreResult } };
  /** Leaves the launcher as it is and forgets the interrupted switch. */
  'recovery:dismiss': { req: undefined; res: { ok: true } };

  // --- autostart: the Windows login item (HKCU Run value) that starts One Launch at sign-in ----------
  'autostart:status': { req: undefined; res: AutostartStatus };
  /** Registers or removes the login item. UNAVAILABLE when autostart:status says this copy may not. */
  'autostart:set': { req: { openAtLogin: boolean }; res: AutostartStatus };

  'updates:status': { req: undefined; res: UpdateStatus };
  /** Starts a check (and, when a signed update is found, its download) and answers at once; poll updates:status. */
  'updates:check': { req: undefined; res: UpdateStatus };
  /** Quits and runs the verified installer, which starts One Launch again. NOT_READY without a verified download, BUSY during a switch. */
  'updates:install': { req: undefined; res: { ok: true } };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<K extends IpcChannel> = IpcContract[K]['req'];
export type IpcResponse<K extends IpcChannel> = IpcContract[K]['res'];

/**
 * Runtime allowlist used by the preload script. `satisfies` guarantees it stays in sync with the
 * interface: adding a channel to IpcContract without listing it here is a type error, and vice versa.
 */
export const IPC_CHANNELS = [
  'app:ping',
  'app:info',
  'app:openPath',
  'app:openUrl',
  'app:reportError',
  'vault:status',
  'vault:reset',
  'vault:setSecret',
  'vault:getSecret',
  'vault:deleteSecret',
  'settings:get',
  'settings:set',
  'settings:getAll',
  'accounts:list',
  'accounts:get',
  'accounts:create',
  'accounts:update',
  'accounts:delete',
  'accounts:setPassword',
  'accounts:clearPassword',
  'accounts:copy',
  'library:list',
  'library:rescan',
  'artwork:refresh',
  'artwork:status',
  'artwork:setManual',
  'launchers:status',
  'launchers:locate',
  'launchers:resetPath',
  'launchers:games',
  'launchers:rememberedAccounts',
  'launchers:importAccounts',
  'launchers:switchPlan',
  'sessions:get',
  'sessions:capture',
  'sessions:forget',
  'backups:list',
  'backups:restore',
  'launch:preflight',
  'launch:start',
  'launch:status',
  'launch:cancel',
  'launch:recent',
  'recovery:get',
  'recovery:restore',
  'recovery:dismiss',
  'autostart:status',
  'autostart:set',
  'updates:status',
  'updates:check',
  'updates:install',
] as const satisfies readonly IpcChannel[];

type MissingChannels = Exclude<IpcChannel, (typeof IPC_CHANNELS)[number]>;
// If this line errors, a channel was added to IpcContract but not to IPC_CHANNELS.
const _allChannelsListed: MissingChannels extends never ? true : never = true;
void _allChannelsListed;

export interface IpcErrorShape {
  code: string;
  message: string;
}

/** Wire envelope. Handlers never throw across the bridge; failures travel as data. */
export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: IpcErrorShape };

/** Argument tuple for a channel: no argument when the request type is `undefined`. */
export type IpcArgs<K extends IpcChannel> = IpcRequest<K> extends undefined ? [] : [req: IpcRequest<K>];

export const RECENT_LIMIT = 8;

/**
 * Every start needs these answers before its first paint. The preload sends them the moment the page's document
 * starts, and the renderer's first render reads them (src/renderer/src/lib/startup.ts); any later mount asks main afresh.
 */
export const STARTUP_REQUESTS = {
  'library:list': undefined,
  'launch:recent': { limit: RECENT_LIMIT },
  'settings:getAll': undefined,
  'accounts:list': undefined,
  'app:info': undefined,
  'recovery:get': undefined,
  'updates:status': undefined,
} as const satisfies { [K in IpcChannel]?: IpcRequest<K> };

export type StartupChannel = keyof typeof STARTUP_REQUESTS;

/**
 * The raw API surface exposed on `window.oneLaunch` by the preload script. It returns the wire
 * envelope untouched: Errors thrown across the context bridge lose everything but their message,
 * so the renderer-side client (src/renderer/src/lib/ipc.ts) is what unwraps it into typed errors.
 */
export interface OneLaunchApi {
  invoke<K extends IpcChannel>(channel: K, ...args: IpcArgs<K>): Promise<IpcEnvelope<IpcResponse<K>>>;
  /** One STARTUP_REQUESTS answer, from the request sent when the document started; every call returns that same promise. */
  startup<K extends StartupChannel>(channel: K): Promise<IpcEnvelope<IpcResponse<K>>>;
}

/** What renderer code actually calls: unwrapped data, or a thrown error carrying a code. */
export interface IpcClient {
  invoke<K extends IpcChannel>(channel: K, ...args: IpcArgs<K>): Promise<IpcResponse<K>>;
}
