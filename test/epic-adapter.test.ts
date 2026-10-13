import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EPIC_UNINSTALL_KEY, EPIC_URI_COMMAND_KEY, EpicAdapter } from '../src/main/launchers/epic/adapter';
import { fingerprintOf, planSessionWrite, readSessionFromIni, serializeBlob, sessionBlobFromIni } from '../src/main/launchers/epic/session';
import { EpicSim } from '../src/main/launchers/sim/epic';
import type { AccountRef } from '../src/main/launchers/types';
import { ProcessAccessDeniedError, StaticProcessController } from '../src/main/platform/processes';
import { StaticRegistry } from '../src/main/platform/registry';
import { migrate, openDatabase } from '../src/main/db';
import { AccountsService } from '../src/main/services/accounts';
import { BackupService } from '../src/main/services/backup';
import { accountDirectory, accountRef } from '../src/main/services/launchers';
import { createLogger } from '../src/main/services/logger';
import { LauncherSessionStore } from '../src/main/services/sessions';
import type { Account, EpicLaunchUriForm, JobStep, LaunchAttention } from '../src/shared/models';
import { FakeVault } from './helpers/fake-vault';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'epic', name), 'utf8');
const ID2 = '22222222222222222222222222222222';
const ID3 = '33333333333333333333333333333333';
const ID4 = '44444444444444444444444444444444';

let root: string;
let launcherDir: string;
let programData: string;
let localAppData: string;
let iniPath: string;
let manifestsDir: string;
let registry: StaticRegistry;
let processes: StaticProcessController;
let sim: EpicSim;
let backups: BackupService;
let opened: string[];
let uriForm: EpicLaunchUriForm;
let accounts: AccountsService;
let sessions: LauncherSessionStore;
let A: Account;
let B: Account;
let C: Account;
let dataA: string;
let dataB: string;

/** Stands in for the user signing in on the launcher's page once One Launch asks. */
function userSignsInWhenAsked(
  as: string,
  opts: { writeIni?: boolean } = {},
): { seen: (LaunchAttention | null)[]; onAttention: (a: LaunchAttention | null) => void } {
  const seen: (LaunchAttention | null)[] = [];
  return {
    seen,
    onAttention: (a) => {
      seen.push(a);
      if (a) setTimeout(() => sim.signInByHand(as, opts), 5);
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'onelaunch-epic-'));
  launcherDir = join(root, 'Epic Games', 'Launcher');
  programData = join(root, 'ProgramData');
  localAppData = join(root, 'Local');
  iniPath = join(localAppData, 'EpicGamesLauncher', 'Saved', 'Config', 'Windows', 'GameUserSettings.ini');
  manifestsDir = join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  mkdirSync(join(launcherDir, 'Portal', 'Binaries', 'Win64'), { recursive: true });
  writeFileSync(join(launcherDir, 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'), '');
  mkdirSync(manifestsDir, { recursive: true });
  writeFileSync(join(manifestsDir, 'A0000000000000000000000000000001.item'), fixture('A0000000000000000000000000000001.item'));
  mkdirSync(join(programData, 'Epic', 'UnrealEngineLauncher'), { recursive: true });
  writeFileSync(join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'), fixture('LauncherInstalled.dat'));
  mkdirSync(join(localAppData, 'EpicGamesLauncher', 'Saved', 'Config', 'Windows'), { recursive: true });
  writeFileSync(iniPath, fixture('GameUserSettings.ini'));

  registry = new StaticRegistry(EpicSim.defaultRegistry({ installLocation: join(root, 'Epic Games'), programData }));
  processes = new StaticProcessController();
  sim = new EpicSim({ localAppData, processes });
  processes.onStart = (exe, args) => sim.onStart(exe, args);
  sim.writeLog(fixture('EpicGamesLauncher.log').trimEnd().split('\r\n'));
  opened = [];
  uriForm = 'catalog';

  const db = openDatabase(':memory:');
  migrate(db);
  const vault = new FakeVault();
  backups = new BackupService(join(root, 'backups'), { keep: () => 20, vault });
  accounts = new AccountsService(db, vault);
  sessions = new LauncherSessionStore(db, vault);
  A = accounts.create({ launcher: 'epic', displayName: 'Main', login: 'main@example.com', launcherUid: ID3, password: 'pw-a' });
  B = accounts.create({ launcher: 'epic', displayName: 'Alt', login: 'alt@example.com', launcherUid: ID2 });
  C = accounts.create({ launcher: 'epic', displayName: 'New', login: 'new@example.com', password: 'pw-c' });
  const onDisk = sessionBlobFromIni(fixture('GameUserSettings.ini'))!;
  dataA = onDisk.rememberMe.data;
  sessions.save({ accountId: A.id, launcher: 'epic', launcherUid: ID3, fingerprint: fingerprintOf(dataA), blob: serializeBlob(onDisk) });
  dataB = Buffer.from(`blob-for-alt-${'b'.repeat(60)}`).toString('base64');
  sessions.save({
    accountId: B.id,
    launcher: 'epic',
    launcherUid: ID2,
    fingerprint: fingerprintOf(dataB),
    blob: serializeBlob({ v: 1, rememberMe: { enable: 'True', data: dataB }, offline: { data: Buffer.from('offline-for-alt'.repeat(4)).toString('base64') } }),
  });
  sim.servers.set(dataA, ID3);
  sim.servers.set(dataB, ID2);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const adapter = (
  defaultInstallDir = join(root, 'nowhere'),
  timing: { shutdownMs?: number; restartWatchMs?: number; cleanExitWatchMs?: number; manualSignInMs?: number } = {},
) =>
  new EpicAdapter({
    registry,
    processes,
    backups,
    sessions,
    accounts: accountDirectory(accounts, 'epic'),
    log: createLogger('test:epic'),
    backupsToKeep: () => 20,
    openExternal: async (url) => {
      opened.push(url);
    },
    launchUriForm: () => uriForm,
    localAppData,
    programData,
    defaultInstallDir,
    timing: {
      pollMs: 1,
      shutdownMs: 40,
      killGraceMs: 20,
      restartWatchMs: 25,
      restartSettleMs: 60,
      startupMs: 40,
      signInMs: 40,
      manualSignInMs: 80,
      captureMs: 40,
      readyGraceMs: 0,
      cleanExitWatchMs: 10,
      ...timing,
    },
  });

const ref = (a: Account): AccountRef => accountRef(accounts.require(a.id));
const statusOf = (steps: readonly JobStep[]): [string, string][] => steps.map((s) => [s.title, s.status]);
const noBlobs = (text: string): void => {
  expect(text).not.toContain(dataA);
  expect(text).not.toContain(dataB);
};

// ---------------------------------------------------------------------------
// Read-only surface.
// ---------------------------------------------------------------------------

describe('EpicAdapter.detectInstall', () => {
  it('uses the Uninstall key, then the URI handler command, then the default location', async () => {
    const expected = {
      launcher: 'epic',
      installDir: launcherDir,
      exePath: join(launcherDir, 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'),
      source: 'registry-hklm',
    };
    expect(await adapter().detectInstall()).toEqual(expected);
    registry.delete(`HKLM\\${EPIC_UNINSTALL_KEY}\\InstallLocation`);
    expect(await adapter().detectInstall()).toEqual(expected);
    registry.delete(`HKLM\\${EPIC_URI_COMMAND_KEY}\\`);
    expect(await adapter().detectInstall()).toBeNull();
    expect((await adapter(launcherDir).detectInstall())?.source).toBe('default-path');
  });

  it('looks in the folder chosen in Settings first, and says so when the launcher is no longer in it', async () => {
    const moved = join(root, 'Elsewhere', 'Launcher');
    const movedExe = join(moved, 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe');
    mkdirSync(join(moved, 'Portal', 'Binaries', 'Win64'), { recursive: true });
    mkdirSync(join(moved, 'Portal', 'Binaries', 'Win32'), { recursive: true });
    writeFileSync(movedExe, '');
    writeFileSync(join(moved, 'Portal', 'Binaries', 'Win32', 'EpicGamesLauncher.exe'), '');
    const base = adapter();
    const epic = new EpicAdapter({ ...(base as unknown as { deps: ConstructorParameters<typeof EpicAdapter>[0] }).deps, installDir: () => moved });

    expect(await epic.detectInstall()).toEqual({ launcher: 'epic', installDir: moved, exePath: movedExe, source: 'user' });
    expect((await epic.healthCheck()).checks.find((c) => c.id === 'install')?.detail).toBe(`${moved} (from the folder chosen in Settings)`);
    expect(base.installFromExe(movedExe)).toEqual({ launcher: 'epic', installDir: moved, exePath: movedExe, source: 'user' });
    expect(base.installFromExe(join(moved, 'Portal', 'Binaries', 'Win32', 'EpicGamesLauncher.exe'))?.exePath).toBe(movedExe);
    writeFileSync(join(moved, 'Portal', 'Binaries', 'Win64', 'UnrealCEFSubProcess.exe'), '');
    expect(base.installFromExe(join(moved, 'Portal', 'Binaries', 'Win64', 'UnrealCEFSubProcess.exe'))).toBeNull();

    rmSync(movedExe);
    expect((await epic.detectInstall())?.source).toBe('registry-hklm');
    expect((await epic.healthCheck()).checks.find((c) => c.id === 'chosen-folder')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining(`EpicGamesLauncher.exe is no longer in ${moved}`),
    });
    expect(base.installFromExe(movedExe)).toBeNull();
  });
});

describe('EpicAdapter.listInstalledGames', () => {
  it('lists library games from .item manifests with normalized paths, skipping incomplete and broken ones', async () => {
    writeFileSync(
      join(manifestsDir, 'B0000000000000000000000000000002.item'),
      fixture('A0000000000000000000000000000001.item')
        .replace('"bIsIncompleteInstall": false', '"bIsIncompleteInstall": true')
        .replace('"AppName": "Sugar"', '"AppName": "Half"'),
    );
    writeFileSync(join(manifestsDir, 'C0000000000000000000000000000003.item'), '{ not json');
    writeFileSync(join(manifestsDir, 'notes.txt'), 'ignored');
    const games = await adapter().listInstalledGames();
    expect(games).toEqual([
      {
        launcher: 'epic',
        launcherGameId: 'Sugar',
        name: 'Rocket League®',
        installPath: 'D:\\Placeholder\\Epic Games\\rocketleague',
        libraryPath: 'D:\\Placeholder\\Epic Games',
        sizeOnDiskBytes: 42793420249,
        lastPlayedAt: null,
        needsUpdate: false,
      },
    ]);
  });

  it('returns nothing when the manifests folder is missing, and NOT_INSTALLED without the launcher', async () => {
    rmSync(manifestsDir, { recursive: true });
    expect(await adapter().listInstalledGames()).toEqual([]);
    registry.delete(`HKLM\\${EPIC_UNINSTALL_KEY}\\InstallLocation`);
    registry.delete(`HKLM\\${EPIC_URI_COMMAND_KEY}\\`);
    await expect(adapter().listInstalledGames()).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });
});

describe('EpicAdapter.listRememberedAccounts and sessionState', () => {
  it('lists every account id that signed in here, marking the remembered one and its linked account', async () => {
    const list = await adapter().listRememberedAccounts();
    expect(list).toHaveLength(4);
    expect(list[0]).toEqual({
      launcher: 'epic',
      launcherUid: ID3,
      login: 'main@example.com',
      personaName: 'Main',
      rememberPassword: true,
      mostRecent: true,
      lastLoginAt: null,
      sessionMayBeExpired: false,
    });
    expect(list.slice(1).every((e) => !e.rememberPassword && !e.mostRecent)).toBe(true);
    expect(list.find((e) => e.launcherUid === ID2)).toMatchObject({ login: 'alt@example.com', personaName: 'Alt' });
    expect(list.find((e) => e.launcherUid === ID4)).toMatchObject({ login: '', personaName: '' });
  });

  it('reports what the launcher remembers and whose it is, by fingerprint first and the log second', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    const state = await adapter().sessionState();
    expect(state).toEqual({
      launcher: 'epic',
      remembered: true,
      fingerprint: fingerprintOf(dataA),
      launcherUid: ID3,
      linkedAccountId: A.id,
      launcherRunning: true,
      lastSignIn: { ok: true, reason: null },
    });

    // Unknown blob on disk, log says ID3: linked to A through its launcher id.
    const fresh = sim.freshBlob();
    writeFileSync(iniPath, planSessionWrite(readFileSync(iniPath, 'utf8'), { v: 1, rememberMe: { enable: 'True', data: fresh }, offline: null }).text);
    expect(await adapter().sessionState()).toMatchObject({ remembered: true, fingerprint: fingerprintOf(fresh), launcherUid: ID3, linkedAccountId: A.id });

    // Signed out on disk while the launcher still runs signed in: the log wins for the id, the file for "remembered".
    writeFileSync(iniPath, planSessionWrite(readFileSync(iniPath, 'utf8'), null).text);
    expect(await adapter().sessionState()).toMatchObject({ remembered: false, fingerprint: null, launcherUid: ID3, linkedAccountId: A.id });
    processes.setRunning('EpicGamesLauncher.exe', false);
    expect(await adapter().sessionState()).toMatchObject({ remembered: false, fingerprint: null, launcherUid: null, linkedAccountId: null });

    // Failed sign-in in the log.
    sim.writeLog(fixture('EpicGamesLauncher-expired-then-manual.log').trimEnd().split('\r\n').slice(0, 3));
    expect((await adapter().sessionState()).lastSignIn).toEqual({
      ok: false,
      reason: "Sorry the refresh token '…' is invalid. Reason: TOKEN_EXPIRED errorcode=18036",
    });
  });
});

describe('EpicAdapter.captureSession', () => {
  it('stores the current session for its owner, refuses it for another account, and needs a remembered session', async () => {
    sessions.delete(A.id);
    const captured = await adapter().captureSession(ref(A));
    expect(captured.launcherUid).toBe(ID3);
    expect(captured.session).toMatchObject({ accountId: A.id, launcherUid: ID3, fingerprint: fingerprintOf(dataA), staleReason: null });
    expect(sessions.decrypt(A.id)).toContain(dataA);

    await expect(adapter().captureSession(ref(C))).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: /belongs to Main/ });

    // Nobody owns it (A loses its id and snapshot): a new account adopts it and gets the id from the log.
    sessions.delete(A.id);
    accounts.update(A.id, { launcherUid: null });
    const adopted = await adapter().captureSession(ref(C));
    expect(adopted.launcherUid).toBe(ID3);
    expect(accounts.require(C.id).launcherUid).toBe(ID3);

    // An account linked to a different id cannot take it.
    await expect(adapter().captureSession(ref(B))).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: /linked to …222222/ });

    writeFileSync(iniPath, planSessionWrite(readFileSync(iniPath, 'utf8'), null).text);
    await expect(adapter().captureSession(ref(C))).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: /not remembering a session/ });
    await expect(adapter().captureSession({ ...ref(C), id: null })).rejects.toMatchObject({ code: 'SWITCH_BLOCKED' });
  });

  it('stores nothing when the id the log names is held by another account', async () => {
    // Nobody owns the file by fingerprint and it predates the last sign-in, so only the log's id is left to go by.
    sessions.delete(A.id);
    sim.writeLog(['Log file open, run x', `[2026.09.13-00.09.05:354][713]FAccountService::OnLoginComplete - 0 TRUE ${ID3} `]);
    utimesSync(iniPath, new Date('2026-09-13T00:00:00Z'), new Date('2026-09-13T00:00:00Z'));
    await expect(adapter().captureSession(ref(C))).rejects.toMatchObject({ code: 'DUPLICATE', message: /"Main" is already linked/ });
    expect(sessions.get(C.id)).toBeNull();
    expect(accounts.require(C.id).launcherUid).toBeNull();
  });

  it('while the launcher runs, trusts its log over the file and refuses a sign-in it has not saved yet', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    // The file holds Main's blob, but this run signed in as an account nobody has linked (seen 2026-09-13).
    sim.writeLog([
      'Log file open, run x',
      '[2026.09.13-00.09.05:172][702]FAccountService::SignIn (exchange code)',
      `[2026.09.13-00.09.05:354][713]FAccountService::OnLoginComplete - 0 TRUE ${ID4} `,
    ]);
    await expect(adapter().captureSession(ref(A))).rejects.toMatchObject({
      code: 'SWITCH_BLOCKED',
      message: /last sign-in was Epic account …444444, but Main is linked to …333333/,
    });
    expect((await adapter().sessionState()).linkedAccountId).toBeNull();

    // The file predates that sign-in: the launcher has not written the new session yet.
    utimesSync(iniPath, new Date('2026-09-13T00:00:00Z'), new Date('2026-09-13T00:00:00Z'));
    await expect(adapter().captureSession(ref(C))).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: /not saved its current sign-in to disk yet/ });

    // Written after the sign-in: it is that account's session, and C adopts it with the id.
    utimesSync(iniPath, new Date('2026-09-13T00:10:00Z'), new Date('2026-09-13T00:10:00Z'));
    const adopted = await adapter().captureSession(ref(C));
    expect(adopted.launcherUid).toBe(ID4);
    expect(accounts.require(C.id).launcherUid).toBe(ID4);

    // No sign-in in the current run (sign-in page): nothing to capture, whatever the file says.
    sim.writeLog(['Log file open, run y', '[2026.09.13-00.12.00:000][  0]FAccountService::AutoSignIn']);
    await expect(adapter().captureSession(ref(C))).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: /has not signed in during this run/ });
  });
});

describe('EpicAdapter.healthCheck', () => {
  it('is all green on the expected layout and never includes a blob', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    const report = await adapter().healthCheck();
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ['install', 'ok'],
      ['process', 'ok'],
      ['manifests', 'ok'],
      ['launcher-installed', 'ok'],
      ['settings', 'ok'],
      ['log', 'ok'],
      ['sessions', 'ok'],
      ['backups', 'ok'],
    ]);
    expect(report.status).toBe('ok');
    expect(report.checks.find((c) => c.id === 'settings')?.detail).toBe('4 accounts have signed in on this PC; remembered session belongs to Main');
    expect(report.checks.find((c) => c.id === 'sessions')?.detail).toBe('2 snapshots stored');
    noBlobs(JSON.stringify(report));
  });

  it('warns on a missing manifests folder, a failed sign-in, and stale snapshots', async () => {
    rmSync(manifestsDir, { recursive: true });
    sessions.markStale(B.id, 'TOKEN_EXPIRED');
    sim.writeLog(fixture('EpicGamesLauncher-expired-then-manual.log').trimEnd().split('\r\n').slice(0, 3));
    const report = await adapter().healthCheck();
    expect(report.status).toBe('warn');
    expect(report.checks.filter((c) => c.status === 'warn').map((c) => c.id)).toEqual(['manifests', 'log', 'sessions']);
  });
});

// ---------------------------------------------------------------------------
// Dry run.
// ---------------------------------------------------------------------------

describe('EpicAdapter.switchAccount (dry run)', () => {
  it('plans the remembered path for a stored snapshot without decrypting or touching anything', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    const before = { text: readFileSync(iniPath, 'utf8'), mtime: statSync(iniPath).mtimeMs };

    const plan = await adapter().switchAccount(ref(B), { dryRun: true });

    expect(plan.strategy).toBe('remembered');
    expect(plan.executable).toBe(true);
    expect(plan.current).toEqual({ mostRecentLogin: 'main@example.com', autoLoginUser: null, running: true });
    expect(plan.account.launcherUid).toBe(ID2);
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
    expect(plan.steps[3]!.changes.map((c) => c.where)).toEqual(['[RememberMe] Enable', '[RememberMe] Data', '[Offline] Data']);
    expect(plan.steps[3]!.changes[1]!.before).toBe(`(128 characters, fingerprint ${fingerprintOf(dataA).slice(0, 8)})`);
    expect(plan.steps[3]!.changes[1]!.after).toMatch(new RegExp(`^\\(stored snapshot, fingerprint ${fingerprintOf(dataB).slice(0, 8)}, captured `));
    expect(plan.warnings).toEqual(['Epic Games Launcher is running as Main. It will be closed, along with any game running under it.']);
    noBlobs(JSON.stringify(plan));

    expect(readFileSync(iniPath, 'utf8')).toBe(before.text);
    expect(statSync(iniPath).mtimeMs).toBe(before.mtime);
    expect(processes.events).toEqual([]);
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('treats the account whose session is already on disk as active', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    const plan = await adapter().switchAccount(ref(A), { dryRun: true });
    expect(plan.strategy).toBe('remembered');
    expect(plan.steps.every((s) => s.skipped)).toBe(true);
    expect(plan.notes[0]).toMatch(/running and signed in as Main/);
    expect(plan.warnings).toEqual([]);

    // Same file, but the running launcher signed in by hand as an unlinked account: not active after all.
    sim.writeLog(['Log file open, run x', `[2026.09.13-00.09.05:354][713]FAccountService::OnLoginComplete - 0 TRUE ${ID4} `]);
    const stale = await adapter().switchAccount(ref(A), { dryRun: true });
    expect(stale.steps.map((s) => [s.id, s.skipped]).slice(0, 4)).toEqual([
      ['close', false],
      ['capture', true],
      ['backup', false],
      ['file', false],
    ]);
    expect(stale.warnings.some((w) => w.includes('not linked to any One Launch account'))).toBe(true);
    sim.writeLog(fixture('EpicGamesLauncher.log').trimEnd().split('\r\n'));

    processes.setRunning('EpicGamesLauncher.exe', false);
    const closed = await adapter().switchAccount(ref(A), { dryRun: true });
    expect(closed.notes[0]).toMatch(/already remembers Main's session, so it is only started/);
    expect(closed.warnings).toEqual([]);
    expect(closed.steps.map((s) => [s.id, s.skipped])).toEqual([
      ['close', true],
      ['capture', true],
      ['backup', true],
      ['file', true],
      ['start', false],
      ['wait', false],
      ['verify', false],
      ['manual', true],
      ['recapture', true],
    ]);
  });

  it('plans the credentials path (sign out, manual sign-in, capture) for an account without a snapshot', async () => {
    const plan = await adapter().switchAccount(ref(C), { dryRun: true });
    expect(plan.strategy).toBe('credentials');
    expect(plan.executable).toBe(true);
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
    expect(plan.steps[3]!.title).toBe('Sign the launcher out');
    expect(plan.steps[3]!.changes.map((c) => c.after)).toEqual(['True', '(removed)', '(removed)']);
    expect(plan.warnings[0]).toMatch(/^No session snapshot is stored for New yet/);
    noBlobs(JSON.stringify(plan));

    sessions.markStale(B.id, 'TOKEN_EXPIRED');
    const stale = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(stale.strategy).toBe('credentials');
    expect(stale.warnings.some((w) => w.includes('rejected by the launcher (TOKEN_EXPIRED)'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real switch, against temp copies only.
// ---------------------------------------------------------------------------

describe('EpicAdapter.switchAccount (real)', () => {
  it('closes the launcher, backs up, swaps [RememberMe] and [Offline], restarts, and confirms the sign-in from the log', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    const original = readFileSync(iniPath, 'utf8');
    const progress: [string, string][][] = [];

    const result = await adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true, onProgress: (s) => progress.push(statusOf(s)) });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.restored).toBeNull();
    expect(result.readyAt).not.toBeNull();
    expect(statusOf(result.steps)).toEqual([
      ['Close Epic Games Launcher', 'done'],
      ['Save the outgoing session', 'done'],
      ['Back up GameUserSettings.ini', 'done'],
      ["Put the account's session in place", 'done'],
      ['Start Epic Games Launcher', 'done'],
      ['Wait for the launcher to come up', 'done'],
      ['Confirm the launcher signed in', 'done'],
      ['Wait for you to sign in', 'skipped'],
      ['Save the new session', 'skipped'],
    ]);
    expect(result.steps[1]!.detail).toBe("Main's stored session is already current.");
    expect(result.steps[6]!.detail).toBe('Signed in as alt@example.com.');
    expect(progress[0]![0]).toEqual(['Close Epic Games Launcher', 'running']);
    noBlobs(JSON.stringify(result));

    expect(processes.events.map((e) => [e.kind, e.args])).toEqual([
      ['close', []],
      ['start', []],
    ]);
    expect(await processes.isRunning('EpicGamesLauncher.exe')).toBe(true);

    const after = readSessionFromIni(readFileSync(iniPath, 'utf8'));
    expect(after).toMatchObject({ remembered: true, enable: 'True', data: dataB });
    expect(after.offlineData).toBe(Buffer.from('offline-for-alt'.repeat(4)).toString('base64'));
    expect(readFileSync(iniPath, 'utf8').split('\r\n').length).toBe(original.split('\r\n').length);

    expect(result.backupId).not.toBeNull();
    const snapshot = backups.get('epic', result.backupId!)!;
    expect(snapshot.files).toEqual(['Config/Windows/GameUserSettings.ini']);
    expect(snapshot.reason).toBe('Before switching to Alt');
    expect(backups.readFile('epic', snapshot.id, 'Config/Windows/GameUserSettings.ini').toString('utf8')).toBe(original);
    // The stored copy is ciphertext: nothing under backups/ holds the bearer blob in the clear.
    expect(existsSync(join(snapshot.path, 'Config', 'Windows', 'GameUserSettings.ini'))).toBe(false);
    expect(readFileSync(join(snapshot.path, 'Config', 'Windows', 'GameUserSettings.ini.enc'), 'latin1')).not.toContain(original);
    expect(sessions.get(B.id)?.verifiedAt).not.toBeNull();
  });

  it("saves the outgoing account's rotated session before replacing it", async () => {
    sim.knobs.rotateOnStart = true;
    const first = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(first.ok).toBe(true);
    const rotated = readSessionFromIni(readFileSync(iniPath, 'utf8'));
    expect(rotated.data).not.toBe(dataB);
    expect(sessions.get(B.id)?.fingerprint).toBe(fingerprintOf(dataB));

    const second = await adapter().switchAccount(ref(A), { dryRun: false, confirmClose: true });
    expect(second.ok).toBe(true);
    expect(second.steps[1]!.detail).toBe(`Saved Alt's session (fingerprint ${rotated.fingerprint!.slice(0, 8)}).`);
    expect(sessions.get(B.id)?.fingerprint).toBe(rotated.fingerprint);
    expect(sessions.decrypt(B.id)).toContain(rotated.data);
    expect(readSessionFromIni(readFileSync(iniPath, 'utf8')).data).not.toBe(dataA);
  });

  it('adopts an unowned on-disk session for the account the log names, without rewriting the file', async () => {
    sessions.delete(A.id);
    const before = readFileSync(iniPath, 'utf8');
    const result = await adapter().switchAccount(ref(A), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(statusOf(result.steps).slice(0, 4)).toEqual([
      ['Close Epic Games Launcher', 'skipped'],
      ["Save this account's session", 'done'],
      ['Back up GameUserSettings.ini', 'skipped'],
      ["Put the account's session in place", 'skipped'],
    ]);
    expect(readFileSync(iniPath, 'utf8')).toBe(before);
    expect(sessions.get(A.id)?.fingerprint).toBe(fingerprintOf(dataA));
    expect(backups.list('epic')).toEqual([]);
  });

  it('hands over to the user when the launcher rejects the snapshot, then stores the fresh session', async () => {
    sim.knobs.expired.push(dataB);
    const user = userSignsInWhenAsked(ID2);
    const result = await adapter().switchAccount(ref(B), { dryRun: false, onAttention: user.onAttention });

    expect(result.ok).toBe(true);
    expect(statusOf(result.steps).slice(6)).toEqual([
      ['Confirm the launcher signed in', 'failed'],
      ['Wait for you to sign in', 'done'],
      ['Save the new session', 'done'],
    ]);
    expect(result.steps[6]!.detail).toBe("The launcher rejected the session: Sorry the refresh token '…' is invalid. Reason: TOKEN_EXPIRED errorcode=18036.");
    expect(user.seen[0]).toMatchObject({ kind: 'sign-in', title: 'Epic Games Launcher is asking you to sign in as alt@example.com', canCopyPassword: false });
    expect(user.seen[0]!.message).toMatch(/^Its remembered session has expired\./);
    expect(user.seen[1]).toBeNull();
    const stored = sessions.get(B.id)!;
    expect(stored.staleReason).toBeNull();
    expect(stored.verifiedAt).not.toBeNull();
    expect(stored.fingerprint).not.toBe(fingerprintOf(dataB));
    expect(stored.fingerprint).toBe(readSessionFromIni(readFileSync(iniPath, 'utf8')).fingerprint);
  });

  it('marks the snapshot stale only when the launcher refused the session itself, not on a service failure', async () => {
    sim.knobs.expired.push(dataB);
    const refused = await adapter(undefined, { manualSignInMs: 20 }).switchAccount(ref(B), { dryRun: false });
    expect(refused.needsSignIn).toBe(true);
    expect(sessions.get(B.id)!.staleReason).toMatch(/TOKEN_EXPIRED/);

    // The same switch for the other account during an outage: handed over just the same, but its snapshot is still good.
    processes.setRunning('EpicGamesLauncher.exe', false);
    sim.knobs.signInError = 'Service unavailable. Please try again later. errorcode=503 errorpath=x';
    const seen: (LaunchAttention | null)[] = [];
    const outage = await adapter(undefined, { manualSignInMs: 20 }).switchAccount(ref(A), { dryRun: false, onAttention: (a) => seen.push(a) });
    expect(outage.needsSignIn).toBe(true);
    expect(outage.steps[6]).toMatchObject({
      status: 'failed',
      detail: 'The launcher rejected the session: Service unavailable. Please try again later. errorcode=503.',
    });
    expect(seen[0]!.message).toMatch(/^The launcher did not sign in on its own \(Service unavailable/);
    expect(sessions.get(A.id)!.staleReason).toBeNull();
    const next = await adapter().switchAccount(ref(A), { dryRun: true });
    expect(next.strategy).toBe('remembered');
  });

  it('runs the credentials path: signs the launcher out, waits for the sign-in, links the id, captures the session', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    const user = userSignsInWhenAsked(ID4);
    const result = await adapter().switchAccount(ref(C), { dryRun: false, confirmClose: true, onAttention: user.onAttention, getPassword: () => 'pw-c' });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('credentials');
    expect(statusOf(result.steps)).toEqual([
      ['Close Epic Games Launcher', 'done'],
      ['Save the outgoing session', 'done'],
      ['Back up GameUserSettings.ini', 'done'],
      ['Sign the launcher out', 'done'],
      ['Start Epic Games Launcher', 'done'],
      ['Wait for the launcher to come up', 'done'],
      ['Confirm the launcher signed in', 'failed'],
      ['Wait for you to sign in', 'done'],
      ['Save the new session', 'done'],
    ]);
    expect(user.seen[0]).toMatchObject({ title: 'Sign in to Epic Games Launcher as new@example.com', canCopyPassword: true });
    expect(result.steps[7]!.detail).toBe('Signed in as new@example.com. Linked to Epic Games account …4444.');
    expect(accounts.require(C.id).launcherUid).toBe(ID4);
    expect(sessions.get(C.id)).toMatchObject({ launcherUid: ID4, staleReason: null });
    expect(sessions.get(C.id)?.verifiedAt).not.toBeNull();

    // Next time it is the remembered path, already in place.
    const again = await adapter().switchAccount(ref(C), { dryRun: true });
    expect(again.strategy).toBe('remembered');
    expect(again.steps.every((s) => s.skipped)).toBe(true);
  });

  it('leaves the session to the next switch when the launcher has not written it yet', async () => {
    const user = userSignsInWhenAsked(ID4, { writeIni: false });
    const result = await adapter().switchAccount(ref(C), { dryRun: false, onAttention: user.onAttention });
    expect(result.ok).toBe(true);
    expect(result.steps[8]!.detail).toBe('The launcher has not written the new session yet; it is saved at the next switch.');
    expect(accounts.require(C.id).launcherUid).toBe(ID4);
    expect(sessions.get(C.id)).toBeNull();
  });

  it('fails and rolls back when the user signs in as a different account than the one linked', async () => {
    const original = readFileSync(iniPath, 'utf8');
    accounts.update(C.id, { launcherUid: ID4 });
    const user = userSignsInWhenAsked(ID3);
    const result = await adapter().switchAccount(ref(C), { dryRun: false, onAttention: user.onAttention });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signed in as Main \(account …333333\) instead of New \(…444444\)/);
    expect(result.restored).toBe(true);
    expect(readFileSync(iniPath, 'utf8')).toBe(original);
    expect(await processes.isRunning('EpicGamesLauncher.exe')).toBe(false);
    expect(sessions.get(C.id)).toBeNull();
  });

  it('rolls back, naming the account, when an account without an id signs in as an id another account holds', async () => {
    const original = readFileSync(iniPath, 'utf8');
    const user = userSignsInWhenAsked(ID3);
    const result = await adapter().switchAccount(ref(C), { dryRun: false, onAttention: user.onAttention });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(
      /signed in as Main \(account …333333\), which is another One Launch account, instead of New\. Sign in to the launcher as new@example\.com\./,
    );
    expect(result.restored).toBe(true);
    expect(result.steps[7]).toMatchObject({ status: 'failed', detail: 'Signed in as a different account.' });
    expect(readFileSync(iniPath, 'utf8')).toBe(original);
    expect(await processes.isRunning('EpicGamesLauncher.exe')).toBe(false);
    expect(accounts.require(C.id).launcherUid).toBeNull();
    expect(accounts.require(A.id).launcherUid).toBe(ID3);
    expect(sessions.get(C.id)).toBeNull();
    expect(sessions.get(A.id)?.fingerprint).toBe(fingerprintOf(dataA));
  });

  it('matches the signed-in id to its account whatever the case the id was typed in', async () => {
    accounts.update(B.id, { launcherUid: 'ABCDEF00ABCDEF00ABCDEF00ABCDEF00' });
    const user = userSignsInWhenAsked('abcdef00abcdef00abcdef00abcdef00');
    const result = await adapter().switchAccount(ref(C), { dryRun: false, onAttention: user.onAttention });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signed in as Alt /);
    expect(accounts.require(C.id).launcherUid).toBeNull();
  });

  it('reports cancelled when the user stops waiting, rolling nothing back', async () => {
    sim.knobs.expired.push(dataB);
    const controller = new AbortController();
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      signal: controller.signal,
      onAttention: (a) => {
        if (a) setTimeout(() => controller.abort(), 5);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.restored).toBeNull();
    expect(readSessionFromIni(readFileSync(iniPath, 'utf8')).data).toBe(dataB);
    expect(sessions.get(B.id)?.staleReason).toBe("Sorry the refresh token '…' is invalid. Reason: TOKEN_EXPIRED errorcode=18036");
  });

  /** Aborts the moment the step with this title reaches `status`, the way a quit lands in the middle of a switch. */
  const abortWhen = (title: string, status: JobStep['status']): { signal: AbortSignal; onProgress: (steps: readonly JobStep[]) => void } => {
    const controller = new AbortController();
    return {
      signal: controller.signal,
      onProgress: (steps) => {
        if (steps.some((s) => s.title === title && s.status === status)) controller.abort();
      },
    };
  };
  const slowAdapter = (timing: Record<string, number>): EpicAdapter =>
    new EpicAdapter({
      ...(adapter() as unknown as { deps: ConstructorParameters<typeof EpicAdapter>[0] }).deps,
      timing: {
        pollMs: 1,
        shutdownMs: 40,
        killGraceMs: 20,
        restartWatchMs: 25,
        restartSettleMs: 60,
        startupMs: 40,
        signInMs: 40,
        manualSignInMs: 80,
        ...timing,
      },
    });

  it('reports the snapshot, already on disk, before the first write', async () => {
    const original = readFileSync(iniPath, 'utf8');
    let seen: { id: string; file: string; listed: string[] } | null = null;
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      onBackup: (id) => {
        seen = { id, file: readFileSync(iniPath, 'utf8'), listed: backups.list('epic').map((s) => s.id) };
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ id: result.backupId, file: original, listed: [result.backupId] });
    expect(readFileSync(iniPath, 'utf8')).not.toBe(original);
  });

  it('an abort while the launcher is closing stops at once with nothing changed', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    processes.shutdownPolls = 1_000_000;
    const original = readFileSync(iniPath, 'utf8');
    const result = await slowAdapter({ shutdownMs: 5_000 }).switchAccount(ref(B), {
      dryRun: false,
      confirmClose: true,
      ...abortWhen('Close Epic Games Launcher', 'running'),
    });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: null, backupId: null });
    expect(result.error).toBe('Stopped before Epic Games Launcher was started as alt@example.com. Nothing had been changed.');
    expect(processes.events.map((e) => e.kind)).toEqual(['close']);
    expect(readFileSync(iniPath, 'utf8')).toBe(original);
    expect(backups.list('epic')).toEqual([]);
  });

  it('an abort after the write but before the launcher is started puts the file back', async () => {
    const original = readFileSync(iniPath, 'utf8');
    const result = await adapter().switchAccount(ref(B), { dryRun: false, ...abortWhen("Put the account's session in place", 'done') });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: true });
    expect(result.error).toBe('Stopped before Epic Games Launcher was started as alt@example.com.');
    expect(readFileSync(iniPath, 'utf8')).toBe(original);
    expect(processes.events).toEqual([]);
  });

  it('an abort once the launcher has been started ends the wait and leaves the write alone', async () => {
    processes.startFails = true;
    const result = await slowAdapter({ startupMs: 5_000 }).switchAccount(ref(B), {
      dryRun: false,
      ...abortWhen('Wait for the launcher to come up', 'running'),
    });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: null });
    expect(result.error).toBe(
      'Stopped while Epic Games Launcher was starting as alt@example.com. Nothing was rolled back: the launcher carries on signing in on its own.',
    );
    expect(readSessionFromIni(readFileSync(iniPath, 'utf8')).data).toBe(dataB);
  });

  it('an abort after the sign-in is confirmed cuts the capture wait and the grace short; the switch still counts', async () => {
    const user = userSignsInWhenAsked(ID4, { writeIni: false });
    const started = Date.now();
    const result = await slowAdapter({ captureMs: 5_000, readyGraceMs: 5_000 }).switchAccount(ref(C), {
      dryRun: false,
      onAttention: user.onAttention,
      ...abortWhen('Save the new session', 'running'),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ok).toBe(true);
    expect(result.steps[8]!.detail).toBe('The launcher has not written the new session yet; it is saved at the next switch.');
    expect(accounts.require(C.id).launcherUid).toBe(ID4);
  });

  it('ends in needs-sign-in when the manual wait runs out', async () => {
    const result = await adapter().switchAccount(ref(C), { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.needsSignIn).toBe(true);
    expect(result.restored).toBeNull();
    expect(readSessionFromIni(readFileSync(iniPath, 'utf8')).remembered).toBe(false);
  });

  it('refuses to close a running launcher without confirmation, naming the running game', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    processes.processes = [{ name: 'RocketLeague', pid: 2, path: 'D:\\Placeholder\\Epic Games\\rocketleague\\Binaries\\Win64\\RocketLeague.exe' }];
    const err = await adapter()
      .switchAccount(ref(B), { dryRun: false })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'CONFIRM_REQUIRED',
      message: 'Epic Games Launcher is running Rocket League®. Switching closes the launcher and the game; unsaved progress in the game is lost.',
    });
    expect(readFileSync(iniPath, 'utf8')).toBe(fixture('GameUserSettings.ini'));
    expect(processes.events).toEqual([]);
    expect(await adapter().runningGame()).toMatchObject({ launcherGameId: 'Sugar', source: 'process' });
  });

  it('escalates to a forced kill when the window close is ignored, and fails before writing when the launcher will not die', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    processes.shutdownPolls = 1_000_000;
    const ok = await adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true });
    expect(ok.ok).toBe(true);
    expect(processes.events.map((e) => e.kind)).toEqual(['close', 'kill', 'start']);

    processes.events.length = 0;
    processes.kill = async () => {
      processes.events.push({ kind: 'kill', exe: 'EpicGamesLauncher.exe', args: [] });
    };
    processes.shutdownPolls = 1_000_000;
    const before = readFileSync(iniPath, 'utf8');
    const stuck = await adapter().switchAccount(ref(A), { dryRun: false, confirmClose: true });
    expect(stuck.ok).toBe(false);
    expect(stuck.error).toMatch(/still running/);
    expect(stuck.backupId).toBeNull();
    expect(readFileSync(iniPath, 'utf8')).toBe(before);
  });

  it('fails the close step at once, naming elevation, when Windows refuses to close the launcher', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    processes.close = async (image) => {
      throw new ProcessAccessDeniedError(image);
    };
    const before = readFileSync(iniPath, 'utf8');
    const started = Date.now();
    const result = await adapter(undefined, { shutdownMs: 2_000 }).switchAccount(ref(B), { dryRun: false, confirmClose: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ ok: false, restored: null, backupId: null });
    expect(result.error).toMatch(/^Windows would not let One Launch close EpicGamesLauncher\.exe\. It is most likely running as administrator/);
    expect(result.steps[0]).toMatchObject({ title: 'Close Epic Games Launcher', status: 'failed' });
    expect(readFileSync(iniPath, 'utf8')).toBe(before);
    expect(processes.events).toEqual([]);
  });

  it('waits out the launcher restarting itself after a close instead of killing it', async () => {
    processes.setRunning('EpicGamesLauncher.exe', true);
    let restarts = 1;
    const close = processes.close.bind(processes);
    processes.close = async (name) => {
      await close(name);
      if (restarts-- > 0) {
        // The real order (both restart logs on the author's PC): the exit request first, the restart line some thirty lines later.
        sim.appendLog([
          '[2026.09.13-00.04.23:950][620]LogCore: Engine exit requested (reason: Win RequestExit)',
          '[2026.09.13-00.04.24:088][628]Application: Restarting C:/x/EpicGamesUpdater.exe with command: start',
        ]);
        setTimeout(() => {
          processes.setRunning(name, true);
          sim.writeLog(['Log file open, restarted by the updater', '[..]LogInit: AllCheckComplete SelfUpdate=1 SignedIn=0 RequiresRestart=0']);
        }, 8);
      }
    };
    const original = readFileSync(iniPath, 'utf8');
    const result = await adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true });
    expect(result.ok).toBe(true);
    expect(processes.events.map((e) => e.kind)).toEqual(['close', 'close', 'start']);
    expect(backups.readFile('epic', result.backupId!, 'Config/Windows/GameUserSettings.ini').toString('utf8')).toBe(original);
  });

  it('watches only briefly for a restart when the log shows the launcher closed cleanly without announcing one', async () => {
    const slow = adapter(undefined, { restartWatchMs: 600, cleanExitWatchMs: 10 });
    const close = processes.close.bind(processes);
    processes.close = async (name) => {
      await close(name);
      sim.appendLog(['[2026.09.13-00.04.24:088][628]LogCore: Engine exit requested (reason: Win RequestExit)']);
    };
    processes.setRunning('EpicGamesLauncher.exe', true);
    let started = Date.now();
    await slow.shutdown();
    expect(Date.now() - started).toBeLessThan(400);

    // Killed, or a log that says nothing: the full watch, as before.
    processes.close = close;
    processes.setRunning('EpicGamesLauncher.exe', true);
    started = Date.now();
    await slow.shutdown();
    expect(Date.now() - started).toBeGreaterThanOrEqual(590);
  });

  it('treats Config\\WindowsEditor as the settings file when the launcher moved there, and writes both', async () => {
    // Seen 2026-09-12: the launcher started writing Saved\Config\WindowsEditor\GameUserSettings.ini and stopped reading the Windows one.
    const editorPath = join(localAppData, 'EpicGamesLauncher', 'Saved', 'Config', 'WindowsEditor', 'GameUserSettings.ini');
    mkdirSync(join(localAppData, 'EpicGamesLauncher', 'Saved', 'Config', 'WindowsEditor'), { recursive: true });
    const editorText = fixture('GameUserSettings.ini').replace('Enable=True', 'Enable=False');
    writeFileSync(editorPath, editorText);
    utimesSync(iniPath, new Date('2026-09-12T20:00:00Z'), new Date('2026-09-12T20:00:00Z'));
    expect(adapter().settingsPath()).toBe(editorPath);
    expect(adapter().settingsPaths()).toEqual([editorPath, iniPath]);

    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.warnings.some((w) => w.includes('Enable is False') && w.includes('WindowsEditor'))).toBe(true);
    expect(plan.steps[3]!.target).toBe(`${editorPath} and ${iniPath}`);

    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result.ok).toBe(true);
    for (const p of [editorPath, iniPath]) expect(readSessionFromIni(readFileSync(p, 'utf8'))).toMatchObject({ enable: 'True', data: dataB });
    const snapshot = backups.get('epic', result.backupId!)!;
    expect(snapshot.files).toEqual(['Config/WindowsEditor/GameUserSettings.ini', 'Config/Windows/GameUserSettings.ini']);
    expect(backups.readFile('epic', snapshot.id, 'Config/WindowsEditor/GameUserSettings.ini').toString('utf8')).toBe(editorText);

    processes.setRunning('EpicGamesLauncher.exe', false);
    const restored = await adapter().restoreBackup(result.backupId!);
    expect(restored.files).toEqual([editorPath, iniPath]);
    expect(readFileSync(editorPath, 'utf8')).toBe(editorText);
    const health = await adapter().healthCheck();
    expect(health.checks.find((c) => c.id === 'settings')?.detail).toMatch(/^2 settings files, reading the newest \(WindowsEditor\); .*Enable=False/);
  });

  it('refuses to fabricate a missing GameUserSettings.ini', async () => {
    rmSync(iniPath);
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.executable).toBe(false);
    expect(plan.warnings[0]).toMatch(/does not exist\. One Launch never creates it/);
    await expect(adapter().switchAccount(ref(B), { dryRun: false })).rejects.toMatchObject({ code: 'SWITCH_BLOCKED', message: /does not exist/ });
    expect(existsSync(iniPath)).toBe(false);
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('rolls the file back when the launcher never comes up', async () => {
    const original = readFileSync(iniPath, 'utf8');
    processes.startFails = true;
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not appear/);
    expect(result.restored).toBe(true);
    expect(readFileSync(iniPath, 'utf8')).toBe(original);
  });

  it('stops before changing anything when something else starts the launcher before the write', async () => {
    const original = readFileSync(iniPath, 'utf8');
    const storedBefore = sessions.get(A.id)?.fingerprint;
    let looks = 0;
    processes.isRunning = async () => looks++ > 0;
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: null, backupId: null });
    expect(result.error).toBe(
      'Epic Games Launcher was started by something else while One Launch was switching accounts, so the switch stopped before changing anything. Try again.',
    );
    expect(result.steps[0]).toMatchObject({ title: 'Close Epic Games Launcher', status: 'failed' });
    expect(readFileSync(iniPath, 'utf8')).toBe(original);
    expect(sessions.get(A.id)?.fingerprint).toBe(storedBefore);
    expect(backups.list('epic')).toEqual([]);
    expect(processes.events).toEqual([]);
  });

  it('rolls the file back when something else starts the launcher while it is being written', async () => {
    const original = readFileSync(iniPath, 'utf8');
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      onProgress: (steps) => {
        if (steps.some((s) => s.title === "Put the account's session in place" && s.status === 'done')) processes.setRunning('EpicGamesLauncher.exe', true);
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: true });
    expect(result.error).toBe(
      'Epic Games Launcher was started by something else while One Launch was switching accounts, so the switch was stopped. Try again.',
    );
    expect(statusOf(result.steps).slice(4, 7)).toEqual([
      ['Start Epic Games Launcher', 'failed'],
      ['Wait for the launcher to come up', 'pending'],
      ['Confirm the launcher signed in', 'pending'],
    ]);
    expect(readFileSync(iniPath, 'utf8')).toBe(original);
    // Closed before the file goes back, and never started by the switch.
    expect(processes.events.map((e) => e.kind)).toEqual(['close']);
  });
});

describe('EpicAdapter: a session that no One Launch account owns (B23)', () => {
  const PIN = 'Holds a sign-in that no One Launch account owns';
  const strangers = Buffer.from(`blob-of-a-stranger-${'s'.repeat(60)}`).toString('base64');
  function aStrangerIsRemembered(): void {
    writeFileSync(iniPath, planSessionWrite(readFileSync(iniPath, 'utf8'), { v: 1, rememberMe: { enable: 'True', data: strangers }, offline: null }).text);
    sim.writeLog(['Log file open, run by hand', '[..]FAccountService::OnLoginComplete - 0 TRUE ffffffffffffffffffffffffffffffff ']);
  }

  it('says in the plan that the backup keeps it, and pins the snapshot the switch takes', async () => {
    aStrangerIsRemembered();
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.warnings.find((w) => w.includes('no One Launch account owns'))).toMatch(
      /It will be replaced\. The backup taken before this switch keeps a copy and is left out of the usual clean-up, so restoring it from Settings › Backups brings that sign-in back\.$/,
    );

    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result.ok).toBe(true);
    const snapshot = backups.get('epic', result.backupId!)!;
    expect(snapshot.pinned).toBe(PIN);
    expect(backups.readFile('epic', snapshot.id, 'Config/Windows/GameUserSettings.ini').toString('utf8')).toContain(strangers);
    expect(readFileSync(iniPath, 'utf8')).not.toContain(strangers);
  });

  it('does not pin a switch between two accounts One Launch knows', async () => {
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(backups.get('epic', result.backupId!)!.pinned).toBeNull();
  });

  it('pins the snapshot a restore takes first when the state it replaces is such a session', async () => {
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    processes.setRunning('EpicGamesLauncher.exe', false);
    aStrangerIsRemembered();
    await adapter().restoreBackup(result.backupId!);
    const taken = backups.list('epic').find((s) => s.reason === `Before restoring ${result.backupId}`)!;
    expect(taken.pinned).toBe(PIN);

    // Restoring again replaces Main's own session, which One Launch already holds: an ordinary snapshot.
    await adapter().restoreBackup(result.backupId!);
    const again = backups.list('epic').filter((s) => s.reason === `Before restoring ${result.backupId}`);
    expect(again.map((s) => s.pinned)).toEqual([null, PIN]);
  });
});

describe('EpicAdapter.restoreBackup', () => {
  it('refuses while the launcher runs and puts the file back otherwise', async () => {
    const original = readFileSync(iniPath, 'utf8');
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result.ok).toBe(true);
    await expect(adapter().restoreBackup(result.backupId!)).rejects.toMatchObject({ code: 'LAUNCHER_RUNNING' });
    processes.setRunning('EpicGamesLauncher.exe', false);
    const restored = await adapter().restoreBackup(result.backupId!);
    expect(restored).toEqual({ launcher: 'epic', id: result.backupId, files: [iniPath], registry: [] });
    expect(readFileSync(iniPath, 'utf8')).toBe(original);
  });
});

describe('EpicAdapter.launchGame', () => {
  it('sends the catalog triple by default, the app name on request, and rejects odd ids', async () => {
    expect(await adapter().launchGame({ launcherGameId: 'Sugar', name: 'Rocket League' })).toEqual({
      command: 'com.epicgames.launcher://apps/0000000000000000000000000000000a%3A0000000000000000000000000000000b%3ASugar?action=launch&silent=true',
    });
    uriForm = 'appname';
    expect((await adapter().launchGame({ launcherGameId: 'Sugar', name: 'Rocket League' })).command).toBe(
      'com.epicgames.launcher://apps/Sugar?action=launch&silent=true',
    );
    uriForm = 'catalog';
    expect((await adapter().launchGame({ launcherGameId: 'Unknown', name: 'x' })).command).toBe(
      'com.epicgames.launcher://apps/Unknown?action=launch&silent=true',
    );
    expect(opened).toHaveLength(3);
    await expect(adapter().launchGame({ launcherGameId: 'a b', name: 'x' })).rejects.toThrow(/Not an Epic app name/);
  });
});

describe('EpicAdapter with a non-UTF-8 settings file', () => {
  it('refuses to read or plan against a UTF-16 GameUserSettings.ini instead of rewriting it', async () => {
    writeFileSync(iniPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[RememberMe]\r\nEnable=True\r\nData=abc\r\n', 'utf16le')]));
    await expect(adapter().sessionState()).rejects.toMatchObject({ code: 'LAUNCHER_FILE' });
    await expect(adapter().switchAccount(ref(B), { dryRun: true })).rejects.toMatchObject({ code: 'LAUNCHER_FILE' });
    await expect(adapter().switchAccount(ref(B), { dryRun: false })).rejects.toMatchObject({ code: 'LAUNCHER_FILE' });
    expect(readFileSync(iniPath).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
  });

  it('fails the settings health row instead of reading the file as empty', async () => {
    writeFileSync(iniPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[RememberMe]\r\nEnable=True\r\nData=abc\r\n', 'utf16le')]));
    const report = await adapter().healthCheck();
    expect(report.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'settings')).toMatchObject({
      status: 'fail',
      detail: `GameUserSettings.ini is not UTF-8 (UTF-16 or binary content); One Launch will not rewrite it: ${iniPath}`,
    });
  });
});
