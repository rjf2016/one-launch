import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BATTLENET_UNINSTALL_KEY, BATTLENET_URI_COMMAND_KEY, BattlenetAdapter, STEP } from '../src/main/launchers/battlenet/adapter';
import { parseConfig, planSavedAccountNames, readClientSettings } from '../src/main/launchers/battlenet/config';
import { UNINSTALL_KEY } from '../src/main/launchers/battlenet/products';
import { fingerprintOf, serializeBlob } from '../src/main/launchers/battlenet/session';
import { BattlenetSim, LOGGING_STARTED_LINE } from '../src/main/launchers/sim/battlenet';
import type { AccountRef } from '../src/main/launchers/types';
import { StaticProcessController } from '../src/main/platform/processes';
import { StaticRegistry } from '../src/main/platform/registry';
import { migrate, openDatabase } from '../src/main/db';
import { AccountsService } from '../src/main/services/accounts';
import { BackupService } from '../src/main/services/backup';
import { accountDirectory, accountRef, LauncherService } from '../src/main/services/launchers';
import { createLogger } from '../src/main/services/logger';
import { LauncherSessionStore } from '../src/main/services/sessions';
import type { Account, BattlenetLaunchForm, JobStep, LaunchAttention } from '../src/shared/models';
import { FakeVault } from './helpers/fake-vault';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'battlenet', name), 'utf8');
const ID_A = '0a1b2c3d';
const ID_B = '0b2c3d4e';
const ID_C = '0c3d4e5f';
const VALUE_NAME = 'AA11BB22';
/** The login each simulated account signs in with; the client keys its token check on the first saved login. */
const LOGIN_OF: Record<string, string> = { [ID_A]: 'saved1@example.com', [ID_B]: 'saved3@example.com', [ID_C]: 'new@example.com' };

let root: string;
let installDir: string;
let appData: string;
let localAppData: string;
let programData: string;
let configPath: string;
let owDir: string;
let registry: StaticRegistry;
let processes: StaticProcessController;
let sim: BattlenetSim;
let backups: BackupService;
let opened: string[];
let launchForm: BattlenetLaunchForm;
let accounts: AccountsService;
let sessions: LauncherSessionStore;
let A: Account;
let B: Account;
let C: Account;
let hexA: string;
let hexB: string;

/** Stands in for the user signing in on the client's login page once One Launch asks. */
function userSignsInWhenAsked(
  as: string,
  opts: { writeToken?: boolean } = {},
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
  root = mkdtempSync(join(tmpdir(), 'onelaunch-bnet-'));
  installDir = join(root, 'Battle.net');
  appData = join(root, 'Roaming');
  localAppData = join(root, 'Local');
  programData = join(root, 'ProgramData');
  configPath = join(appData, 'Battle.net', 'Battle.net.config');
  owDir = join(root, 'Games', 'Overwatch');
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, 'Battle.net.exe'), '');
  writeFileSync(join(installDir, 'Battle.net Launcher.exe'), '');
  mkdirSync(join(appData, 'Battle.net'), { recursive: true });
  writeFileSync(configPath, fixture('Battle.net.config'));
  writeFileSync(join(appData, 'Battle.net', `${ID_A}.config`), fixture('0a1b2c3d.config'));
  mkdirSync(owDir, { recursive: true });
  mkdirSync(join(programData, 'Battle.net', 'Agent'), { recursive: true });
  writeFileSync(
    join(programData, 'Battle.net', 'Agent', 'aggregate.json'),
    JSON.stringify({ installed: [{ name: 'Overwatch', product_id: 'pro', launch_uri: 'battlenet://game/pro', last_played_timestamp: 1771729603000 }] }),
  );
  writeFileSync(join(programData, 'Battle.net', 'Agent', 'product.db'), BattlenetSim.productDb());

  registry = new StaticRegistry(BattlenetSim.defaultRegistry({ installDir, gamesDir: join(root, 'Games') }));
  processes = new StaticProcessController();
  sim = new BattlenetSim({ appData, localAppData, registry, processes, logins: LOGIN_OF, gamesDir: join(root, 'Games') });
  processes.onStart = (exe, args) => sim.onStart(exe, args);
  sim.writeLog(fixture('battle.net-20260913T032048.091643.log').trimEnd().split('\r\n'));
  backups = new BackupService(join(root, 'backups'), { keep: () => 20 });
  opened = [];
  launchForm = 'uri';

  const db = openDatabase(':memory:');
  migrate(db);
  const vault = new FakeVault();
  accounts = new AccountsService(db, vault);
  sessions = new LauncherSessionStore(db, vault);
  A = accounts.create({ launcher: 'battlenet', displayName: 'Main', login: 'saved1@example.com', launcherUid: ID_A, password: 'pw-a' });
  B = accounts.create({ launcher: 'battlenet', displayName: 'Alt', login: 'saved3@example.com', launcherUid: ID_B });
  C = accounts.create({ launcher: 'battlenet', displayName: 'New', login: 'new@example.com', password: 'pw-c' });
  hexA = sim.freshHex();
  hexB = sim.freshHex();
  registry.setBinaryValue(sim.tokenPath(), hexA);
  sessions.save({
    accountId: A.id,
    launcher: 'battlenet',
    launcherUid: ID_A,
    fingerprint: fingerprintOf(hexA),
    blob: serializeBlob({ v: 1, unifiedAuth: { name: VALUE_NAME, hex: hexA } }),
  });
  sessions.save({
    accountId: B.id,
    launcher: 'battlenet',
    launcherUid: ID_B,
    fingerprint: fingerprintOf(hexB),
    blob: serializeBlob({ v: 1, unifiedAuth: { name: 'B1B1B1B1', hex: hexB } }),
  });
  sim.servers.set(hexA, ID_A);
  sim.servers.set(hexB, ID_B);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const adapter = (defaultInstallDir = join(root, 'nowhere')) =>
  new BattlenetAdapter({
    registry,
    processes,
    backups,
    sessions,
    accounts: accountDirectory(accounts, 'battlenet'),
    vault: new FakeVault(),
    log: createLogger('test:battlenet'),
    backupsToKeep: () => 20,
    openExternal: async (url) => {
      opened.push(url);
    },
    launchForm: () => launchForm,
    appData,
    localAppData,
    programData,
    defaultInstallDir,
    timing: {
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
    },
  });

const slowAdapter = (timing: Record<string, number>): BattlenetAdapter =>
  new BattlenetAdapter({
    ...(adapter() as unknown as { deps: ConstructorParameters<typeof BattlenetAdapter>[0] }).deps,
    timing: {
      pollMs: 5,
      shutdownMs: 200,
      killGraceMs: 100,
      restartWatchMs: 20,
      restartSettleMs: 100,
      startupMs: 500,
      signInMs: 500,
      manualSignInMs: 1_000,
      ...timing,
    },
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

const ref = (a: Account): AccountRef => accountRef(accounts.require(a.id));
const stepByTitle = (steps: readonly JobStep[], title: string): JobStep => steps.find((s) => s.title === title)!;

describe('detection and library', () => {
  it('finds the install through the Uninstall key, the URI handler, then the default folder', async () => {
    const found = await adapter().detectInstall();
    expect(found).toEqual({ launcher: 'battlenet', installDir, exePath: join(installDir, 'Battle.net.exe'), source: 'registry-hklm' });
    registry.delete(`HKLM\\${BATTLENET_UNINSTALL_KEY}\\InstallLocation`);
    expect((await adapter().detectInstall())?.source).toBe('registry-hklm');
    registry.delete(`HKLM\\${BATTLENET_URI_COMMAND_KEY}\\`);
    expect(await adapter().detectInstall()).toBeNull();
    expect((await adapter(installDir).detectInstall())?.source).toBe('default-path');
    await expect(adapter().listInstalledGames()).rejects.toThrow(/not installed/);
  });

  it('looks in the folder chosen in Settings first, and says so when the client is no longer in it', async () => {
    const moved = join(root, 'Elsewhere', 'Battle.net');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'Battle.net.exe'), '');
    writeFileSync(join(moved, 'Battle.net Launcher.exe'), '');
    const base = adapter();
    const bnet = new BattlenetAdapter({ ...(base as unknown as { deps: ConstructorParameters<typeof BattlenetAdapter>[0] }).deps, installDir: () => moved });
    const expected = { launcher: 'battlenet', installDir: moved, exePath: join(moved, 'Battle.net.exe'), source: 'user' };

    expect(await bnet.detectInstall()).toEqual(expected);
    expect((await bnet.healthCheck()).checks.find((c) => c.id === 'install')?.detail).toContain(`${moved} (from the folder chosen in Settings)`);
    expect(base.installFromExe(join(moved, 'Battle.net.exe'))).toEqual(expected);
    expect(base.installFromExe(join(moved, 'battle.net launcher.exe'))).toEqual(expected);
    writeFileSync(join(moved, 'Uninstall.exe'), '');
    expect(base.installFromExe(join(moved, 'Uninstall.exe'))).toBeNull();

    rmSync(join(moved, 'Battle.net.exe'));
    expect((await bnet.detectInstall())?.source).toBe('registry-hklm');
    expect((await bnet.healthCheck()).checks.find((c) => c.id === 'chosen-folder')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining(`Battle.net.exe is no longer in ${moved}`),
    });
    expect(base.installFromExe(join(moved, 'Battle.net Launcher.exe'))).toBeNull();
  });

  it('lists installed products from the Uninstall tree with LastPlayed from the config, skipping missing folders', async () => {
    const games = await adapter().listInstalledGames();
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      launcher: 'battlenet',
      launcherGameId: 'prometheus',
      name: 'Overwatch',
      installPath: owDir,
      libraryPath: join(root, 'Games'),
      // The 2026-09-13 run on disk reports an update pending for Overwatch.
      needsUpdate: true,
    });
    expect(games[0]!.lastPlayedAt).toMatch(/^\d{4}-/);
    mkdirSync(join(root, 'Games', 'Hearthstone'));
    expect((await adapter().listInstalledGames()).map((g) => g.launcherGameId)).toEqual(['hs_beta', 'prometheus']);
  });

  it('finds products with a registry search and one small read each, never by dumping the whole Uninstall tree', async () => {
    const codDir = join(root, 'Games', 'Call of Duty');
    mkdirSync(codDir, { recursive: true });
    const key = `HKLM\\${UNINSTALL_KEY}\\Call of Duty: Modern Warfare II`;
    registry.set(`${key}\\DisplayName`, 'Call of Duty: Modern Warfare II');
    registry.set(`${key}\\InstallLocation`, codDir);
    registry.set(
      `${key}\\UninstallString`,
      '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=lazr --displayname="Call of Duty"',
    );
    const searched: string[] = [];
    const read: string[] = [];
    const search = registry.searchTree.bind(registry);
    const values = registry.listSubkeyValues.bind(registry);
    registry.searchTree = (hive, k, text) => {
      searched.push(text);
      return search(hive, k, text);
    };
    registry.listSubkeyValues = (hive, k, subkey) => {
      read.push(subkey);
      return values(hive, k, subkey);
    };
    registry.queryTree = async () => {
      throw new Error('the full Uninstall dump takes 600 ms idle and stalls under load');
    };

    const games = await adapter().listInstalledGames();
    expect(games.map((g) => [g.launcherGameId, g.name, g.installPath])).toEqual([
      ['lazr', 'Call of Duty: Modern Warfare II', codDir],
      ['prometheus', 'Overwatch', owDir],
    ]);
    expect(searched).toEqual(['Blizzard Uninstaller']);
    expect(read.sort()).toEqual(['Call of Duty: Modern Warfare II', 'Hearthstone', 'Overwatch']);
    expect((await adapter().healthCheck()).status).not.toBe('fail');
  });

  it('leaves out a product whose Uninstall key cannot be read instead of failing the scan', async () => {
    const values = registry.listSubkeyValues.bind(registry);
    registry.listSubkeyValues = (hive, k, subkey) => (subkey === 'Overwatch' ? Promise.reject(new Error('Refusing to read')) : values(hive, k, subkey));
    mkdirSync(join(root, 'Games', 'Hearthstone'));
    expect((await adapter().listInstalledGames()).map((g) => g.launcherGameId)).toEqual(['hs_beta']);
  });

  it('starts games with --exec and confirms the start from the client log; the URI form only opens the game page', async () => {
    // The 2026-09-13 run on disk has an update pending for Overwatch; a fresh run says it is up to date.
    sim.writeLog([LOGGING_STARTED_LINE, ...sim.installStateLines(), sim.signedInLine(ID_A)]);
    const a = adapter();
    launchForm = 'exec';
    const r = await a.launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' });
    expect(r.command).toBe(`"${join(installDir, 'Battle.net.exe')}" --exec=launch Pro (Battle.net started the game)`);
    expect(processes.events.at(-1)).toEqual({ kind: 'start', exe: join(installDir, 'Battle.net.exe'), args: ['--exec=launch Pro'] });
    await sim.gameExits('prometheus');
    launchForm = 'uri';
    const u = await a.launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' });
    expect(u.command).toBe(
      'battlenet://game/pro (this link only opens the game page: press Play there, or switch the Battle.net launch setting to the launch command)',
    );
    expect(opened).toEqual(['battlenet://game/pro']);
    await expect(a.launchGame({ launcherGameId: 'unknowngame', name: 'Unknown' })).rejects.toThrow(/No launch code is known/);
    await expect(a.launchGame({ launcherGameId: 'bad name', name: 'x' })).rejects.toThrow(/Not a Battle.net product codename/);
  });

  it('fails the launch when the client does not start the game after --exec (an update or repair it did not report)', async () => {
    mkdirSync(join(root, 'Games', 'Hearthstone'));
    const quiet = new BattlenetSim({ appData, localAppData, registry, processes, logins: LOGIN_OF, products: ['prometheus'] });
    processes.onStart = (exe, args) => quiet.onStart(exe, args);
    launchForm = 'exec';
    await expect(adapter().launchGame({ launcherGameId: 'hs_beta', name: 'Hearthstone' })).rejects.toThrow(
      /Hearthstone did not start within 0\.05 s of the launch command\. Look at the Battle.net window/,
    );
    expect(processes.events.at(-1)).toEqual({ kind: 'start', exe: join(installDir, 'Battle.net.exe'), args: ['--exec=launch WTCG'] });
  });

  it('reads needsUpdate from the client log and refuses to launch a product Battle.net wants to update, before sending anything', async () => {
    sim.knobs.updatesPending.push('prometheus');
    sim.writeLog([LOGGING_STARTED_LINE, ...sim.installStateLines(), sim.signedInLine(ID_A)]);
    expect((await adapter().listInstalledGames()).map((g) => [g.launcherGameId, g.needsUpdate])).toEqual([['prometheus', true]]);
    launchForm = 'exec';
    const sent = processes.events.length;
    await expect(adapter().launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' })).rejects.toThrow(
      'Overwatch needs an update before it can start. Update it in the Battle.net window, then press Play again.',
    );
    expect(processes.events).toHaveLength(sent);
    await expect(adapter().launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' })).rejects.toMatchObject({ code: 'GAME_NOT_PLAYABLE' });

    sim.knobs.updatesPending.length = 0;
    sim.writeLog([LOGGING_STARTED_LINE, ...sim.installStateLines(), sim.signedInLine(ID_A)]);
    expect((await adapter().listInstalledGames())[0]!.needsUpdate).toBe(false);
  });

  it('refuses a game the client sees running before sending anything, and launches once the client has logged its exit', async () => {
    sim.writeLog([LOGGING_STARTED_LINE, ...sim.installStateLines(), sim.signedInLine(ID_A)]);
    sim.appendLog(sim.launchLines('Pro'));
    launchForm = 'exec';
    const sent = processes.events.length;
    await expect(adapter().launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' })).rejects.toThrow(
      'Overwatch is already running. Close it, then press Play again.',
    );
    await expect(adapter().launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' })).rejects.toMatchObject({ code: 'GAME_NOT_PLAYABLE' });
    expect(processes.events).toHaveLength(sent);

    sim.appendLog([
      'D 2026-09-13 04:30:00.000000 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=On newStatus=Off agentUid=prometheus',
      'D 2026-09-13 04:30:00.000100 [ProductState] {Main} InstallState (prometheus): gameRunning=0 isGameProcessRunning=0',
    ]);
    const r = await adapter().launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' });
    expect(r.command).toContain('(Battle.net started the game)');
    expect(processes.events).toHaveLength(sent + 1);
  });

  it('a game left running when the client exited: the client a switch starts sees it, and the launch is refused until it has gone (2026-10-10)', async () => {
    sim.gameStarts('prometheus');
    expect((await adapter().preflight(ref(B))).runningGame).toBeNull();
    await processes.start(join(installDir, 'Battle.net.exe'), []);
    expect((await adapter().preflight(ref(B))).closeMessage).toBe('Battle.net is running Overwatch. Switching closes Battle.net; the game keeps running.');

    launchForm = 'exec';
    const sent = processes.events.length;
    await expect(adapter().launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' })).rejects.toThrow(
      'Overwatch is already running. Close it, then press Play again.',
    );
    expect(processes.events).toHaveLength(sent);

    await sim.gameExits('prometheus');
    const r = await adapter().launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' });
    expect(r.command).toContain('(Battle.net started the game)');
  });

  it('an abort ends the watch for the game start; the command has already been sent', async () => {
    sim.writeLog([LOGGING_STARTED_LINE, ...sim.installStateLines(), sim.signedInLine(ID_A)]);
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const r = await slowAdapter({ launchConfirmMs: 5_000 }).launchGame({ launcherGameId: 'prometheus', name: 'Overwatch' }, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.command).toBe('battlenet://game/pro (stopped watching for the game start)');
    expect(opened).toEqual(['battlenet://game/pro']);
  });

  it('reports the saved account names as remembered entries keyed by login', async () => {
    const list = await adapter().listRememberedAccounts();
    expect(list.map((e) => [e.login, e.launcherUid, e.mostRecent])).toEqual([
      ['saved1@example.com', '', true],
      ['saved2@example.com', '', false],
      ['saved3@example.com', '', false],
      ['saved4@example.com', '', false],
      ['saved5@example.com', '', false],
    ]);
    const service = new LauncherService([adapter()], accounts, createLogger('test:svc'), sessions);
    const remembered = await service.rememberedAccounts('battlenet');
    expect(remembered.find((r) => r.login === 'saved1@example.com')!.linkedAccountId).toBe(A.id);
    const imported = await service.importAccounts('battlenet', ['saved2@example.com', 'saved1@example.com', 'nobody@example.com']);
    expect(imported.accounts.map((a) => [a.login, a.launcherUid])).toEqual([['saved2@example.com', null]]);
    expect(imported.skipped.map((s) => s.reason)).toEqual(['already in One Launch', 'not remembered by the launcher']);
  });

  it('health-checks the whole chain', async () => {
    const health = await adapter().healthCheck();
    expect(health.status).toBe('ok');
    const byId = Object.fromEntries(health.checks.map((c) => [c.id, c]));
    expect(byId['install']!.detail).toContain('Battle.net Launcher.exe');
    expect(byId['uninstall']!.detail).toContain('Overwatch (prometheus)');
    expect(byId['product-db']!.status).toBe('ok');
    expect(byId['product-db']!.detail).toContain('prometheus → Pro / pro');
    expect(byId['aggregate']!.detail).toContain('Overwatch → battlenet://game/pro');
    expect(byId['config']!.detail).toContain('5 saved account names');
    expect(byId['token']!.detail).toContain('belongs to Main');
    expect(byId['prefs']!.detail).toContain('HideOnClose=false');
    expect(byId['log']!.detail).toContain('signed in as account …2c3d');
    expect(byId['sessions']!.detail).toBe('2 snapshots stored');
    registry.delete(`HKLM\\${BATTLENET_UNINSTALL_KEY}\\InstallLocation`);
    registry.delete(`HKLM\\${BATTLENET_URI_COMMAND_KEY}\\`);
    expect((await adapter().healthCheck()).status).toBe('absent');
  });
});

describe('session state and capture', () => {
  it('attributes the token by stored fingerprint, else by the last run log', async () => {
    const state = await adapter().sessionState();
    expect(state).toMatchObject({
      launcher: 'battlenet',
      remembered: true,
      fingerprint: fingerprintOf(hexA),
      launcherUid: ID_A,
      linkedAccountId: A.id,
      launcherRunning: false,
      lastSignIn: { ok: true, reason: null },
    });
    const unknown = sim.freshHex();
    registry.setBinaryValue(sim.tokenPath(), unknown);
    const byLog = await adapter().sessionState();
    expect(byLog.linkedAccountId).toBe(A.id);
    sim.writeLog(['I 2026-09-13 03:20:48.092586 [Main] {Main} Logging started for Battle.net build 2.52.11.17778', sim.signedInLine(ID_C)]);
    expect((await adapter().sessionState()).linkedAccountId).toBeNull();
    expect((await adapter().sessionState()).launcherUid).toBe(ID_C);
    registry.delete(sim.tokenPath());
    expect(await adapter().sessionState()).toMatchObject({ remembered: false, fingerprint: null, linkedAccountId: null });
  });

  it('captures the current token for its account and refuses when it belongs to someone else', async () => {
    const a = adapter();
    const fresh = sim.freshHex();
    registry.setBinaryValue(sim.tokenPath(), fresh);
    await expect(a.captureSession(ref(B))).rejects.toThrow(/belongs to Main/);
    const captured = await a.captureSession(ref(A));
    expect(captured.session.fingerprint).toBe(fingerprintOf(fresh));
    expect(captured.launcherUid).toBe(ID_A);
    sim.writeLog(['I 2026-09-13 03:20:48.092586 [Main] {Main} Logging started for Battle.net build 2.52.11.17778', sim.signedInLine(ID_C)]);
    const fresher = sim.freshHex();
    registry.setBinaryValue(sim.tokenPath(), fresher);
    const forC = await a.captureSession(ref(C));
    expect(forC.launcherUid).toBe(ID_C);
    expect(accounts.require(C.id).launcherUid).toBe(ID_C);
    await expect(a.captureSession(ref(B))).rejects.toThrow(/belongs to New/);
    registry.delete(sim.tokenPath());
    await expect(a.captureSession(ref(C))).rejects.toThrow(/no remembered session/);
  });

  it('while running, only the current log decides who is signed in', async () => {
    processes.setRunning('Battle.net.exe', true);
    sim.writeLog(['I 2026-09-13 03:20:48.092586 [Main] {Main} Logging started for Battle.net build 2.52.11.17778']);
    await expect(adapter().captureSession(ref(A))).rejects.toThrow(/has not signed in during this run/);
    sim.appendLog([sim.signedInLine(ID_B)]);
    await expect(adapter().captureSession(ref(A))).rejects.toThrow(/belongs to Alt/);
    const captured = await adapter().captureSession(ref(B));
    expect(captured.session.fingerprint).toBe(fingerprintOf(hexA));
  });
});

describe('plans', () => {
  it('describes the remembered path: token swap, list rotation, log confirmation', async () => {
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.strategy).toBe('remembered');
    expect(plan.executable).toBe(true);
    expect(plan.current).toEqual({ mostRecentLogin: 'saved1@example.com', autoLoginUser: 'saved1@example.com', running: false });
    const byId = Object.fromEntries(plan.steps.map((s) => [s.id, s]));
    expect(byId[STEP.close]!.skipped).toBe(true);
    expect(byId[STEP.capture]!.skipped).toBe(false);
    expect(byId[STEP.capture]!.detail).toContain("holds Main's session");
    expect(byId[STEP.backup]!.skipped).toBe(false);
    expect(byId[STEP.registry]!.changes).toEqual([
      { where: 'UnifiedAuth\\B1B1B1B1', before: '(absent)', after: expect.stringContaining(`fingerprint ${fingerprintOf(hexB).slice(0, 8)}`) },
      { where: `UnifiedAuth\\${VALUE_NAME}`, before: `(34 bytes, fingerprint ${fingerprintOf(hexA).slice(0, 8)})`, after: '(removed)' },
    ]);
    expect(byId[STEP.file]!.skipped).toBe(false);
    expect(byId[STEP.file]!.changes[0]!.after).toMatch(/^saved3@example\.com, s…@example\.com/);
    expect(byId[STEP.start]!.target).toBe(`"${join(installDir, 'Battle.net Launcher.exe')}"`);
    expect(byId[STEP.verify]!.detail).toContain('…3d4e');
    expect(byId[STEP.manual]!.skipped).toBe(true);
    expect(plan.warnings).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(hexA);
    expect(JSON.stringify(plan)).not.toContain(hexB);
  });

  it('describes the credentials path and the in-place and already-active cases', async () => {
    const fresh = await adapter().switchAccount(ref(C), { dryRun: true });
    expect(fresh.strategy).toBe('credentials');
    const byId = Object.fromEntries(fresh.steps.map((s) => [s.id, s]));
    expect(byId[STEP.registry]!.title).toBe('Sign the client out');
    expect(byId[STEP.registry]!.changes).toEqual([{ where: `UnifiedAuth\\${VALUE_NAME}`, before: expect.stringContaining('34 bytes'), after: '(removed)' }]);
    expect(byId[STEP.file]!.changes[0]!.after).toMatch(/^new@example\.com, s…@example\.com/);
    expect(byId[STEP.verify]!.detail).toContain('hands over to you');
    expect(byId[STEP.manual]!.skipped).toBe(false);
    expect(fresh.warnings.join('\n')).toContain('No session snapshot is stored for New');

    const inPlace = await adapter().switchAccount(ref(A), { dryRun: true });
    expect(inPlace.strategy).toBe('remembered');
    expect(inPlace.steps.filter((s) => !s.skipped).map((s) => s.id)).toEqual([STEP.start, STEP.wait, STEP.verify]);
    expect(inPlace.notes[0]).toContain('already remembers Main');
    expect(inPlace.warnings).toEqual([]);

    processes.setRunning('Battle.net.exe', true);
    const active = await adapter().preflight(ref(A));
    expect(active.alreadyActive).toBe(true);
    expect(active.plan.steps.every((s) => s.skipped)).toBe(true);
    const other = await adapter().preflight(ref(B));
    expect(other.alreadyActive).toBe(false);
    expect(other.launcherRunning).toBe(true);
    // The dialog's confirm box says the client will be closed, so the preflight's plan leaves that warning out; the preview keeps it.
    expect(other.plan.warnings.join('\n')).not.toContain('It will be closed');
    expect((await adapter().switchAccount(ref(B), { dryRun: true })).warnings[0]).toContain('running as Main');
  });

  it('warns about sticky preferences it never writes, and skips the file step when the layout cannot be reproduced', async () => {
    writeFileSync(configPath, fixture('Battle.net.config').replace('"AutoLogin": "true"', '"AutoLogin": "false"'));
    // Short ids are written without padding (b7c8.config, seen 2026-09-13); the file named by the current account wins.
    rmSync(join(appData, 'Battle.net', `${ID_A}.config`));
    accounts.update(A.id, { launcherUid: 'b7c8' });
    sim.writeLog(['I 2026-09-13 03:20:48.092586 [Main] {Main} Logging started for Battle.net build 2.52.11.17778', sim.signedInLine('b7c8')]);
    writeFileSync(join(appData, 'Battle.net', 'b7c8.config'), fixture('0a1b2c3d.config').replace('"HideOnClose": "false"', '"HideOnClose": "true"'));
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.warnings.join('\n')).toContain('"Keep me logged in" (Client.AutoLogin) is false');
    expect(plan.warnings.join('\n')).toContain('close to the system tray');
    expect(plan.executable).toBe(true);

    writeFileSync(configPath, fixture('Battle.net.config').replace('"AutoLogin": "true"', '"AutoLogin":   "true"'));
    const odd = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(odd.steps.find((s) => s.id === STEP.file)!.skipped).toBe(true);
    expect(odd.warnings.join('\n')).toContain('cannot reproduce exactly');

    rmSync(configPath);
    const missing = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(missing.executable).toBe(true);
    expect(missing.steps.find((s) => s.id === STEP.file)!.detail).toContain('never creates it');
  });
});

describe('real switches', () => {
  it('remembered path: swaps the token, rotates the list, starts the client, confirms from the log', async () => {
    sim.knobs.rotateOnSignIn = true;
    const progress: JobStep[][] = [];
    const result = await adapter().switchAccount(ref(B), { dryRun: false, onProgress: (s) => progress.push([...s]) });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('remembered');
    expect(result.backupId).not.toBeNull();
    expect(result.readyAt).not.toBeNull();
    expect(stepByTitle(result.steps, 'Close Battle.net').status).toBe('skipped');
    expect(stepByTitle(result.steps, "Put the account's session token in place").status).toBe('done');
    expect(stepByTitle(result.steps, 'Put the login first in the saved-accounts list').status).toBe('done');
    expect(sim.firstSaved()).toBe('saved3@example.com');
    expect(stepByTitle(result.steps, 'Confirm the client signed in').detail).toBe('Signed in as saved3@example.com.');
    expect(processes.events.filter((e) => e.kind === 'start').map((e) => e.exe)).toEqual([join(installDir, 'Battle.net Launcher.exe')]);

    const tokens = await sim.currentTokens();
    expect(tokens).toHaveLength(1);
    expect(sim.servers.get(tokens[0]!.hex)).toBe(ID_B);
    expect(sessions.get(B.id)!.fingerprint).toBe(fingerprintOf(tokens[0]!.hex));
    expect(sessions.get(B.id)!.verifiedAt).not.toBeNull();
    expect(registry.writes.map((w) => w.op)).toEqual(['set', 'delete']);
    expect((await sim.currentTokens())[0]!.name).toBe('B1B1B1B1');

    const text = readFileSync(configPath, 'utf8');
    expect(readClientSettings(parseConfig(text).doc).savedAccountNames).toEqual([
      'saved3@example.com',
      'saved1@example.com',
      'saved2@example.com',
      'saved4@example.com',
      'saved5@example.com',
    ]);
    expect(text).toContain('"C:\\/Users\\/someone\\/Games"');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    const snapshot = backups.get('battlenet', result.backupId!)!;
    expect(snapshot.files).toEqual(['Battle.net.config']);
    expect(snapshot.reason).toBe('Before switching to Alt');
    expect(readFileSync(join(snapshot.path, 'manifest.json'), 'utf8')).not.toContain(hexA);
    expect(progress.length).toBeGreaterThan(5);
  });

  it('saves the outgoing session after closing the running client, then switches', async () => {
    processes.setRunning('Battle.net.exe', true);
    const rotated = sim.freshHex();
    sim.servers.set(rotated, ID_A);
    registry.setBinaryValue(sim.tokenPath(), rotated);
    await expect(adapter().switchAccount(ref(B), { dryRun: false })).rejects.toThrow(/Switching closes it/);
    const result = await adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(stepByTitle(result.steps, 'Close Battle.net').status).toBe('done');
    expect(stepByTitle(result.steps, 'Save the outgoing session').detail).toContain("Saved Main's session");
    expect(sessions.get(A.id)!.fingerprint).toBe(fingerprintOf(rotated));
    expect(processes.events.map((e) => e.kind)).toEqual(['close', 'start']);
  });

  it('kills only the client when it ignores the window close, as the plan says, so a running game survives', async () => {
    processes.setRunning('Battle.net.exe', true);
    processes.shutdownPolls = 1_000_000;
    const { plan } = await adapter().preflight(ref(B));
    const close = plan.steps.find((s) => s.id === STEP.close)!.detail;
    expect(close).toContain('force-close every Battle.net.exe process and nothing it started');
    const result = await adapter().switchAccount(ref(B), { dryRun: false, confirmClose: true });
    expect(result.error).toBeNull();
    expect(processes.events.filter((e) => e.kind === 'kill')).toEqual([{ kind: 'kill', exe: 'Battle.net.exe', args: [] }]);
  });

  it('watches only briefly for a restart when the log shows the client shutting down after the close', async () => {
    const slow = slowAdapter({ restartWatchMs: 600, cleanExitWatchMs: 10 });
    const close = processes.close.bind(processes);
    processes.close = async (name) => {
      await close(name);
      sim.appendLog(['I 2026-09-13 03:21:05.000000 [Main] {Main} Shutting down battle.net interface']);
    };
    processes.setRunning('Battle.net.exe', true);
    let started = Date.now();
    await slow.shutdown();
    expect(Date.now() - started).toBeLessThan(400);

    // Killed, or a log that says nothing: the full watch, as before.
    processes.close = close;
    processes.setRunning('Battle.net.exe', true);
    started = Date.now();
    await slow.shutdown();
    expect(Date.now() - started).toBeGreaterThanOrEqual(590);
  });

  it('credentials path: signs the client out, waits for the manual sign-in, stores the fresh token and the account id', async () => {
    const user = userSignsInWhenAsked(ID_C);
    const result = await adapter().switchAccount(ref(C), { dryRun: false, onAttention: user.onAttention, getPassword: () => 'pw-c' });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('credentials');
    expect(stepByTitle(result.steps, 'Sign the client out').status).toBe('done');
    expect(stepByTitle(result.steps, 'Put the login first in the saved-accounts list').status).toBe('done');
    expect(stepByTitle(result.steps, 'Confirm the client signed in').status).toBe('skipped');
    expect(stepByTitle(result.steps, 'Wait for you to sign in')).toMatchObject({
      status: 'done',
      detail: 'Signed in as new@example.com. Linked to Battle.net account …4e5f.',
    });
    expect(stepByTitle(result.steps, 'Save the new session').detail).toContain("Stored New's session");
    expect(user.seen[0]).toMatchObject({
      kind: 'sign-in',
      canCopyPassword: true,
      title: 'Sign in to Battle.net as new@example.com',
      message: 'No session is stored for this account yet. Its login page opens on the account it last signed in as.',
    });
    expect(user.seen[0]!.steps).toEqual([
      'In the Battle.net window, click “Switch account”.',
      'Pick or type new@example.com and enter the password.',
      'Leave “Keep me logged in” on and sign in. One Launch continues on its own, and later switches are automatic.',
    ]);
    expect(user.seen.at(-1)).toBeNull();
    expect(accounts.require(C.id).launcherUid).toBe(ID_C);
    const tokens = await sim.currentTokens();
    expect(sessions.get(C.id)!.fingerprint).toBe(fingerprintOf(tokens[0]!.hex));
    expect(readClientSettings(parseConfig(readFileSync(configPath, 'utf8')).doc).savedAccountNames[0]).toBe('new@example.com');
    expect(registry.writes.map((w) => w.op)).toEqual(['delete']);

    // The next switch away from New (client closed) completes the snapshot with the login-page session.
    processes.setRunning('Battle.net.exe', false);
    const away = await adapter().switchAccount(ref(A), { dryRun: false });
    expect(away.error).toBeNull();
    expect(away.ok).toBe(true);
    expect(stepByTitle(away.steps, 'Save the outgoing session').detail).toContain("New's stored session is already current");
    expect(sim.firstSaved()).toBe('saved1@example.com');
  });

  it('when the saved-accounts list cannot be rewritten the switch is handed over and the snapshot is not marked stale', async () => {
    writeFileSync(configPath, fixture('Battle.net.config').replace('"AutoLogin": "true"', '"AutoLogin":   "true"'));
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.steps.find((s) => s.id === STEP.file)!.skipped).toBe(true);
    expect(plan.warnings.join('\n')).toContain('cannot be put first');
    const user = userSignsInWhenAsked(ID_B);
    const result = await adapter().switchAccount(ref(B), { dryRun: false, onAttention: user.onAttention });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(stepByTitle(result.steps, 'Confirm the client signed in').detail).toContain('discarded the token at start');
    expect(user.seen[0]!.title).toContain('asking you to sign in');
    expect(sessions.get(B.id)!.staleReason).toBeNull();
  });

  it('marks the snapshot stale when the client rejects the token and the login was already first in the list', async () => {
    writeFileSync(configPath, planSavedAccountNames(fixture('Battle.net.config'), 'saved3@example.com').text);
    sim.knobs.rejected.push(hexB);
    const plan = await adapter().switchAccount(ref(B), { dryRun: true });
    expect(plan.steps.find((s) => s.id === STEP.file)).toMatchObject({
      skipped: true,
      detail: expect.stringMatching(/^No change: saved3@example\.com is already first/),
    });
    const result = await slowAdapter({ manualSignInMs: 30 }).switchAccount(ref(B), { dryRun: false });
    expect(result.needsSignIn).toBe(true);
    expect(stepByTitle(result.steps, 'Confirm the client signed in').detail).toContain('ERROR_AUTH_TOKEN_EXPIRED');
    expect(sessions.get(B.id)!.staleReason).toBe('ERROR_AUTH_TOKEN_EXPIRED');
  });

  it('stops before changing anything when something else starts the client before the writes', async () => {
    const before = readFileSync(configPath, 'utf8');
    let looks = 0;
    processes.isRunning = async () => looks++ > 0;
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: null, backupId: null });
    expect(result.error).toBe(
      'Battle.net was started by something else while One Launch was switching accounts, so the switch stopped before changing anything. Try again.',
    );
    expect(stepByTitle(result.steps, 'Close Battle.net').status).toBe('failed');
    expect((await sim.currentTokens()).map((t) => t.hex)).toEqual([hexA]);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(registry.writes).toEqual([]);
    expect(backups.list('battlenet')).toEqual([]);
    expect(processes.events).toEqual([]);
  });

  it('rolls the token and the file back when something else starts the client while they are being written', async () => {
    const before = readFileSync(configPath, 'utf8');
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      onProgress: (steps) => {
        if (steps.some((s) => s.title === 'Put the login first in the saved-accounts list' && s.status === 'done'))
          processes.setRunning('Battle.net.exe', true);
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: true });
    expect(result.error).toBe('Battle.net was started by something else while One Launch was switching accounts, so the switch was stopped. Try again.');
    expect(stepByTitle(result.steps, 'Start Battle.net').status).toBe('failed');
    expect((await sim.currentTokens()).map((t) => t.hex)).toEqual([hexA]);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    // Closed before anything goes back, and never started by the switch.
    expect(processes.events.map((e) => e.kind)).toEqual(['close']);
  });

  it('a sign-in as the wrong account rolls the registry and the file back', async () => {
    sim.knobs.rejected.push(hexB);
    const user = userSignsInWhenAsked(ID_A);
    const before = readFileSync(configPath, 'utf8');
    const result = await adapter().switchAccount(ref(B), { dryRun: false, onAttention: user.onAttention });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('signed in as Main (account …2c3d) instead of Alt');
    expect(result.restored).toBe(true);
    expect((await sim.currentTokens()).map((t) => t.hex)).toEqual([hexA]);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(sim.firstSaved()).toBe('saved1@example.com');
    expect(processes.events.map((e) => e.kind)).toEqual(['start', 'close']);
  });

  it('rolls back, naming the account, when an account without an id signs in as an id another account holds', async () => {
    const user = userSignsInWhenAsked(ID_A);
    const before = readFileSync(configPath, 'utf8');
    const result = await adapter().switchAccount(ref(C), { dryRun: false, onAttention: user.onAttention });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'signed in as Main (account …2c3d), which is another One Launch account, instead of New. Sign in to the client as new@example.com.',
    );
    expect(result.restored).toBe(true);
    expect(stepByTitle(result.steps, 'Wait for you to sign in')).toMatchObject({ status: 'failed', detail: 'Signed in as a different account.' });
    expect((await sim.currentTokens()).map((t) => t.hex)).toEqual([hexA]);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(accounts.require(C.id).launcherUid).toBeNull();
    expect(accounts.require(A.id).launcherUid).toBe(ID_A);
    expect(sessions.get(C.id)).toBeNull();
    expect(sessions.get(A.id)!.fingerprint).toBe(fingerprintOf(hexA));
  });

  it('a registry write failure after the snapshot rolls back and reports it', async () => {
    registry.failNextWrite = 'reg add exploded';
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('reg add exploded');
    expect(result.restored).toBe(true);
    expect(stepByTitle(result.steps, "Put the account's session token in place").status).toBe('failed');
    expect((await sim.currentTokens()).map((t) => t.hex)).toEqual([hexA]);
    expect(processes.events).toEqual([]);
  });

  it('cancelling the manual wait leaves the client on its login page and nothing rolled back', async () => {
    const controller = new AbortController();
    const result = await adapter().switchAccount(ref(C), {
      dryRun: false,
      signal: controller.signal,
      onAttention: (a) => {
        if (a) setTimeout(() => controller.abort(), 5);
      },
    });
    expect(result.cancelled).toBe(true);
    expect(result.restored).toBeNull();
    expect(await sim.currentTokens()).toEqual([]);
  });

  it('reports the snapshot, already on disk, before the first write', async () => {
    const before = readFileSync(configPath, 'utf8');
    let seen: { id: string; file: string; writes: number; listed: string[] } | null = null;
    const result = await adapter().switchAccount(ref(B), {
      dryRun: false,
      onBackup: (id) => {
        seen = { id, file: readFileSync(configPath, 'utf8'), writes: registry.writes.length, listed: backups.list('battlenet').map((s) => s.id) };
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ id: result.backupId, file: before, writes: 0, listed: [result.backupId] });
    expect(registry.writes.length).toBeGreaterThan(0);
  });

  it('an abort while the client is closing stops at once with nothing changed', async () => {
    processes.setRunning('Battle.net.exe', true);
    processes.shutdownPolls = 1_000_000;
    const before = readFileSync(configPath, 'utf8');
    const result = await slowAdapter({ shutdownMs: 5_000 }).switchAccount(ref(B), {
      dryRun: false,
      confirmClose: true,
      ...abortWhen('Close Battle.net', 'running'),
    });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: null, backupId: null });
    expect(result.error).toBe('Stopped before Battle.net was started as saved3@example.com. Nothing had been changed.');
    expect(processes.events.map((e) => e.kind)).toEqual(['close']);
    expect((await sim.currentTokens()).map((t) => t.hex)).toEqual([hexA]);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(backups.list('battlenet')).toEqual([]);
  });

  it('an abort after the writes but before the client is started puts the token and the file back', async () => {
    const before = readFileSync(configPath, 'utf8');
    const result = await adapter().switchAccount(ref(B), { dryRun: false, ...abortWhen('Put the login first in the saved-accounts list', 'done') });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: true });
    expect(result.error).toBe('Stopped before Battle.net was started as saved3@example.com.');
    expect((await sim.currentTokens()).map((t) => t.hex)).toEqual([hexA]);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(processes.events).toEqual([]);
  });

  it('an abort once the client has been started ends the wait and leaves the writes alone', async () => {
    processes.onStart = null;
    processes.startFails = true;
    const result = await slowAdapter({ startupMs: 5_000 }).switchAccount(ref(B), { dryRun: false, ...abortWhen('Wait for the client to come up', 'running') });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: null });
    expect(result.error).toBe(
      'Stopped while Battle.net was starting as saved3@example.com. Nothing was rolled back: the client carries on signing in on its own.',
    );
    expect((await sim.currentTokens()).map((t) => t.hex)).toEqual([hexB]);
    expect(sim.firstSaved()).toBe('saved3@example.com');
  });

  it('an abort after the sign-in is confirmed cuts the capture wait and the grace short; the switch still counts', async () => {
    const user = userSignsInWhenAsked(ID_C, { writeToken: false });
    const started = Date.now();
    const result = await slowAdapter({ captureMs: 5_000, readyGraceMs: 5_000 }).switchAccount(ref(C), {
      dryRun: false,
      onAttention: user.onAttention,
      ...abortWhen('Save the new session', 'running'),
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.ok).toBe(true);
    expect(stepByTitle(result.steps, 'Save the new session').detail).toBe('The client has not written a new token yet; it is saved at the next switch.');
    expect(accounts.require(C.id).launcherUid).toBe(ID_C);
  });

  it('a timed-out manual wait ends in needs-sign-in', async () => {
    const result = await new BattlenetAdapter({
      ...(adapter() as unknown as { deps: ConstructorParameters<typeof BattlenetAdapter>[0] }).deps,
      timing: { pollMs: 5, signInMs: 20, manualSignInMs: 30, startupMs: 200, readyGraceMs: 0, captureMs: 10 },
    }).switchAccount(ref(C), { dryRun: false });
    expect(result.needsSignIn).toBe(true);
    expect(result.error).toContain('gave up');
  });
});

describe('a session that no One Launch account owns (B23)', () => {
  const PIN = 'Holds a sign-in that no One Launch account owns';
  let strangers: string;
  function aStrangerIsRemembered(): void {
    strangers = sim.freshHex();
    // The client keeps one token: whatever was there is gone once someone else has signed in.
    for (const name of [VALUE_NAME, 'B1B1B1B1']) registry.delete(sim.tokenPath(name));
    registry.setBinaryValue(sim.tokenPath(), strangers);
    sim.writeLog(['I 2026-09-13 03:20:48.092586 [Main] {Main} Logging started for Battle.net build 2.52.11.17778', sim.signedInLine('0f0f0f0f')]);
  }

  it('says in the plan that the backup keeps it, and pins the snapshot the switch takes', async () => {
    aStrangerIsRemembered();
    const a = adapter();
    const plan = await a.switchAccount(ref(B), { dryRun: true });
    expect(plan.warnings.find((w) => w.includes('no One Launch account owns'))).toMatch(
      /It will be removed\. The backup taken before this switch keeps a copy and is left out of the usual clean-up, so restoring it from Settings › Backups brings that sign-in back\.$/,
    );

    const result = await a.switchAccount(ref(B), { dryRun: false });
    expect(result.error).toBeNull();
    const snapshot = backups.get('battlenet', result.backupId!)!;
    expect(snapshot.pinned).toBe(PIN);
    expect((await sim.currentTokens()).map((t) => t.hex)).not.toContain(strangers);

    // The pinned snapshot really is the way back: restoring it puts the stranger's token under UnifiedAuth again.
    processes.setRunning('Battle.net.exe', false);
    await a.restoreBackup(snapshot.id);
    expect((await sim.currentTokens()).map((t) => t.hex)).toEqual([strangers]);
  });

  it('does not pin a switch between two accounts One Launch knows', async () => {
    const result = await adapter().switchAccount(ref(B), { dryRun: false });
    expect(result.error).toBeNull();
    expect(backups.get('battlenet', result.backupId!)!.pinned).toBeNull();
  });

  it('pins the snapshot a restore takes first when the state it replaces is such a session', async () => {
    const a = adapter();
    const result = await a.switchAccount(ref(B), { dryRun: false });
    processes.setRunning('Battle.net.exe', false);
    aStrangerIsRemembered();
    await a.restoreBackup(result.backupId!);
    expect(backups.list('battlenet').find((s) => s.reason === `Before restoring ${result.backupId}`)!.pinned).toBe(PIN);
  });
});

describe('restore', () => {
  it('refuses while the client runs, then puts the file and the recorded token back', async () => {
    const a = adapter();
    const before = readFileSync(configPath, 'utf8');
    const result = await a.switchAccount(ref(B), { dryRun: false });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    await expect(a.restoreBackup(result.backupId!)).rejects.toThrow(/Close Battle.net before restoring/);
    processes.setRunning('Battle.net.exe', false);
    registry.setBinaryValue(sim.tokenPath('Other'), sim.freshHex());
    const restored = await a.restoreBackup(result.backupId!);
    expect(restored.files).toEqual([configPath]);
    expect(sim.firstSaved()).toBe('saved1@example.com');
    expect(restored.registry).toEqual([
      `UnifiedAuth\\${VALUE_NAME} = (34 bytes, fingerprint ${fingerprintOf(hexA).slice(0, 8)})`,
      'UnifiedAuth\\B1B1B1B1 (removed)',
      'UnifiedAuth\\Other (removed)',
    ]);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(await sim.currentTokens()).toEqual([{ name: VALUE_NAME, hex: hexA }]);
    expect(existsSync(join(backups.dirFor('battlenet'), result.backupId!, 'manifest.json'))).toBe(true);
  });
});
