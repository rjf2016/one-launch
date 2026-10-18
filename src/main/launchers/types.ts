import type {
  HealthReport,
  InstalledGame,
  JobStep,
  LaunchAttention,
  LauncherId,
  LauncherInstall,
  LauncherSession,
  LauncherSessionState,
  RememberedAccount,
  RestoreResult,
  RunningGame,
  SwitchPlan,
  SwitchStrategy,
} from '@shared/models';

/** The account a switch targets. Never carries the password; adapters ask the vault at the moment of use. */
export interface AccountRef {
  /** One Launch account id, or null when the ref was built from launcher data alone (previews, imports). */
  id: string | null;
  displayName: string;
  login: string;
  launcherUid: string | null;
  hasSecret: boolean;
}

/** How an adapter finds and links One Launch accounts by the launcher's own account id. */
export interface AccountDirectory {
  /** The One Launch account linked to this launcher account id, if any. */
  byLauncherUid(uid: string): AccountRef | null;
  byId(id: string): AccountRef | null;
  /** Records the launcher's account id on a One Launch account once a sign-in has confirmed it. */
  setLauncherUid(accountId: string, uid: string): void;
}

export interface SwitchResult {
  launcher: LauncherId;
  account: SwitchPlan['account'];
  strategy: SwitchStrategy;
  ok: boolean;
  /**
   * Steam asked for a manual sign-in (Steam Guard, expired session, no stored password) and the
   * wait for it ran out. Nothing is rolled back; the user finishes the sign-in by hand.
   */
  needsSignIn: boolean;
  /** The caller aborted the switch. `restored` says whether writes made before the launcher was started were put back. */
  cancelled: boolean;
  /** Snapshot taken before the first modification, when one was taken. */
  backupId: string | null;
  /** After a failure: whether the snapshot was put back. Null when nothing had been modified yet. */
  restored: boolean | null;
  error: string | null;
  steps: JobStep[];
  startedAt: string;
  finishedAt: string;
  /**
   * When the switch started the launcher: the time from which it takes a game launch (Battle.net drops earlier
   * requests). LaunchService waits for it only when a game follows. Null when nothing needs waiting for.
   */
  readyAt: string | null;
  /**
   * The game (`launcherGameId`) the switch started the launcher for, with the game's own launch arguments, when the
   * caller named one in `SwitchOptions.game` and the launcher takes them at its start (Riot). `launchGame` with
   * `startedBySwitch` then only confirms the launch. Null when the launcher was started bare or not at all.
   */
  startedWithGame: string | null;
}

/** Called with the full step list every time a step changes state. */
export type SwitchProgress = (steps: readonly JobStep[]) => void;

export interface SwitchOptions {
  dryRun: boolean;
  /**
   * The user has confirmed that the launcher (and any game running under it) may be closed.
   * A real switch that would close a running launcher without this throws CONFIRM_REQUIRED.
   */
  confirmClose?: boolean;
  onProgress?: SwitchProgress;
  /** Called with the snapshot id as soon as the snapshot exists, before the first launcher file or registry value is written. */
  onBackup?: (backupId: string) => void;
  /** Called when the switch starts or stops waiting for the user in the launcher window. */
  onAttention?: (attention: LaunchAttention | null) => void;
  /**
   * Aborting it ends whatever wait the switch is in. Before the launcher has been started again the
   * switch stops and puts back anything it wrote; after that the writes stand and the launcher is
   * left to finish signing in. Either way the result is `cancelled`. A rollback is never interrupted.
   */
  signal?: AbortSignal;
  /**
   * Decrypts the account's password at the moment it is needed (credentials path, or the fallback
   * when a remembered session turns out to be expired). Returns null when none is stored.
   */
  getPassword?: () => string | null;
  /**
   * The game the caller launches once the switch is done. A launcher that takes a game's launch arguments at its
   * start is started with them (Riot: the sign-in and the game's page come up together), and the result's
   * `startedWithGame` names the game.
   */
  game?: Pick<InstalledGame, 'launcherGameId' | 'name'>;
}

/** What a real switch would run into right now. Read-only. */
export interface SwitchPreflight {
  plan: SwitchPlan;
  launcherRunning: boolean;
  runningGame: RunningGame | null;
  alreadyActive: boolean;
  /**
   * What closing the launcher means for this launcher and any running game, in the adapter's own
   * words (Battle.net leaves the game running; Steam and Epic take it down). Shown before a switch
   * that would close the launcher; the same sentence goes into ConfirmationRequiredError.
   */
  closeMessage: string;
}

/** Every registry read and process check is a child process, so a status pass hands its install and running state on to the health check. */
export interface KnownLauncherState {
  install: LauncherInstall | null;
  running: boolean | null;
}

/** A remembered account as the adapter sees it, before One Launch links it to its own accounts. */
export type RememberedAccountEntry = Omit<RememberedAccount, 'linkedAccountId'>;

/** Spec section 8.1. */
export interface LauncherAdapter {
  readonly id: LauncherId;
  readonly displayName: string;

  /** Locate the launcher: the folder chosen in Settings first, then the registry, then the default location. Returns null if not installed. */
  detectInstall(): Promise<LauncherInstall | null>;

  /** The folder chosen in Settings, whether or not the launcher is still in it. */
  chosenInstallDir(): string | null;

  /** The installation a file the user picked belongs to, or null when it is not this launcher's executable inside a complete installation. Reads only. */
  installFromExe(exePath: string): LauncherInstall | null;

  /** Enumerate installed games by reading local launcher files. Must work offline. */
  listInstalledGames(): Promise<InstalledGame[]>;

  /** Accounts the launcher itself remembers. Names and IDs only, never credentials. */
  listRememberedAccounts(): Promise<RememberedAccountEntry[]>;

  /** Is the launcher process currently running? */
  isRunning(): Promise<boolean>;

  /** A game the launcher is running right now, if any. */
  runningGame(): Promise<RunningGame | null>;

  /** Gracefully close the launcher, escalating to kill after a timeout. An aborted signal ends the wait with SwitchAbortedError. */
  shutdown(opts?: { timeoutMs?: number; signal?: AbortSignal | undefined }): Promise<void>;

  /** Everything the UI needs to ask for confirmation before a real switch. Changes nothing. `forGame` is the game the switch would start the launcher for, so the plan says so. */
  preflight(account: AccountRef, forGame?: Pick<InstalledGame, 'launcherGameId' | 'name'>): Promise<SwitchPreflight>;

  /**
   * Make `account` the active account. May restart the launcher.
   * In dryRun mode, returns the plan (files/keys that would change) without changing anything.
   */
  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: true }): Promise<SwitchPlan>;
  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: false }): Promise<SwitchResult>;
  switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult>;

  /**
   * Launch a game, assuming the correct account is already active. Returns what was sent, for the job log, and
   * `handOff` when the launcher only opened the game's page and the user must press Play there (Riot). Aborting
   * the signal ends any watch for the launcher's reaction. `startedBySwitch` says the switch just started the
   * launcher with this game's own arguments (`SwitchResult.startedWithGame`), so the launch is already under way.
   */
  launchGame(
    game: Pick<InstalledGame, 'launcherGameId' | 'name'>,
    opts?: { signal?: AbortSignal | undefined; startedBySwitch?: boolean },
  ): Promise<{ command: string; handOff?: string }>;

  /** The icon file the launcher keeps for the game, as a local path, or null. For launchers whose games no artwork source online knows (Riot). Reads only. */
  gameIcon?(game: Pick<InstalledGame, 'launcherGameId' | 'name'>): Promise<string | null>;

  /** Put a backup snapshot back: files and the registry values recorded with it. */
  restoreBackup(id: string): Promise<RestoreResult>;

  /** Quick self-check: are the files/keys this adapter relies on where we expect? `known` is what the caller found out in the same pass, so it is not asked for again. */
  healthCheck(known?: KnownLauncherState): Promise<HealthReport>;

  /**
   * Session snapshots, for launchers that sign in from a remembered-session blob (Epic). Absent on
   * launchers with a native account list (Steam).
   */
  sessionState?(): Promise<LauncherSessionState>;
  /**
   * Stores the launcher's current remembered session as `account`'s snapshot. Throws SWITCH_BLOCKED
   * when there is none, or when it is known to belong to a different account.
   */
  captureSession?(account: AccountRef): Promise<{ session: LauncherSession; launcherUid: string | null }>;
}

export class LauncherNotInstalledError extends Error {
  readonly code = 'NOT_INSTALLED';
  constructor(launcher: LauncherId) {
    super(`${launcher} is not installed on this PC`);
    this.name = 'LauncherNotInstalledError';
  }
}

export class AdapterNotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED';
  constructor(message: string) {
    super(message);
    this.name = 'AdapterNotImplementedError';
  }
}

/** Thrown by an adapter when a launcher file exists but is not in the shape we expect. */
export class LauncherFileError extends Error {
  readonly code = 'LAUNCHER_FILE';
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${message}: ${path}`);
    this.name = 'LauncherFileError';
  }
}

/** The switch would close the launcher (and maybe a game) and the caller did not confirm. */
export class ConfirmationRequiredError extends Error {
  readonly code = 'CONFIRM_REQUIRED';
  constructor(
    message: string,
    readonly runningGame: RunningGame | null,
  ) {
    super(message);
    this.name = 'ConfirmationRequiredError';
  }
}

/**
 * A game is running that the switch must not disturb, so it is refused until the user has closed the
 * game (Riot: closing the client mid-match is a leave, with queue penalties; docs/adapters/riot.md, hard rule 2).
 */
export class GameRunningError extends Error {
  readonly code = 'GAME_RUNNING';
  constructor(
    message: string,
    readonly runningGame: RunningGame,
  ) {
    super(message);
    this.name = 'GameRunningError';
  }
}

/** The launcher's own state says the game cannot start right now (an update or a repair first, or it is running already). A refusal, logged at WARN. */
export class GameNotPlayableError extends Error {
  readonly code = 'GAME_NOT_PLAYABLE';
  constructor(message: string) {
    super(message);
    this.name = 'GameNotPlayableError';
  }
}

/** The launcher is running and the operation needs it closed (restore, for instance). */
export class LauncherRunningError extends Error {
  readonly code = 'LAUNCHER_RUNNING';
  constructor(message: string) {
    super(message);
    this.name = 'LauncherRunningError';
  }
}

/** A switch the plan says cannot run (credentials path, no password, ...). */
export class SwitchBlockedError extends Error {
  readonly code = 'SWITCH_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SwitchBlockedError';
  }
}

/**
 * The plan a preflight answers with. The warning that the running launcher will be closed is left out, since the
 * dialog says that once, in its own confirm box; the dry-run plan the account page previews keeps it.
 */
export function withoutCloseWarning(plan: SwitchPlan, closeWarning: string | null): SwitchPlan {
  return closeWarning ? { ...plan, warnings: plan.warnings.filter((w) => w !== closeWarning) } : plan;
}
