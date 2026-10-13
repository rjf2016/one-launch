import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RIOT_CLIENT_EXE, RIOT_CLIENT_UNINSTALL_KEY, RIOT_CLIENT_WINDOW_EXE, RIOT_UNINSTALL_ROOT } from '../src/main/launchers/riot/adapter';
import {
  CLIENT_LOG_FILE,
  clientLogDir,
  currentRunEvents,
  exitedCleanly,
  gameStarted,
  lastSignIn,
  launchAccepted,
  launchDeclined,
  launchPageShown,
  launchRequest,
  productsNeedingUpdate,
} from '../src/main/launchers/riot/client-log';
import { readSession } from '../src/main/launchers/riot/session';
import { sniffIcon } from '../src/main/services/artwork-url';
import { BattlenetSim } from '../src/main/launchers/sim/battlenet';
import { SimProcessController } from '../src/main/launchers/sim/processes';
import { fakeSessionFile, RiotSim, type RiotKnobs } from '../src/main/launchers/sim/riot';
import { STEAM_UPDATE_LINES, SteamSim } from '../src/main/launchers/sim/steam';
import type { SteamKnobs } from '../src/main/launchers/sim/types';
import { STEAM_HKCU_KEY, steamId3 } from '../src/main/launchers/steam/adapter';
import { bootstrapLogPath } from '../src/main/launchers/steam/bootstrap-log';
import { loginLogPath } from '../src/main/launchers/steam/login-log';
import { parseLoginUsers } from '../src/main/launchers/steam/loginusers';
import { StaticRegistry } from '../src/main/platform/registry';

const fixture = readFileSync(join(__dirname, 'fixtures', 'steam', 'loginusers.vdf'), 'utf8');
const riotFixture = readFileSync(join(__dirname, 'fixtures', 'riot', 'RiotGamesPrivateSettings.yaml'), 'utf8');
const ID3 = (login: string): number => steamId3(parseLoginUsers(fixture).find((u) => u.accountName === login)!.steamId64);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => Promise<boolean>, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(2);
  }
};

describe('SimProcessController', () => {
  it('fans a start out to every listener and still lets a test wrap onStart', async () => {
    const processes = new SimProcessController();
    const seen: string[] = [];
    processes.addListener((_exe, args) => seen.push(`a:${args.join(' ')}`));
    processes.addListener((_exe, args) => seen.push(`b:${args.join(' ')}`));
    await processes.start('C:\\Steam\\steam.exe', ['-login', 'x']);
    expect(seen).toEqual(['a:-login x', 'b:-login x']);
    const base = processes.onStart;
    processes.onStart = (exe, args) => {
      base?.(exe, args);
      seen.push('wrapped');
    };
    await processes.start('C:\\Steam\\steam.exe', []);
    expect(seen.slice(2)).toEqual(['a:', 'b:', 'wrapped']);
    expect(await processes.isRunning('steam.exe')).toBe(true);
  });

  it('applies every process knob', async () => {
    const processes = new SimProcessController({
      running: ['Battle.net.exe'],
      table: [{ name: 'notepad', pid: 3, path: 'C:\\Windows\\notepad.exe' }],
      shutdownPolls: 3,
      startFails: ['EpicGamesLauncher.exe'],
      elevated: ['Battle.net.exe'],
      reappearsAfterPolls: { 'steam.exe': 1 },
    });
    expect(await processes.isRunning('battle.net.exe')).toBe(true);
    expect(await processes.listProcesses()).toEqual([{ name: 'notepad', pid: 3, path: 'C:\\Windows\\notepad.exe' }]);
    expect(processes.shutdownPolls).toBe(3);

    await processes.start('C:\\Epic\\EpicGamesLauncher.exe', []);
    expect(await processes.isRunning('EpicGamesLauncher.exe')).toBe(false);
    expect(processes.startFails).toBe(false);
    await processes.start('C:\\Epic\\Other.exe', []);
    expect(await processes.isRunning('Other.exe')).toBe(true);

    const kills: string[] = [];
    processes.addKillListener((image) => kills.push(image));
    await expect(processes.close('Battle.net.exe')).rejects.toMatchObject({ code: 'PROCESS_ACCESS_DENIED' });
    await expect(processes.kill('Battle.net.exe')).rejects.toMatchObject({ code: 'PROCESS_ACCESS_DENIED' });
    expect(await processes.isRunning('Battle.net.exe')).toBe(true);
    await processes.kill('Other.exe');
    expect(await processes.isRunning('Other.exe')).toBe(false);
    expect(kills).toEqual(['Battle.net.exe', 'Other.exe']);

    expect(await processes.isRunning('steam.exe')).toBe(false);
    expect(await processes.isRunning('steam.exe')).toBe(true);
    expect(await processes.isRunning('steam.exe')).toBe(true);
    await processes.kill('steam.exe');
    expect(await processes.isRunning('steam.exe')).toBe(false);
    expect(await processes.isRunning('steam.exe')).toBe(false);
  });
});

describe('SteamSim', () => {
  let root: string;
  let steamDir: string;
  let registry: StaticRegistry;
  let processes: SimProcessController;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'onelaunch-sim-'));
    steamDir = join(root, 'Steam');
    mkdirSync(join(steamDir, 'config'), { recursive: true });
    writeFileSync(join(steamDir, 'config', 'loginusers.vdf'), fixture);
    registry = new StaticRegistry(SteamSim.defaultRegistry(steamDir));
    processes = new SimProcessController();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const sim = (knobs: Partial<SteamKnobs> = {}): SteamSim => {
    const s = new SteamSim({ steamDir, registry, processes, knobs });
    processes.addListener((exe, args) => s.onStart(exe, args));
    return s;
  };
  const activeUser = (): Promise<number | null> => registry.getDword('HKCU', `${STEAM_HKCU_KEY}\\ActiveProcess`, 'ActiveUser');
  const steam = (): string => join(steamDir, 'steam.exe');

  it('defaults to the behaviour the adapter tests script, and seeds the five registry values', async () => {
    const s = sim();
    expect(s.knobs).toEqual({
      expiredSessions: [],
      wrongPassword: false,
      loginVerdict: null,
      selfUpdateMs: null,
      reactMs: 0,
      signInWhenAskedMs: null,
      signInAs: null,
      runningAs: null,
    });
    expect(Object.keys(SteamSim.defaultRegistry(steamDir))).toHaveLength(5);
    expect(await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_1');
    await processes.start(steam(), []);
    await until(async () => (await activeUser()) === ID3('user_1'));
    expect(existsSync(loginLogPath(steamDir))).toBe(false);
  });

  it('reactMs holds the reaction back, and selfUpdateMs writes the updater log around it', async () => {
    sim({ reactMs: 30, selfUpdateMs: 30 });
    await processes.start(steam(), []);
    await sleep(5);
    expect(existsSync(bootstrapLogPath(steamDir))).toBe(false);
    await until(async () => existsSync(bootstrapLogPath(steamDir)));
    const updating = readFileSync(bootstrapLogPath(steamDir), 'utf8');
    expect(STEAM_UPDATE_LINES.every((line) => updating.includes(line))).toBe(true);
    expect(updating).not.toContain('Verification complete');
    expect(await activeUser()).toBeNull();
    await until(async () => (await activeUser()) === ID3('user_1'));
    expect(readFileSync(bootstrapLogPath(steamDir), 'utf8')).toContain('Verification complete');
  });

  it('a negative selfUpdateMs never finishes', async () => {
    sim({ selfUpdateMs: -1 });
    await processes.start(steam(), []);
    await sleep(60);
    expect(readFileSync(bootstrapLogPath(steamDir), 'utf8')).not.toContain('Verification complete');
    expect(await activeUser()).toBeNull();
  });

  it('signInWhenAskedMs has the simulated user sign in after landing on the form, as the requested login unless signInAs says otherwise', async () => {
    const s = sim({ signInWhenAskedMs: 5, expiredSessions: ['user_1'] });
    await processes.start(steam(), []);
    await until(async () => (await activeUser()) === 0);
    await until(async () => (await activeUser()) === ID3('user_1'));
    expect(readFileSync(loginLogPath(steamDir), 'utf8')).toContain('SetLoginState: Success - OK');

    s.knobs.signInAs = 7;
    await processes.start(steam(), ['-login', 'nobody']);
    expect(await activeUser()).toBe(0);
    await until(async () => (await activeUser()) === 7);

    s.knobs.signInAs = null;
    s.knobs.loginVerdict = 'Account Logon Denied';
    await processes.start(steam(), ['-login', 'user_2', 'pw']);
    expect(await activeUser()).toBe(0);
    await until(async () => (await activeUser()) === ID3('user_2'));

    s.knobs.loginVerdict = null;
    s.knobs.wrongPassword = true;
    await processes.start(steam(), ['-login', 'nobody', 'pw']);
    expect(await activeUser()).toBe(0);
    await until(async () => (await activeUser()) === 424242);
  });

  it('runningAs begins the run with Steam running and signed in', async () => {
    sim({ runningAs: 'user_2' });
    expect(await processes.isRunning('steam.exe')).toBe(true);
    expect(await activeUser()).toBe(ID3('user_2'));
    expect(readFileSync(loginLogPath(steamDir), 'utf8')).toContain('SetLoginState: Success - OK');
  });

  it('ignores the other launchers on a shared controller', async () => {
    sim();
    await processes.start('C:\\Epic\\EpicGamesLauncher.exe', []);
    await sleep(5);
    expect(await activeUser()).toBeNull();
    expect(existsSync(join(steamDir, 'logs'))).toBe(false);
  });
});

describe('BattlenetSim', () => {
  let root: string;
  let registry: StaticRegistry;
  let processes: SimProcessController;
  const exe = (): string => join(root, 'Battle.net', 'Battle.net.exe');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'onelaunch-sim-'));
    mkdirSync(join(root, 'Roaming', 'Battle.net'), { recursive: true });
    writeFileSync(
      join(root, 'Roaming', 'Battle.net', 'Battle.net.config'),
      readFileSync(join(__dirname, 'fixtures', 'battlenet', 'Battle.net.config'), 'utf8'),
    );
    registry = new StaticRegistry(BattlenetSim.defaultRegistry({ installDir: join(root, 'Battle.net'), gamesDir: join(root, 'Games') }));
    processes = new SimProcessController();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const logText = (sim: BattlenetSim): string => {
    const names = readdirSync(sim.logsDir).sort();
    return readFileSync(join(sim.logsDir, names[names.length - 1]!), 'utf8');
  };

  it('logs every product install state at start, and the game start only for a playable product it knows', async () => {
    const sim = new BattlenetSim({
      appData: join(root, 'Roaming'),
      localAppData: join(root, 'Local'),
      registry,
      processes,
      knobs: { updatesPending: ['prometheus'] },
    });
    processes.addListener((exe, args) => sim.onStart(exe, args));
    await processes.start(exe(), []);
    await until(async () => existsSync(sim.logsDir) && logText(sim).includes('Attempting to show main window'));
    expect(logText(sim)).toMatch(/InstallState \(prometheus\): currentOperation=Update currentOperationStatus=New playable=0/);
    expect(logText(sim)).toMatch(/InstallState \(hs_beta\): currentOperation=UpToDate currentOperationStatus=Paused installed=1 .* playable=1/);

    await processes.start(exe(), ['--exec=launch Pro']);
    expect(logText(sim)).toContain('Selecting game family by id: Pro');
    expect(logText(sim)).not.toContain('GameLaunching=1');

    await processes.start(exe(), ['--exec=launch WTCG']);
    expect(logText(sim)).toContain('LaunchBinary: uid=hs_beta');
    expect(logText(sim)).toContain('InstallState (hs_beta): GameLaunching=1');
    expect(logText(sim)).toContain('Game is running: hs_beta');
    expect(logText(sim)).toContain('InstallState (hs_beta): gameRunning=1 isGameProcessRunning=1 GameLaunching=0');

    await processes.start(exe(), ['--exec=launch WoW']);
    expect(logText(sim)).toContain('Selecting game family by id: WoW');
    expect(logText(sim).split('GameLaunching=1').length - 1).toBe(1);
  });

  it('a game running outside the client: its process sits under the game folder, each start logs it running, --exec for it only selects the page, and its exit is logged', async () => {
    const sim = new BattlenetSim({
      appData: join(root, 'Roaming'),
      localAppData: join(root, 'Local'),
      registry,
      processes,
      gamesDir: join(root, 'Games'),
      knobs: { gamesRunning: ['prometheus'] },
    });
    processes.addListener((exe, args) => sim.onStart(exe, args));
    expect((await processes.listProcesses()).map((p) => [p.name, p.path])).toEqual([
      ['Overwatch.exe', join(root, 'Games', 'Overwatch', '_retail_', 'Overwatch.exe')],
    ]);
    expect(await processes.runningNames()).toContain('overwatch');

    await processes.start(exe(), []);
    await until(async () => existsSync(sim.logsDir) && logText(sim).includes('Attempting to show main window'));
    expect(logText(sim)).toContain('InstallState (prometheus): gameRunning=1 isGameProcessRunning=1');
    await processes.start(exe(), ['--exec=launch Pro']);
    expect(logText(sim)).toContain('Selecting game family by id: Pro');
    expect(logText(sim)).not.toContain('GameLaunching=1');

    await sim.gameExits('prometheus');
    expect(await processes.listProcesses()).toEqual([]);
    expect(logText(sim)).toContain('opType=Execute oldStatus=On newStatus=Off agentUid=prometheus');
    expect(logText(sim)).toContain('InstallState (prometheus): gameRunning=0 isGameProcessRunning=0');
    await processes.start(exe(), ['--exec=launch Pro']);
    expect(logText(sim)).toContain('InstallState (prometheus): GameLaunching=1');

    expect(
      () => new BattlenetSim({ appData: join(root, 'Roaming'), localAppData: join(root, 'Local'), registry, processes, knobs: { gamesRunning: ['hs_beta'] } }),
    ).toThrow('needs gamesDir');
  });
});

describe('RiotSim', () => {
  const SUB = '11111111-1111-4111-8111-111111111111';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  let root: string;
  let localAppData: string;
  let processes: SimProcessController;
  let sim: RiotSim;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'onelaunch-sim-'));
    localAppData = join(root, 'Local');
    mkdirSync(join(localAppData, 'Riot Games', 'Riot Client', 'Data'), { recursive: true });
    writeFileSync(join(localAppData, 'Riot Games', 'Riot Client', 'Data', 'RiotGamesPrivateSettings.yaml'), riotFixture);
    processes = new SimProcessController();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const make = (knobs: Partial<RiotKnobs> = {}): RiotSim => {
    sim = new RiotSim({ localAppData, processes, knobs });
    processes.addListener((exe, args) => sim.onStart(exe, args));
    return sim;
  };
  const exe = (): string => join(root, 'Riot Games', 'Riot Client', RIOT_CLIENT_EXE);
  const verdict = () => lastSignIn(currentRunEvents(clientLogDir(localAppData)));
  const onDisk = () => {
    const read = readSession(readFileSync(sim.sessionPath, 'utf8'));
    return read.kind === 'session' ? read.session : null;
  };

  it('signs in from the saved sign-in, rotates the token, logs the build 140 states, and lays down the install', async () => {
    make();
    const before = onDisk()!;
    await processes.start(exe(), []);
    expect(await processes.isRunning(RIOT_CLIENT_EXE)).toBe(true);
    expect(await processes.isRunning(RIOT_CLIENT_WINDOW_EXE)).toBe(true);
    expect(verdict()).toEqual({ ok: true, how: 'restored' });
    const after = onDisk()!;
    expect(after.accountId).toBe(SUB);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.writeCount).toBe((before.writeCount ?? 0) + 1);
    expect(readdirSync(sim.logDir)).toHaveLength(1);
    expect(readdirSync(sim.logDir)[0]).toMatch(CLIENT_LOG_FILE);
    const text = readFileSync(join(sim.logDir, readdirSync(sim.logDir)[0]!), 'utf8');
    expect(text).toContain('Application Version: 140.0.7.5045');
    expect(text).not.toContain('placeholder-refresh');

    await processes.close(RIOT_CLIENT_EXE);
    expect(exitedCleanly(currentRunEvents(clientLogDir(localAppData)))).toBe(true);
    expect(onDisk()?.accountId).toBe(SUB);

    const programData = join(root, 'ProgramData');
    RiotSim.ensureProducts({ programData, installDir: join(root, 'Riot Games', 'Riot Client'), gamesDir: join(root, 'Games') });
    expect(existsSync(join(programData, 'Riot Games', 'Metadata', 'valorant.live', 'valorant.live.ok'))).toBe(true);
    expect(existsSync(join(root, 'Games', 'VALORANT', 'live'))).toBe(true);
    expect(JSON.parse(readFileSync(join(programData, 'Riot Games', 'RiotClientInstalls.json'), 'utf8')).rc_default).toContain('RiotClientServices.exe');
    const icon = join(programData, 'Riot Games', 'Metadata', 'valorant.live', 'valorant.live.ico');
    expect(sniffIcon(readFileSync(icon))).toBe(true);
    const registry = RiotSim.defaultRegistry({ installDir: join(root, 'Riot Games', 'Riot Client'), gamesDir: join(root, 'Games'), programData });
    expect(registry[`HKCU\\${RIOT_CLIENT_UNINSTALL_KEY}\\InstallLocation`]).toMatch(/\/$/);
    expect(registry[`HKCU\\${RIOT_UNINSTALL_ROOT}\\Riot Game valorant.live\\DisplayName`]).toBe('VALORANT');
    expect(registry[`HKCU\\${RIOT_UNINSTALL_ROOT}\\Riot Game valorant.live\\DisplayIcon`]).toBe(icon.replace(/\\/g, '/'));
  });

  it('lands on the login page for a signed-out file, a refused sign-in, or a service failure, and the user signs in when asked', async () => {
    make({ signInWhenAskedMs: 5, signInAs: OTHER });
    sim.writeSignedOut();
    await processes.start(exe(), []);
    expect(verdict()).toEqual({ ok: false, reason: 'no-session', detail: 'no saved sign-in' });
    await until(async () => verdict()?.ok === true);
    expect(verdict()).toEqual({ ok: true, how: 'manual' });
    expect(onDisk()?.accountId).toBe(OTHER);

    sim.knobs.rejected = [OTHER];
    await processes.start(exe(), []);
    expect(verdict()).toMatchObject({ ok: false, reason: 'rejected' });
    expect(onDisk()).toBeNull();
    await until(async () => verdict()?.ok === true);

    sim.knobs.rejected = [];
    sim.knobs.authError = 'request_failed';
    await processes.start(exe(), []);
    expect(verdict()).toEqual({ ok: false, reason: 'error', detail: 'the sign-in did not complete (request_failed)' });
    expect(onDisk()?.accountId).toBe(OTHER);
    // The scripted user signs in once more; wait for it so the timer does not outlive the folder.
    await until(async () => verdict()?.ok === true);
  });

  it("forgets a sign-in made without Stay signed in at the core's exit, and refuses every copy of one the user signed out of", async () => {
    make({ staySignedIn: false });
    sim.writeSignedOut();
    await processes.start(exe(), []);
    sim.signInByHand(OTHER);
    expect(onDisk()?.accountId).toBe(OTHER);
    await processes.close(RIOT_CLIENT_EXE);
    expect(onDisk()).toBeNull();

    sim.knobs.staySignedIn = true;
    await processes.start(exe(), []);
    sim.signInByHand(OTHER);
    const kept = readFileSync(sim.sessionPath, 'utf8');
    sim.signOut();
    expect(verdict()).toEqual({ ok: false, reason: 'signed-out', detail: 'signed out' });
    expect(onDisk()).toBeNull();
    writeFileSync(sim.sessionPath, kept);
    await processes.start(exe(), []);
    expect(verdict()).toMatchObject({ ok: false, reason: 'rejected' });
  });

  it('runningAs begins the run with the client running and signed in, and a fresh file for an account the file does not name', () => {
    make({ runningAs: OTHER });
    expect(onDisk()?.accountId).toBe(OTHER);
    expect(verdict()).toEqual({ ok: true, how: 'restored' });
    expect(readSession(fakeSessionFile(SUB, 'placeholder-refresh-x'))).toMatchObject({ kind: 'session', session: { accountId: SUB, writeCount: 1 } });
  });

  it('opens the page of the product the shortcut names once signed in, at a start and for a request handed to the running client, and starts it only with direct launch', async () => {
    make();
    const events = () => currentRunEvents(clientLogDir(localAppData));
    await processes.start(exe(), ['--launch-product=valorant', '--launch-patchline=live']);
    expect(verdict()).toEqual({ ok: true, how: 'restored' });
    expect(launchRequest(events())).toEqual({ product: 'valorant', patchline: 'live' });
    expect(launchPageShown(events(), 'valorant', 'live')).toBe(true);
    expect(launchDeclined(events(), 'valorant', 'live')).toBe('Auto-launch is disabled');
    expect(gameStarted(events(), 'valorant', 'live')).toBe(false);
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);
    expect(readdirSync(sim.logDir)).toHaveLength(1);
    const text = () => readFileSync(join(sim.logDir, readdirSync(sim.logDir)[0]!), 'utf8');
    expect(text()).toContain('    --launch-product=valorant');
    expect(text()).toContain('Setting product context to valorant.live, willAutoLaunch=true');
    expect(text()).toContain('Setting product context to valorant.live, willAutoLaunch=false');
    expect(text()).toContain('riot-client-lifecycle: Attempting to launch default product with reason (Auto-launch is disabled)');
    expect(text()).toContain('patch-proxy: HandleProductPatchlineStatusUpdate: productId: valorant, patchlineId: live, status: UpToDate, progress: 0');

    // The running client takes the next request as the singleton does: the same log, the page again, with the running client's own words.
    await processes.start(exe(), ['--launch-product=valorant', '--launch-patchline=live']);
    expect(readdirSync(sim.logDir)).toHaveLength(1);
    expect(text()).toContain('Client is already running. Explicitly request focus instead of launching (Auto-launch is disabled)');
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);
    // Nothing it does not carry: the context alone.
    await processes.start(exe(), ['--launch-product=league_of_legends', '--launch-patchline=live']);
    expect(launchAccepted(events(), 'league_of_legends', 'live')).toBe(true);
    expect(launchPageShown(events(), 'league_of_legends', 'live')).toBe(false);
    expect(await processes.isRunning('LeagueClient.exe')).toBe(false);
    // The user presses Play on the page.
    sim.pressPlay('valorant.live');
    expect(await processes.isRunning('VALORANT.exe')).toBe(true);
    expect((await processes.listProcesses()).map((p) => p.name)).toEqual(['VALORANT.exe']);
    expect(gameStarted(events(), 'valorant', 'live')).toBe(true);
    expect(events().filter((e) => e.kind === 'launch-starting')).toHaveLength(1);

    // A client that still launches at its start (build 77 did).
    sim.knobs.directLaunch = true;
    processes.setRunning('VALORANT.exe', false);
    processes.processes = [];
    await processes.close(RIOT_CLIENT_EXE);
    await processes.start(exe(), ['--launch-product=valorant', '--launch-patchline=live']);
    expect(launchDeclined(events(), 'valorant', 'live')).toBeNull();
    expect(gameStarted(events(), 'valorant', 'live')).toBe(true);
    expect(text()).toContain("product-launcher: Launch starting: productId='valorant' patchlineId='live'");
    expect(await processes.isRunning('VALORANT.exe')).toBe(true);
  });

  it('only opens the page of a product that needs an update, with or without direct launch, and does nothing with a launch request on its login page', async () => {
    make({ updatesPending: ['valorant.live'] });
    const events = () => currentRunEvents(clientLogDir(localAppData));
    await processes.start(exe(), ['--launch-product=valorant', '--launch-patchline=live']);
    expect(verdict()).toEqual({ ok: true, how: 'restored' });
    expect(productsNeedingUpdate(events())).toEqual(new Set(['valorant.live']));
    expect(launchAccepted(events(), 'valorant', 'live')).toBe(true);
    expect(launchDeclined(events(), 'valorant', 'live')).toBe('Product is not up to date');
    expect(gameStarted(events(), 'valorant', 'live')).toBe(false);
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);

    sim.knobs.directLaunch = true;
    await processes.close(RIOT_CLIENT_EXE);
    await processes.start(exe(), ['--launch-product=valorant', '--launch-patchline=live']);
    expect(launchDeclined(events(), 'valorant', 'live')).toBe('Product is not up to date');
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);

    await processes.close(RIOT_CLIENT_EXE);
    sim.writeSignedOut();
    await processes.start(exe(), ['--launch-product=valorant', '--launch-patchline=live']);
    expect(verdict()).toMatchObject({ ok: false, reason: 'no-session' });
    expect(launchAccepted(events(), 'valorant', 'live')).toBe(false);
    expect(await processes.isRunning('VALORANT.exe')).toBe(false);
  });

  it('ignores the other launchers on a shared controller', async () => {
    make();
    await processes.start('C:\\Epic\\EpicGamesLauncher.exe', []);
    await sleep(5);
    expect(existsSync(sim.logDir)).toBe(false);
    expect(await processes.isRunning(RIOT_CLIENT_WINDOW_EXE)).toBe(false);
  });
});
