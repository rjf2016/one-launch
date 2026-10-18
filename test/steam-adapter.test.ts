import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STEAM_UPDATE_LINES, SteamSim } from '../src/main/launchers/sim/steam';
import { STALE_SESSION_DAYS, SteamAdapter, steamId3, STEAM_HKCU_KEY, STEAM_HKLM_KEY } from '../src/main/launchers/steam/adapter';
import { parseLoginUsers } from '../src/main/launchers/steam/loginusers';
import type { AccountRef } from '../src/main/launchers/types';
import { StaticProcessController } from '../src/main/platform/processes';
import { StaticRegistry } from '../src/main/platform/registry';
import { BackupService } from '../src/main/services/backup';
import { createLogger } from '../src/main/services/logger';
import type { JobStep, LaunchAttention } from '../src/shared/models';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'steam', name), 'utf8');
const vdfPath = (p: string): string => p.replace(/\\/g, '\\\\');
const REG = `HKCU\\${STEAM_HKCU_KEY}`;

let root: string;
let steamDir: string;
let lib2: string;
let loginUsers: string;
let registry: StaticRegistry;
let processes: StaticProcessController;
let sim: SteamSim;
let backups: BackupService;
let opened: string[];

function manifest(appid: string, name: string, installdir: string, stateFlags: number): string {
  return `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"name"\t\t"${name}"\n\t"StateFlags"\t\t"${stateFlags}"\n\t"installdir"\t\t"${installdir}"\n\t"LastOwner"\t\t"76561198000000001"\n}\n`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'onelaunch-steam-'));
  steamDir = join(root, 'Steam');
  lib2 = join(root, 'Games');
  loginUsers = join(steamDir, 'config', 'loginusers.vdf');
  mkdirSync(join(steamDir, 'config'), { recursive: true });
  mkdirSync(join(steamDir, 'steamapps', 'common', 'Team Fortress 2'), { recursive: true });
  mkdirSync(join(lib2, 'steamapps', 'common', 'rocketleague'), { recursive: true });
  writeFileSync(join(steamDir, 'steam.exe'), '');
  writeFileSync(loginUsers, fixture('loginusers.vdf'));
  writeFileSync(
    join(steamDir, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(steamDir)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(lib2)}"\n\t}\n}\n`,
  );
  writeFileSync(join(steamDir, 'steamapps', 'appmanifest_440.acf'), manifest('440', 'Team Fortress 2', 'Team Fortress 2', 4));
  writeFileSync(join(steamDir, 'steamapps', 'appmanifest_730.acf'), manifest('730', 'Counter-Strike 2', 'Counter-Strike Global Offensive', 1026));
  writeFileSync(join(steamDir, 'steamapps', 'appmanifest_999.acf'), '"AppState" { "name" "broken"');
  writeFileSync(join(steamDir, 'steamapps', 'appmanifest_228980.acf'), manifest('228980', 'Steamworks Common Redistributables', 'Steamworks Shared', 4));
  writeFileSync(join(lib2, 'steamapps', 'appmanifest_252950.acf'), fixture('appmanifest_252950.acf'));

  registry = new StaticRegistry(SteamSim.defaultRegistry(steamDir));
  processes = new StaticProcessController();
  backups = new BackupService(join(root, 'backups'), { keep: () => 20 });
  opened = [];
  autoLogin = true;
  sim = new SteamSim({ steamDir, registry, processes });
  processes.onStart = (exe, args) => sim.onStart(exe, args);
});

/** The steam.autoLogin setting. On for most tests so the -login-with-password paths stay covered. */
let autoLogin: boolean;

/** Stands in for the user finishing the sign-in in the Steam window once One Launch asks. */
function userSignsInWhenAsked(as = 424242): { seen: (LaunchAttention | null)[]; onAttention: (a: LaunchAttention | null) => void } {
  const seen: (LaunchAttention | null)[] = [];
  return {
    seen,
    onAttention: (a) => {
      seen.push(a);
      if (a) setTimeout(() => sim.signInByHand(as), 5);
    },
  };
}
const ID3 = (login: string): number => steamId3(parseLoginUsers(fixture('loginusers.vdf')).find((u) => u.accountName === login)!.steamId64);

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const adapter = (
  defaultInstallDir = join(root, 'nowhere'),
  timing: { shutdownMs?: number; startupMs?: number; signInMs?: number; updateMs?: number; readyGraceMs?: number } = {},
) =>
  new SteamAdapter({
    registry,
    processes,
    backups,
    log: createLogger('test:steam'),
    backupsToKeep: () => 20,
    autoLogin: () => autoLogin,
    openExternal: async (url) => {
      opened.push(url);
    },
    defaultInstallDir,
    timing: { pollMs: 1, shutdownMs: 40, killGraceMs: 20, startupMs: 40, signInMs: 40, guardMs: 40, manualSignInMs: 40, readyGraceMs: 0, ...timing },
  });

const ref = (over: Partial<AccountRef> = {}): AccountRef => ({
  id: 'acct-1',
  displayName: 'Third',
  login: 'user_3',
  launcherUid: '76561198000000003',
  hasSecret: false,
  ...over,
});

const mostRecentOf = (text: string): string[] =>
  parseLoginUsers(text)
    .filter((u) => u.mostRecent)
    .map((u) => u.accountName);

const statusOf = (steps: readonly JobStep[]): [string, string][] => steps.map((s) => [s.title, s.status]);

// ---------------------------------------------------------------------------
// Read-only surface (unchanged from step 2).
// ---------------------------------------------------------------------------

describe('SteamAdapter.detectInstall', () => {
  it('prefers HKCU SteamPath and normalizes its forward slashes', async () => {
    const install = await adapter().detectInstall();
    expect(install).toEqual({
      launcher: 'steam',
      installDir: steamDir.toLowerCase(),
      exePath: join(steamDir, 'steam.exe').toLowerCase(),
      source: 'registry-hkcu',
    });
  });

  it('falls back to HKLM, then the default location, then reports null', async () => {
    registry.delete(`${REG}\\SteamPath`);
    expect((await adapter().detectInstall())?.source).toBe('registry-hklm');
    registry.delete(`HKLM\\${STEAM_HKLM_KEY}\\InstallPath`);
    expect(await adapter().detectInstall()).toBeNull();
    expect((await adapter(steamDir).detectInstall())?.source).toBe('default-path');
  });

  it('ignores a registry path that no longer holds steam.exe', async () => {
    registry.set(`${REG}\\SteamPath`, join(root, 'moved'));
    expect((await adapter().detectInstall())?.source).toBe('registry-hklm');
  });

  it('looks in the folder chosen in Settings first, and says so when Steam is no longer in it', async () => {
    const portable = join(root, 'Portable Steam');
    mkdirSync(portable, { recursive: true });
    writeFileSync(join(portable, 'steam.exe'), '');
    let chosen: string | null = `${portable.replace(/\\/g, '/')}/`;
    const steam = new SteamAdapter({
      registry,
      processes,
      backups,
      log: createLogger('test:steam'),
      backupsToKeep: () => 20,
      openExternal: async () => {},
      installDir: () => chosen,
      defaultInstallDir: join(root, 'nowhere'),
    });

    expect(await steam.detectInstall()).toEqual({ launcher: 'steam', installDir: portable, exePath: join(portable, 'steam.exe'), source: 'user' });
    expect((await steam.healthCheck()).checks.find((c) => c.id === 'install')?.detail).toBe(`${portable} (from the folder chosen in Settings)`);
    expect((await steam.healthCheck()).checks.some((c) => c.id === 'chosen-folder')).toBe(false);

    rmSync(join(portable, 'steam.exe'));
    expect((await steam.detectInstall())?.source).toBe('registry-hkcu');
    expect(steam.chosenInstallDir()).toBe(portable);
    expect((await steam.healthCheck()).checks.find((c) => c.id === 'chosen-folder')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining(`steam.exe is no longer in ${portable}`),
    });

    chosen = null;
    expect(steam.chosenInstallDir()).toBeNull();
    expect((await steam.healthCheck()).checks.some((c) => c.id === 'chosen-folder')).toBe(false);
  });

  it('accepts only steam.exe inside a folder as a located installation', () => {
    const steam = adapter();
    expect(steam.installFromExe(join(steamDir, 'STEAM.EXE'))).toEqual({
      launcher: 'steam',
      installDir: steamDir,
      exePath: join(steamDir, 'steam.exe'),
      source: 'user',
    });
    writeFileSync(join(steamDir, 'steamwebhelper.exe'), '');
    expect(steam.installFromExe(join(steamDir, 'steamwebhelper.exe'))).toBeNull();
    expect(steam.installFromExe(join(root, 'nowhere', 'steam.exe'))).toBeNull();
  });
});

describe('SteamAdapter.healthCheck with what the status pass already knows', () => {
  it('does not ask the process list again, and asks the registry less', async () => {
    const steam = adapter();
    const install = await steam.detectInstall();
    let reads = 0;
    let polls = 0;
    const getString = registry.getString.bind(registry);
    const isRunning = processes.isRunning.bind(processes);
    registry.getString = (hive, key, name) => {
      reads++;
      return getString(hive, key, name);
    };
    processes.isRunning = (image) => {
      polls++;
      return isRunning(image);
    };

    const alone = await steam.healthCheck();
    const [readsAlone, pollsAlone] = [reads, polls];
    expect(alone.checks.find((c) => c.id === 'process')?.detail).toBe('steam.exe is not running');
    expect(pollsAlone).toBe(1);

    reads = 0;
    polls = 0;
    const handed = await steam.healthCheck({ install, running: true });
    expect(handed.checks.find((c) => c.id === 'process')?.detail).toBe('steam.exe is running');
    expect(handed.checks.find((c) => c.id === 'install')?.detail).toBe(alone.checks.find((c) => c.id === 'install')?.detail);
    expect(polls).toBe(0);
    expect(reads).toBeLessThan(readsAlone);

    expect((await steam.healthCheck({ install: null, running: null })).status).toBe('absent');
  });
});

describe('SteamAdapter.listInstalledGames', () => {
  it('scans every library folder, keeps only fully installed games, and skips tools and broken manifests', async () => {
    const games = await adapter().listInstalledGames();
    expect(games.map((g) => g.launcherGameId)).toEqual(['252950', '440']);
    expect(games[0]).toMatchObject({
      launcher: 'steam',
      name: 'Rocket League',
      installPath: join(lib2, 'steamapps', 'common', 'rocketleague'),
      libraryPath: lib2,
      sizeOnDiskBytes: 42795878686,
      lastPlayedAt: new Date(1785117264 * 1000).toISOString(),
      needsUpdate: true,
    });
    expect(games[1]).toMatchObject({ name: 'Team Fortress 2', needsUpdate: false, sizeOnDiskBytes: null, lastPlayedAt: null });
    expect(JSON.stringify(games)).not.toContain('76561198000000001');
  });

  it('still scans the main folder when libraryfolders.vdf is unreadable', async () => {
    writeFileSync(join(steamDir, 'steamapps', 'libraryfolders.vdf'), '"libraryfolders" {');
    expect((await adapter().listInstalledGames()).map((g) => g.launcherGameId)).toEqual(['440']);
  });

  it('throws NOT_INSTALLED when Steam is absent', async () => {
    registry.delete(`${REG}\\SteamPath`);
    registry.delete(`HKLM\\${STEAM_HKLM_KEY}\\InstallPath`);
    await expect(adapter().listInstalledGames()).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });
});

describe('SteamAdapter.listRememberedAccounts', () => {
  it('returns names and IDs only, most recent first', async () => {
    const accounts = await adapter().listRememberedAccounts();
    expect(accounts.map((a) => a.login)).toEqual(['user_1', 'user_2', 'user_3', 'user_4']);
    expect(accounts[0]).toEqual({
      launcher: 'steam',
      launcherUid: '76561198000000001',
      login: 'user_1',
      personaName: 'Persona One',
      rememberPassword: true,
      mostRecent: true,
      lastLoginAt: new Date(1789145779 * 1000).toISOString(),
      sessionMayBeExpired: false,
    });
    // user_3 last signed in 2025-08-14 on the fixture, well past the threshold.
    expect(accounts.find((a) => a.login === 'user_3')?.sessionMayBeExpired).toBe(true);
    expect(STALE_SESSION_DAYS).toBe(60);
  });

  it('reports a missing or unparseable file as a LAUNCHER_FILE error', async () => {
    rmSync(loginUsers);
    await expect(adapter().listRememberedAccounts()).rejects.toMatchObject({ code: 'LAUNCHER_FILE' });
  });

  it('refuses a loginusers.vdf far larger than Steam writes, before parsing it (H16)', async () => {
    writeFileSync(loginUsers, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await expect(adapter().listRememberedAccounts()).rejects.toMatchObject({
      code: 'LAUNCHER_FILE',
      message: expect.stringMatching(/Too large to be a launcher file \(1048577 bytes\)/),
    });
  });
});

describe('SteamAdapter.runningGame', () => {
  it("reads Steam's RunningAppID and the app name", async () => {
    registry.set(`${REG}\\RunningAppID`, 252950);
    registry.set(`${REG}\\Apps\\252950\\Name`, 'Rocket League');
    expect(await adapter().runningGame()).toEqual({ launcher: 'steam', launcherGameId: '252950', name: 'Rocket League', source: 'launcher' });
    registry.delete(`${REG}\\Apps\\252950\\Name`);
    expect((await adapter().runningGame())?.name).toBe('Steam app 252950');
  });

  it('falls back to a process running out of a game folder, and reports none otherwise', async () => {
    processes.processes = [
      { name: 'steam', pid: 1, path: join(steamDir, 'steam.exe') },
      { name: 'RocketLeague', pid: 2, path: join(lib2, 'steamapps', 'common', 'rocketleague', 'Binaries', 'Win64', 'RocketLeague.exe') },
    ];
    expect(await adapter().runningGame()).toEqual({ launcher: 'steam', launcherGameId: '252950', name: 'Rocket League', source: 'process' });
    processes.processes = [{ name: 'notepad', pid: 3, path: 'C:\\Windows\\notepad.exe' }];
    expect(await adapter().runningGame()).toBeNull();
  });
});

describe('SteamAdapter.healthCheck', () => {
  it('is all green on the expected layout', async () => {
    processes.setRunning('steam.exe', true);
    const report = await adapter().healthCheck();
    expect(report.status).toBe('ok');
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ['install', 'ok'],
      ['process', 'ok'],
      ['loginusers', 'ok'],
      ['most-recent-key', 'ok'],
      ['registry', 'ok'],
      ['libraries', 'ok'],
      ['games', 'ok'],
      ['backups', 'ok'],
    ]);
    expect(report.checks.find((c) => c.id === 'games')?.detail).toBe('2 installed games (1 waiting for an update)');
    expect(JSON.stringify(report)).not.toMatch(/user_\d/);
  });

  it('warns when the registry and loginusers.vdf disagree, and fails on a broken library file', async () => {
    registry.set(`${REG}\\AutoLoginUser`, 'user_2');
    writeFileSync(join(steamDir, 'steamapps', 'libraryfolders.vdf'), '"libraryfolders" {');
    const report = await adapter().healthCheck();
    expect(report.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'registry')?.status).toBe('warn');
    expect(report.checks.find((c) => c.id === 'libraries')?.status).toBe('fail');
  });

  it('reports absent, not failing, when Steam is not installed', async () => {
    registry.delete(`${REG}\\SteamPath`);
    registry.delete(`HKLM\\${STEAM_HKLM_KEY}\\InstallPath`);
    const report = await adapter().healthCheck();
    expect(report.status).toBe('absent');
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: 'install', status: 'absent' });
  });
});

// ---------------------------------------------------------------------------
// Dry run.
// ---------------------------------------------------------------------------

describe('SteamAdapter.switchAccount (dry run)', () => {
  it('plans the remembered path with exact file and registry changes and touches nothing', async () => {
    processes.setRunning('steam.exe', true);
    const before = { text: readFileSync(loginUsers, 'utf8'), mtime: statSync(loginUsers).mtimeMs };

    const plan = await adapter().switchAccount(ref(), { dryRun: true });

    expect(plan.strategy).toBe('remembered');
    expect(plan.executable).toBe(true);
    expect(plan.current).toEqual({ mostRecentLogin: 'user_1', autoLoginUser: 'user_1', running: true });
    expect(plan.steps.map((s) => [s.id, s.skipped])).toEqual([
      ['close', false],
      ['backup', false],
      ['file', false],
      ['registry-user', false],
      ['registry-remember', false],
      ['start', false],
      ['wait', false],
      ['verify', false],
      ['login', true],
      ['manual', true],
    ]);
    expect(plan.steps[2]!.changes).toEqual([
      { where: 'line 10', before: '"AutoLogin"\t\t"1"', after: '"AutoLogin"\t\t"0"' },
      { where: 'line 30', before: '"AutoLogin"\t\t"0"', after: '"AutoLogin"\t\t"1"' },
    ]);
    expect(plan.steps[3]!.changes).toEqual([{ where: 'AutoLoginUser', before: 'user_1', after: 'user_3' }]);
    expect(plan.steps[4]!.changes).toEqual([{ where: 'RememberPassword', before: '(absent)', after: '1' }]);
    expect(plan.warnings[0]).toBe('Steam is running. It will be closed, along with any game running under it.');
    expect(plan.warnings[1]).toMatch(/^user_3 last signed in here \d+ days ago\. Steam sessions expire.*wait while you sign in/);
    expect(plan.steps[7]!.target).toBe(`${REG}\\ActiveProcess\\ActiveUser`);
    expect(plan.steps[8]!.detail).toMatch(/Not available: no password is stored/);

    expect(readFileSync(loginUsers, 'utf8')).toBe(before.text);
    expect(statSync(loginUsers).mtimeMs).toBe(before.mtime);
    expect(registry.writes).toEqual([]);
    expect(processes.events).toEqual([]);
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });

  it('treats an already-active account as a no-op', async () => {
    const main = ref({ login: 'user_1', launcherUid: '76561198000000001', displayName: 'Main' });
    const closed = await adapter().switchAccount(main, { dryRun: true });
    expect(closed.steps.map((s) => [s.id, s.skipped])).toEqual([
      ['close', true],
      ['backup', true],
      ['file', true],
      ['registry-user', true],
      ['registry-remember', true],
      ['start', false],
      ['wait', false],
      ['verify', false],
      ['login', true],
      ['manual', true],
    ]);
    expect(closed.notes).toEqual(['Steam is already set to sign in as user_1. The real switch would change nothing.']);
    expect(closed.warnings).toEqual([]);
    processes.setRunning('steam.exe', true);
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_1'));
    const running = await adapter().switchAccount(main, { dryRun: true });
    expect(running.steps.every((s) => s.skipped)).toBe(true);
  });

  it('does not call a running Steam already active when it is signed in as someone else, or sitting on its sign-in form', async () => {
    const main = ref({ login: 'user_1', launcherUid: '76561198000000001', displayName: 'Main' });
    processes.setRunning('steam.exe', true);
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_2'));
    const other = await adapter().switchAccount(main, { dryRun: true });
    expect(other.steps.filter((s) => !s.skipped).map((s) => s.id)).toEqual(['close', 'backup', 'registry-remember', 'start', 'wait', 'verify']);
    expect(other.warnings[0]).toBe(
      "Steam's files already name user_1, but the Steam that is running is signed in as user_2. It will be closed, along with any game running under it, and started again as user_1.",
    );
    expect((await adapter().preflight(main)).alreadyActive).toBe(false);

    // ActiveUser survives an exit, so it can still name user_1 while Steam waits on its form: the login log's last word decides.
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_1'));
    sim.steamSays('SetLoginState: Success - OK');
    expect((await adapter().preflight(main)).alreadyActive).toBe(true);
    sim.steamSays('SetLoginState: WaitingForCredentials - License expired');
    const onForm = await adapter().preflight(main);
    expect(onForm.alreadyActive).toBe(false);
    // The dialog's confirm box says Steam will be closed, so the preflight's plan leaves that warning out; the preview keeps it.
    expect(onForm.plan.warnings.join('\n')).not.toContain('It will be closed');
    expect((await adapter().switchAccount(main, { dryRun: true })).warnings[0]).toMatch(/is not signed in as user_1\. It will be closed/);
  });

  it('plans the credentials path for an unknown account without any password in the plan', async () => {
    const plan = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null, displayName: 'New' }), { dryRun: true });
    expect(plan.strategy).toBe('credentials');
    expect(plan.executable).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(['close', 'backup', 'login', 'wait', 'verify', 'manual']);
    expect(plan.steps[2]!.title).toBe('Start Steam on its sign-in form');
    expect(plan.steps[2]!.target).toBe(`"${join(steamDir, 'steam.exe').toLowerCase()}" -login nobody`);
    expect(plan.warnings[0]).toMatch(/Steam will open its sign-in form for nobody/);
    expect(plan.warnings[0]).toMatch(/offers to copy the login;/);
    const withSecret = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null, hasSecret: true }), { dryRun: true });
    expect(withSecret.executable).toBe(true);
    expect(withSecret.steps[2]!.title).toBe('Start Steam with credentials');
    expect(withSecret.steps[2]!.target).toBe(`"${join(steamDir, 'steam.exe').toLowerCase()}" -login nobody <password>`);
  });

  it('matches by login when the stored SteamID64 is wrong, and flags registry/file disagreement', async () => {
    const plan = await adapter().switchAccount(ref({ login: 'user_2', launcherUid: '76561198000000099' }), { dryRun: true });
    expect(plan.account.launcherUid).toBe('76561198000000002');
    expect(plan.warnings.some((w) => w.includes('76561198000000099'))).toBe(true);
    registry.set(`${REG}\\AutoLoginUser`, 'user_4');
    const plan2 = await adapter().switchAccount(ref(), { dryRun: true });
    expect(plan2.warnings.some((w) => w.startsWith('Registry AutoLoginUser (user_4)'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

describe('SteamAdapter.preflight', () => {
  it('reports the running game only when the switch would actually close Steam', async () => {
    processes.setRunning('steam.exe', true);
    registry.set(`${REG}\\RunningAppID`, 440);
    registry.set(`${REG}\\Apps\\440\\Name`, 'Team Fortress 2');
    const pf = await adapter().preflight(ref());
    expect(pf.launcherRunning).toBe(true);
    expect(pf.alreadyActive).toBe(false);
    expect(pf.runningGame?.name).toBe('Team Fortress 2');

    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_1'));
    const active = await adapter().preflight(ref({ login: 'user_1', launcherUid: '76561198000000001' }));
    expect(active.alreadyActive).toBe(true);
    expect(active.runningGame).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The real switch, against temp copies only.
// ---------------------------------------------------------------------------

describe('SteamAdapter.switchAccount (real, remembered path)', () => {
  const FULL_TITLES = [
    'Close Steam',
    'Back up Steam files',
    'Mark the account as most recent',
    'Point Steam at the account',
    'Keep the session remembered',
    'Start Steam',
    'Wait for Steam to come up',
    'Confirm Steam signed in',
    'Fallback: sign in with the stored password',
    'Wait for you to sign in',
  ];

  it('does not trust an ActiveUser that already equalled the target before Steam started; the log has to confirm it', async () => {
    // Steam was closed by hand after signing in as user_3: ActiveUser still holds its id (Steam never clears it),
    // while the registry says Steam will sign in as user_1 next, so this is a real switch.
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_3'));
    registry.set(`${REG}\\AutoLoginUser`, 'user_1');
    const base = processes.onStart;

    // The simulated Steam writes the same id again but never logs a sign-in: not confirmed, handed over, times out.
    let result = await adapter().switchAccount(ref(), { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.needsSignIn).toBe(true);
    expect(statusOf(result.steps)).toContainEqual(['Confirm Steam signed in', 'failed']);

    // Same stale id, but Steam's own log reports the sign-in after the start: confirmed. (The first run left the
    // file marking user_3 and the fake Steam running; put Steam down and point the registry elsewhere again.)
    processes.setRunning('steam.exe', false);
    registry.set(`${REG}\\AutoLoginUser`, 'user_1');
    processes.onStart = (exe, args) => {
      base?.(exe, args);
      if (!args.includes('-shutdown')) sim.steamSays('SetLoginState: Success - OK');
    };
    result = await adapter().switchAccount(ref(), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(statusOf(result.steps)).toContainEqual(['Confirm Steam signed in', 'done']);
  });

  it('closes Steam, backs up, rewrites the file, sets the registry, restarts Steam, and confirms the sign-in', async () => {
    processes.setRunning('steam.exe', true);
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_1'));
    const original = readFileSync(loginUsers, 'utf8');
    const progress: [string, string][][] = [];

    const result = await adapter().switchAccount(ref(), { dryRun: false, confirmClose: true, onProgress: (s) => progress.push(statusOf(s)) });

    expect(result.ok).toBe(true);
    expect(result.needsSignIn).toBe(false);
    expect(result.error).toBeNull();
    expect(result.restored).toBeNull();
    expect(statusOf(result.steps)).toEqual([
      ['Close Steam', 'done'],
      ['Back up Steam files', 'done'],
      ['Mark the account as most recent', 'done'],
      ['Point Steam at the account', 'done'],
      ['Keep the session remembered', 'done'],
      ['Start Steam', 'done'],
      ['Wait for Steam to come up', 'done'],
      ['Confirm Steam signed in', 'done'],
      ['Fallback: sign in with the stored password', 'skipped'],
      ['Wait for you to sign in', 'skipped'],
    ]);
    expect(result.steps[7]!.detail).toBe('Steam signed in as user_3.');
    expect(progress.length).toBeGreaterThan(6);
    expect(progress[0]!.map(([t]) => t)).toEqual(FULL_TITLES);
    expect(progress[0]![0]).toEqual(['Close Steam', 'running']);

    // Processes: graceful shutdown, then a plain start. No kill, no -login.
    expect(processes.events.map((e) => [e.kind, e.args])).toEqual([
      ['start', ['-shutdown']],
      ['start', []],
    ]);
    expect(await processes.isRunning('steam.exe')).toBe(true);

    // File: only the AutoLogin flags moved.
    const after = readFileSync(loginUsers, 'utf8');
    expect(mostRecentOf(after)).toEqual(['user_3']);
    expect(after.split('\n').length).toBe(original.split('\n').length);

    // Registry: exactly the two documented writes.
    expect(registry.writes).toEqual([
      { op: 'set', path: `${REG}\\AutoLoginUser`, value: 'user_3' },
      { op: 'set', path: `${REG}\\RememberPassword`, value: 1 },
    ]);

    // Backup: the pre-switch file and registry values, taken after shutdown.
    expect(result.backupId).not.toBeNull();
    const snapshot = backups.get('steam', result.backupId!)!;
    expect(snapshot.files).toEqual(['config/loginusers.vdf']);
    expect(readFileSync(join(snapshot.path, 'config', 'loginusers.vdf'), 'utf8')).toBe(original);
    const manifest = JSON.parse(readFileSync(join(snapshot.path, 'manifest.json'), 'utf8'));
    expect(manifest.meta).toEqual({ AutoLoginUser: 'user_1', RememberPassword: null });
    expect(manifest.reason).toBe('Before switching to Third');
    expect(JSON.stringify(manifest)).not.toContain('user_3');
  });

  it('refuses to close a running Steam without confirmation, naming the running game', async () => {
    processes.setRunning('steam.exe', true);
    registry.set(`${REG}\\RunningAppID`, 440);
    registry.set(`${REG}\\Apps\\440\\Name`, 'Team Fortress 2');
    const err = await adapter()
      .switchAccount(ref(), { dryRun: false })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'CONFIRM_REQUIRED',
      message: 'Steam is running Team Fortress 2. Switching closes Steam and the game; unsaved progress in the game is lost.',
    });
    expect((err as { runningGame: { launcherGameId: string } }).runningGame.launcherGameId).toBe('440');
    expect(readFileSync(loginUsers, 'utf8')).toBe(fixture('loginusers.vdf'));
    expect(registry.writes).toEqual([]);
    expect(processes.events).toEqual([]);
  });

  it('needs no confirmation when Steam is closed, and skips the shutdown', async () => {
    const result = await adapter().switchAccount(ref(), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(statusOf(result.steps)[0]).toEqual(['Close Steam', 'skipped']);
    expect(processes.events.map((e) => e.args)).toEqual([[]]);
    expect(mostRecentOf(readFileSync(loginUsers, 'utf8'))).toEqual(['user_3']);
  });

  it('does nothing at all for the already-active account while Steam runs', async () => {
    processes.setRunning('steam.exe', true);
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_1'));
    const result = await adapter().switchAccount(ref({ login: 'user_1', launcherUid: '76561198000000001' }), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.backupId).toBeNull();
    expect(result.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(processes.events).toEqual([]);
    expect(registry.writes).toEqual([]);
    expect(backups.list('steam')).toEqual([]);
  });

  it('escalates to a forced kill when -shutdown is ignored', async () => {
    processes.setRunning('steam.exe', true);
    processes.shutdownPolls = 1_000_000;
    const result = await adapter().switchAccount(ref(), { dryRun: false, confirmClose: true });
    expect(result.ok).toBe(true);
    expect(processes.events.map((e) => e.kind)).toEqual(['start', 'kill', 'start']);
  });

  it('fails before touching anything when Steam cannot be closed at all', async () => {
    processes.setRunning('steam.exe', true);
    processes.shutdownPolls = 1_000_000;
    processes.kill = async () => {
      processes.events.push({ kind: 'kill', exe: 'steam.exe', args: [] });
    };
    const result = await adapter().switchAccount(ref(), { dryRun: false, confirmClose: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/still running/);
    expect(result.backupId).toBeNull();
    expect(result.restored).toBeNull();
    expect(statusOf(result.steps)[0]).toEqual(['Close Steam', 'failed']);
    expect(readFileSync(loginUsers, 'utf8')).toBe(fixture('loginusers.vdf'));
    expect(registry.writes).toEqual([]);
    expect(backups.list('steam')).toEqual([]);
  });

  it('rolls back the file and registry from the snapshot when a registry write fails', async () => {
    processes.setRunning('steam.exe', true);
    const original = readFileSync(loginUsers, 'utf8');
    registry.failNextWrite = 'reg add exploded';

    const result = await adapter().switchAccount(ref(), { dryRun: false, confirmClose: true });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('reg add exploded');
    expect(result.restored).toBe(true);
    expect(result.backupId).not.toBeNull();
    expect(statusOf(result.steps).slice(0, 5)).toEqual([
      ['Close Steam', 'done'],
      ['Back up Steam files', 'done'],
      ['Mark the account as most recent', 'done'],
      ['Point Steam at the account', 'failed'],
      ['Keep the session remembered', 'pending'],
    ]);
    // The file is byte-identical to before, and the registry was put back to its recorded state.
    expect(readFileSync(loginUsers, 'utf8')).toBe(original);
    expect(registry.writes).toEqual([
      { op: 'set', path: `${REG}\\AutoLoginUser`, value: 'user_1' },
      { op: 'delete', path: `${REG}\\RememberPassword` },
    ]);
    expect(await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_1');
    expect(await registry.getDword('HKCU', STEAM_HKCU_KEY, 'RememberPassword')).toBeNull();
    // Steam is left closed; the user decides what to do next.
    expect(processes.events.map((e) => e.args)).toEqual([['-shutdown']]);
  });

  it('rolls back when Steam does not come back up after the writes', async () => {
    const original = readFileSync(loginUsers, 'utf8');
    processes.startFails = true;
    const result = await adapter().switchAccount(ref(), { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not appear/);
    expect(result.restored).toBe(true);
    expect(statusOf(result.steps).slice(5, 7)).toEqual([
      ['Start Steam', 'done'],
      ['Wait for Steam to come up', 'failed'],
    ]);
    expect(readFileSync(loginUsers, 'utf8')).toBe(original);
    expect(await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_1');
  });

  it('waits for a manual sign-in, without rollback, when the session is expired and no password is stored', async () => {
    sim.knobs.expiredSessions.push('user_3');
    const seen: (LaunchAttention | null)[] = [];
    const result = await adapter().switchAccount(ref(), { dryRun: false, onAttention: (a) => seen.push(a) });
    expect(result.ok).toBe(false);
    expect(result.needsSignIn).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.restored).toBeNull();
    expect(result.error).toMatch(/^One Launch waited .* for the sign-in as user_3 and gave up\./);
    expect(statusOf(result.steps).slice(7)).toEqual([
      ['Confirm Steam signed in', 'failed'],
      ['Fallback: sign in with the stored password', 'skipped'],
      ['Wait for you to sign in', 'failed'],
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ kind: 'sign-in', title: 'Steam is asking you to sign in as user_3', canCopyPassword: false, reason: null });
    expect(seen[1]).toBeNull();
    // The switch itself stands: Steam is pointed at user_3 and left on its sign-in form.
    expect(mostRecentOf(readFileSync(loginUsers, 'utf8'))).toEqual(['user_3']);
    expect(await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_3');
    expect(processes.events.map((e) => e.args)).toEqual([[]]);
    expect(await processes.isRunning('steam.exe')).toBe(true);
  });

  it('continues with the switch when the user signs in by hand during the wait', async () => {
    sim.knobs.expiredSessions.push('user_3');
    const user = userSignsInWhenAsked(ID3('user_3'));
    const result = await adapter().switchAccount(ref(), { dryRun: false, onAttention: user.onAttention });
    expect(result.ok).toBe(true);
    expect(result.needsSignIn).toBe(false);
    expect(statusOf(result.steps).at(-1)).toEqual(['Wait for you to sign in', 'done']);
    expect(user.seen.at(-1)).toBeNull();
  });

  it('reports the reason from steamui_login.txt at once instead of waiting for the timeout', async () => {
    sim.knobs.expiredSessions.push('user_3');
    processes.onStart = () => {
      sim.steamSays('SetLoginState: WaitingForCredentials - License expired');
      registry.set(`${REG}\\ActiveProcess\\ActiveUser`, 0);
    };
    const seen: (LaunchAttention | null)[] = [];
    const a = new SteamAdapter({
      registry,
      processes,
      backups,
      log: createLogger('test:steam'),
      backupsToKeep: () => 20,
      openExternal: async () => {},
      defaultInstallDir: join(root, 'nowhere'),
      timing: { pollMs: 1, shutdownMs: 40, killGraceMs: 20, startupMs: 40, signInMs: 5_000, guardMs: 5_000, manualSignInMs: 20 },
    });
    const started = Date.now();
    const result = await a.switchAccount(ref(), { dryRun: false, onAttention: (x) => seen.push(x) });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.needsSignIn).toBe(true);
    expect(result.steps.find((s) => s.title === 'Confirm Steam signed in')?.detail).toBe('Steam is asking for credentials: License expired.');
    expect(seen[0]).toMatchObject({ reason: 'License expired', message: expect.stringMatching(/^Its remembered session has expired\./) });
  });

  it('stops without rollback when the caller cancels the wait', async () => {
    sim.knobs.expiredSessions.push('user_3');
    const controller = new AbortController();
    const result = await adapter().switchAccount(ref(), {
      dryRun: false,
      signal: controller.signal,
      onAttention: (a) => {
        if (a) setTimeout(() => controller.abort(), 5);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.needsSignIn).toBe(false);
    expect(result.restored).toBeNull();
    expect(result.error).toMatch(/^Stopped waiting for the sign-in as user_3\./);
    expect(statusOf(result.steps).at(-1)).toEqual(['Wait for you to sign in', 'failed']);
    expect(mostRecentOf(readFileSync(loginUsers, 'utf8'))).toEqual(['user_3']);
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

  it('reports the snapshot, already on disk, before the first write', async () => {
    const original = readFileSync(loginUsers, 'utf8');
    let seen: { id: string; file: string; writes: number; listed: string[] } | null = null;
    const result = await adapter().switchAccount(ref(), {
      dryRun: false,
      onBackup: (id) => {
        seen = { id, file: readFileSync(loginUsers, 'utf8'), writes: registry.writes.length, listed: backups.list('steam').map((s) => s.id) };
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ id: result.backupId, file: original, writes: 0, listed: [result.backupId] });
    expect(readFileSync(loginUsers, 'utf8')).not.toBe(original);
  });

  it('writes only the registry values that differ from what is there (C8)', async () => {
    registry.set(`${REG}\\RememberPassword`, 1);
    const result = await adapter().switchAccount(ref(), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(statusOf(result.steps).slice(2, 5)).toEqual([
      ['Mark the account as most recent', 'done'],
      ['Point Steam at the account', 'done'],
      ['Keep the session remembered', 'skipped'],
    ]);
    expect(registry.writes).toEqual([{ op: 'set', path: `${REG}\\AutoLoginUser`, value: 'user_3' }]);
  });

  it('a switch whose files already name the account writes nothing, so a failure rolls nothing back and the journal never hears of the snapshot', async () => {
    const main = ref({ login: 'user_1', launcherUid: '76561198000000001', displayName: 'Main' });
    processes.setRunning('steam.exe', true);
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_2'));
    registry.set(`${REG}\\RememberPassword`, 1);
    processes.startFails = true;
    const reported: string[] = [];
    const result = await adapter().switchAccount(main, { dryRun: false, confirmClose: true, onBackup: (id) => reported.push(id) });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: null });
    expect(result.error).toMatch(/did not appear/);
    expect(statusOf(result.steps).slice(1, 5)).toEqual([
      ['Back up Steam files', 'done'],
      ['Mark the account as most recent', 'skipped'],
      ['Point Steam at the account', 'skipped'],
      ['Keep the session remembered', 'skipped'],
    ]);
    expect(reported).toEqual([]);
    expect(registry.writes).toEqual([]);
    expect(readFileSync(loginUsers, 'utf8')).toBe(fixture('loginusers.vdf'));
    expect(backups.list('steam').map((s) => s.id)).toEqual([result.backupId]);
  });

  it('an abort while Steam is closing stops at once with nothing changed', async () => {
    processes.setRunning('steam.exe', true);
    processes.shutdownPolls = 1_000_000;
    const started = Date.now();
    const result = await adapter(undefined, { shutdownMs: 2_000 }).switchAccount(ref(), {
      dryRun: false,
      confirmClose: true,
      ...abortWhen('Close Steam', 'running'),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ ok: false, cancelled: true, needsSignIn: false, restored: null, backupId: null });
    expect(result.error).toBe('Stopped before Steam was started as user_3. Nothing had been changed.');
    expect(result.steps[0]).toMatchObject({ title: 'Close Steam', status: 'failed', detail: 'Stopped.' });
    expect(processes.events.map((e) => e.args)).toEqual([['-shutdown']]);
    expect(readFileSync(loginUsers, 'utf8')).toBe(fixture('loginusers.vdf'));
    expect(registry.writes).toEqual([]);
    expect(backups.list('steam')).toEqual([]);
  });

  it('an abort after the writes but before Steam is started puts them back', async () => {
    const original = readFileSync(loginUsers, 'utf8');
    const result = await adapter().switchAccount(ref(), { dryRun: false, ...abortWhen('Keep the session remembered', 'done') });
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: true });
    expect(result.error).toBe('Stopped before Steam was started as user_3.');
    expect(result.backupId).not.toBeNull();
    expect(readFileSync(loginUsers, 'utf8')).toBe(original);
    expect(await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_1');
    expect(processes.events).toEqual([]);
  });

  it('an abort once Steam has been started ends the wait and leaves the writes alone', async () => {
    processes.startFails = true;
    const started = Date.now();
    const result = await adapter(undefined, { startupMs: 2_000 }).switchAccount(ref(), { dryRun: false, ...abortWhen('Wait for Steam to come up', 'running') });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ ok: false, cancelled: true, restored: null });
    expect(result.error).toBe('Stopped while Steam was starting as user_3. Nothing was rolled back: Steam carries on signing in on its own.');
    expect(mostRecentOf(readFileSync(loginUsers, 'utf8'))).toEqual(['user_3']);
    expect(await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_3');
  });

  it('a rollback is never interrupted by the abort: Steam is closed before the file goes back', async () => {
    sim.knobs.expiredSessions.push('user_3');
    sim.knobs.loginVerdict = 'Invalid Password';
    const original = readFileSync(loginUsers, 'utf8');
    const controller = new AbortController();
    let failures = 0;
    let last = '';
    const result = await adapter().switchAccount(ref({ hasSecret: true }), {
      dryRun: false,
      getPassword: () => 'wrong',
      signal: controller.signal,
      onProgress: (steps) => {
        // The second failed confirmation is the rejected password; abort right as the adapter is about to roll back.
        const verify = steps.find((s) => s.title === 'Confirm Steam signed in')!.status;
        if (verify !== last && verify === 'failed' && ++failures === 2) controller.abort();
        last = verify;
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: true });
    expect(readFileSync(loginUsers, 'utf8')).toBe(original);
    expect(processes.events.at(-1)?.args).toEqual(['-shutdown']);
    expect(await processes.isRunning('steam.exe')).toBe(false);
  });

  it('falls back to -login with the stored password when the session is expired', async () => {
    sim.knobs.expiredSessions.push('user_3');
    let asked = 0;
    const result = await adapter().switchAccount(ref({ hasSecret: true }), {
      dryRun: false,
      getPassword: () => {
        asked++;
        return 'correct horse';
      },
    });
    expect(result.ok).toBe(true);
    expect(result.needsSignIn).toBe(false);
    expect(asked).toBe(1);
    expect(statusOf(result.steps).slice(5)).toEqual([
      ['Start Steam', 'done'],
      ['Wait for Steam to come up', 'done'],
      ['Confirm Steam signed in', 'done'],
      ['Fallback: sign in with the stored password', 'done'],
      ['Wait for you to sign in', 'skipped'],
    ]);
    // Plain start, Steam sits on the form, so: close it and start again with credentials.
    expect(processes.events.map((e) => e.args)).toEqual([[], ['-shutdown'], ['-login', 'user_3', 'correct horse']]);
    expect(await registry.getDword('HKCU', `${STEAM_HKCU_KEY}\\ActiveProcess`, 'ActiveUser')).toBe(ID3('user_3'));
  });

  it('rolls back when Steam rejects the stored password on the fallback -login', async () => {
    sim.knobs.expiredSessions.push('user_3');
    sim.knobs.loginVerdict = 'Invalid Password';
    const original = readFileSync(loginUsers, 'utf8');
    const seen: (LaunchAttention | null)[] = [];
    const result = await adapter().switchAccount(ref({ hasSecret: true }), { dryRun: false, getPassword: () => 'wrong', onAttention: (a) => seen.push(a) });
    expect(result.ok).toBe(false);
    expect(result.needsSignIn).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.error).toBe('Steam rejected the stored password for user_3. Update it on the account page and try again.');
    expect(seen).toEqual([]);
    expect(readFileSync(loginUsers, 'utf8')).toBe(original);
    expect(await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_1');
    // Steam (on its form) was closed before the file was put back.
    expect(processes.events.at(-1)?.args).toEqual(['-shutdown']);
  });

  it('hands over to the user when the fallback -login gets no verdict from Steam at all', async () => {
    sim.knobs.expiredSessions.push('user_3');
    sim.knobs.wrongPassword = true;
    const seen: (LaunchAttention | null)[] = [];
    const result = await adapter().switchAccount(ref({ hasSecret: true }), { dryRun: false, getPassword: () => 'pw', onAttention: (a) => seen.push(a) });
    expect(result.ok).toBe(false);
    expect(result.needsSignIn).toBe(true);
    expect(result.restored).toBeNull();
    expect(seen[0]).toMatchObject({ title: 'Steam is asking you to sign in as user_3', canCopyPassword: true, reason: null });
    expect(mostRecentOf(readFileSync(loginUsers, 'utf8'))).toEqual(['user_3']);
  });

  it('skips the password retry and goes straight to the user when Steam Guard is the reason', async () => {
    sim.knobs.expiredSessions.push('user_3');
    processes.onStart = (_exe, args) => {
      if (args.includes('-shutdown')) return;
      sim.steamSays('SetLoginState: WaitingForCredentials - Account Logon Denied');
      registry.set(`${REG}\\ActiveProcess\\ActiveUser`, 0);
    };
    let asked = 0;
    const user = userSignsInWhenAsked(ID3('user_3'));
    const result = await adapter().switchAccount(ref({ hasSecret: true }), {
      dryRun: false,
      getPassword: () => (asked++, 'pw'),
      onAttention: user.onAttention,
    });
    expect(result.ok).toBe(true);
    expect(asked).toBe(0);
    expect(processes.events.map((e) => e.args)).toEqual([[]]);
    expect(user.seen[0]).toMatchObject({ title: 'Steam needs a one-time sign-in on this PC', reason: 'Account Logon Denied' });
  });

  it('never asks for the password when the remembered session works', async () => {
    let asked = 0;
    const result = await adapter().switchAccount(ref({ hasSecret: true }), { dryRun: false, getPassword: () => (asked++, 'unused') });
    expect(result.ok).toBe(true);
    expect(asked).toBe(0);
  });
});

describe('SteamAdapter.switchAccount (real, readiness before the launch link)', () => {
  /** The simulated Steam names the account in ActiveUser at once and reports Success (library loaded) `ms` later, or never. */
  const libraryReadyAfter = (ms: number | null): void => {
    const base = processes.onStart;
    processes.onStart = (exe, args) => {
      base?.(exe, args);
      if (!args.includes('-shutdown') && ms !== null) setTimeout(() => sim.steamSays('SetLoginState: Success - OK'), ms);
    };
  };

  it('returns only once the login log reports Success, so the launch link does not reach a client that is still loading', async () => {
    libraryReadyAfter(60);
    const started = Date.now();
    const result = await adapter(undefined, { readyGraceMs: 2_000 }).switchAccount(ref(), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('gives up waiting after the grace, and an abort during it still counts as switched', async () => {
    libraryReadyAfter(null);
    const started = Date.now();
    const bounded = await adapter(undefined, { readyGraceMs: 50 }).switchAccount(ref(), { dryRun: false });
    expect(bounded.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);

    processes.setRunning('steam.exe', false);
    registry.set(`${REG}\\AutoLoginUser`, 'user_1');
    const controller = new AbortController();
    const aborted = await adapter(undefined, { readyGraceMs: 5_000 }).switchAccount(ref({ login: 'user_2', launcherUid: '76561198000000002' }), {
      dryRun: false,
      signal: controller.signal,
      onProgress: (steps) => {
        if (steps.some((s) => s.title === 'Confirm Steam signed in' && s.status === 'done')) setTimeout(() => controller.abort(), 5);
      },
    });
    expect(aborted).toMatchObject({ ok: true, cancelled: false });
  });

  it('does not wait at all for a Steam it did not start', async () => {
    processes.setRunning('steam.exe', true);
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_1'));
    const started = Date.now();
    const result = await adapter(undefined, { readyGraceMs: 5_000 }).switchAccount(ref({ login: 'user_1', launcherUid: '76561198000000001' }), {
      dryRun: false,
    });
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('SteamAdapter.switchAccount (real, a Steam that something else started)', () => {
  const main = (): AccountRef => ref({ login: 'user_1', launcherUid: '76561198000000001', displayName: 'Main' });
  /** Steam is down when the plan is built and up at every later look, the way a second start lands in the middle of a switch. */
  const steamAppearsAfterThePlan = (): void => {
    let looks = 0;
    processes.isRunning = async () => looks++ > 0;
  };

  it('stops before changing anything when Steam appears before the writes', async () => {
    steamAppearsAfterThePlan();
    const result = await adapter().switchAccount(ref(), { dryRun: false });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: null, backupId: null });
    expect(result.error).toBe(
      'Steam was started by something else while One Launch was switching accounts, so the switch stopped before changing anything. Try again.',
    );
    expect(result.steps[0]).toMatchObject({ title: 'Close Steam', status: 'failed' });
    expect(readFileSync(loginUsers, 'utf8')).toBe(fixture('loginusers.vdf'));
    expect(registry.writes).toEqual([]);
    expect(backups.list('steam')).toEqual([]);
    expect(processes.events).toEqual([]);
  });

  it('never closes a Steam it was not allowed to close: the credentials path stops the same way', async () => {
    steamAppearsAfterThePlan();
    const result = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null }), { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Steam was started by something else/);
    expect(processes.events).toEqual([]);
    expect(backups.list('steam')).toEqual([]);
  });

  it('rolls the writes back when Steam appears while they are being made', async () => {
    const original = readFileSync(loginUsers, 'utf8');
    const result = await adapter().switchAccount(ref(), {
      dryRun: false,
      onProgress: (steps) => {
        if (steps.some((s) => s.title === 'Keep the session remembered' && s.status === 'done')) processes.setRunning('steam.exe', true);
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: false, restored: true });
    expect(result.error).toBe('Steam was started by something else while One Launch was switching accounts, so the switch was stopped. Try again.');
    expect(statusOf(result.steps).slice(5, 8)).toEqual([
      ['Start Steam', 'failed'],
      ['Wait for Steam to come up', 'pending'],
      ['Confirm Steam signed in', 'pending'],
    ]);
    expect(readFileSync(loginUsers, 'utf8')).toBe(original);
    expect(await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe('user_1');
    // Steam is closed before the file goes back, and never started by the switch.
    expect(processes.events.map((e) => e.args)).toEqual([['-shutdown']]);
  });

  it('leaves a Steam that is already signed in as the account alone when the switch changes nothing', async () => {
    steamAppearsAfterThePlan();
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_1'));
    const result = await adapter().switchAccount(main(), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(statusOf(result.steps).slice(5, 8)).toEqual([
      ['Start Steam', 'skipped'],
      ['Wait for Steam to come up', 'skipped'],
      ['Confirm Steam signed in', 'skipped'],
    ]);
    expect(processes.events).toEqual([]);
    expect(registry.writes).toEqual([]);
  });

  it('judges such a Steam only by what its log says after the switch began, never by older lines', async () => {
    sim.steamSays('SetLoginState: WaitingForCredentials - Invalid Password');
    steamAppearsAfterThePlan();
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, 0);
    setTimeout(() => {
      sim.steamSays('SetLoginState: Success - OK');
      registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_1'));
    }, 10);
    const seen: (LaunchAttention | null)[] = [];
    const result = await adapter().switchAccount(main(), { dryRun: false, onAttention: (a) => seen.push(a) });
    expect(result.ok).toBe(true);
    expect(statusOf(result.steps)[7]).toEqual(['Confirm Steam signed in', 'done']);
    expect(seen).toEqual([]);
  });

  it('confirms the sign-in after starting Steam itself, even when the plan had found it running', async () => {
    processes.setRunning('steam.exe', true);
    registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_1'));
    let looks = 0;
    // Running for the plan and the confirmation check, gone by the start step.
    processes.isRunning = async () => looks++ < 1;
    const original = processes.start.bind(processes);
    processes.start = async (exe, args) => {
      processes.isRunning = StaticProcessController.prototype.isRunning.bind(processes);
      await original(exe, args);
      sim.steamSays('SetLoginState: Success - OK');
    };
    const result = await adapter().switchAccount(main(), { dryRun: false });
    expect(result.ok).toBe(true);
    expect(statusOf(result.steps).slice(5, 8)).toEqual([
      ['Start Steam', 'done'],
      ['Wait for Steam to come up', 'done'],
      ['Confirm Steam signed in', 'done'],
    ]);
  });
});

describe('SteamAdapter.switchAccount (real, Steam updates itself first)', () => {
  /** The simulated Steam updates itself for `ms` before it signs in (or, with `ms` null, never finishes). */
  const steamUpdatesFor = (ms: number | null): void => {
    sim.knobs.selfUpdateMs = ms ?? -1;
  };

  it('ignores an update that the log recorded before this start', async () => {
    STEAM_UPDATE_LINES.forEach((line) => sim.bootstrapSays(line));
    sim.knobs.expiredSessions.push('user_3');
    const started = Date.now();
    const result = await adapter(undefined, { updateMs: 5_000 }).switchAccount(ref(), { dryRun: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.needsSignIn).toBe(true);
    expect(result.steps.find((s) => s.title === 'Confirm Steam signed in')?.detail).toBe('Steam did not report a sign-in in time.');
  });

  it('starts the sign-in budget over when the update ends, instead of timing out in the middle of it', async () => {
    // The update outlasts the sign-in budget, so without the restart the wait would end mid-update; the second the restarted budget then gives the sign-in is the margin a starved CI runner needs (300 ms was not).
    steamUpdatesFor(1_500);
    const seen: (LaunchAttention | null)[] = [];
    const details: string[] = [];
    const result = await adapter(undefined, { signInMs: 1_000, updateMs: 5_000 }).switchAccount(ref(), {
      dryRun: false,
      onAttention: (a) => seen.push(a),
      onProgress: (steps) => details.push(steps.find((s) => s.title === 'Confirm Steam signed in')!.detail),
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([]);
    expect(details).toContain('Steam is updating itself first; the sign-in follows when it has finished.');
    expect(details).toContain('Steam finished updating itself.');
    expect(processes.events.map((e) => e.args)).toEqual([[]]);
  });

  it('never closes Steam for the password retry while it is still updating; it hands over instead', async () => {
    steamUpdatesFor(null);
    const seen: (LaunchAttention | null)[] = [];
    let asked = 0;
    const started = Date.now();
    const result = await adapter(undefined, { updateMs: 120 }).switchAccount(ref({ hasSecret: true }), {
      dryRun: false,
      getPassword: () => (asked++, 'pw'),
      onAttention: (a) => seen.push(a),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
    expect(result).toMatchObject({ ok: false, needsSignIn: true, restored: null });
    expect(asked).toBe(0);
    expect(processes.events.map((e) => e.args)).toEqual([[]]);
    expect(result.steps.find((s) => s.title === 'Confirm Steam signed in')).toMatchObject({ status: 'failed', detail: 'Steam is still updating itself.' });
    expect(seen[0]).toMatchObject({ title: 'Steam is still updating itself' });
  });

  it('stops extending the wait once steam.exe is gone', async () => {
    steamUpdatesFor(null);
    const base = processes.onStart;
    processes.onStart = (exe, args) => {
      base?.(exe, args);
      setTimeout(() => processes.setRunning('steam.exe', false), 20);
    };
    const started = Date.now();
    const result = await adapter(undefined, { updateMs: 5_000 }).switchAccount(ref(), { dryRun: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ ok: false, needsSignIn: true });
  });
});

describe('SteamAdapter.switchAccount (real, credentials path)', () => {
  it('starts Steam with -login for an account Steam has never seen and confirms any new sign-in', async () => {
    const result = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null, displayName: 'New', hasSecret: true }), {
      dryRun: false,
      getPassword: () => 'pw',
    });
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('credentials');
    expect(statusOf(result.steps)).toEqual([
      ['Close Steam', 'skipped'],
      ['Back up Steam files', 'done'],
      ['Start Steam with credentials', 'done'],
      ['Wait for Steam to come up', 'done'],
      ['Confirm Steam signed in', 'done'],
      ['Wait for you to sign in', 'skipped'],
    ]);
    expect(processes.events.map((e) => e.args)).toEqual([['-login', 'nobody', 'pw']]);
    // No file or registry writes of our own; Steam does that part itself.
    expect(registry.writes).toEqual([]);
    expect(readFileSync(loginUsers, 'utf8')).toBe(fixture('loginusers.vdf'));
    expect(result.backupId).not.toBeNull();
  });

  it('keeps its snapshot out of the journal, since this path writes nothing of Steam', async () => {
    const reported: string[] = [];
    const result = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null }), { dryRun: false, onBackup: (id) => reported.push(id) });
    expect(result.needsSignIn).toBe(true);
    expect(result.backupId).not.toBeNull();
    expect(backups.list('steam').map((s) => s.id)).toEqual([result.backupId]);
    expect(reported).toEqual([]);
  });

  it('parks on the Steam Guard prompt for a PC the account has never used, then finishes once the user signs in', async () => {
    sim.knobs.loginVerdict = 'Account Logon Denied';
    const user = userSignsInWhenAsked();
    const result = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null, displayName: 'New', hasSecret: true }), {
      dryRun: false,
      getPassword: () => 'pw',
      onAttention: user.onAttention,
    });
    expect(result.ok).toBe(true);
    expect(statusOf(result.steps).slice(2)).toEqual([
      ['Start Steam with credentials', 'done'],
      ['Wait for Steam to come up', 'done'],
      ['Confirm Steam signed in', 'failed'],
      ['Wait for you to sign in', 'done'],
    ]);
    expect(user.seen).toHaveLength(2);
    expect(user.seen[0]).toMatchObject({
      kind: 'sign-in',
      title: 'Steam needs a one-time sign-in on this PC',
      reason: 'Account Logon Denied',
      canCopyPassword: true,
      message: expect.stringContaining('the code it just emailed you'),
    });
    expect(user.seen[1]).toBeNull();
    expect(registry.writes).toEqual([]);
  });

  it('fails without rollback, and without waiting, when Steam rejects the password outright', async () => {
    sim.knobs.loginVerdict = 'Invalid Password';
    const seen: (LaunchAttention | null)[] = [];
    const result = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null, displayName: 'New', hasSecret: true }), {
      dryRun: false,
      getPassword: () => 'pw',
      onAttention: (a) => seen.push(a),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Steam rejected the stored password for nobody\./);
    expect(result.restored).toBeNull();
    expect(result.needsSignIn).toBe(false);
    expect(seen).toEqual([]);
    expect(registry.writes).toEqual([]);
    expect(readFileSync(loginUsers, 'utf8')).toBe(fixture('loginusers.vdf'));
  });

  it('fails when Steam ends up signed in as a different account than the one it wrote down for that login', async () => {
    const simulate = processes.onStart!;
    processes.onStart = (exe, args) => {
      simulate(exe, args);
      if (args[0] !== '-login') return;
      // Steam records the new login with its own id, but the client is signed in as user_2.
      const entry =
        '\t"76561198000000009"\n\t{\n\t\t"AccountName"\t\t"nobody"\n\t\t"PersonaName"\t\t"New"\n\t\t"RememberPassword"\t\t"1"\n\t\t"Timestamp"\t\t"1789200000"\n\t}\n';
      writeFileSync(loginUsers, readFileSync(loginUsers, 'utf8').replace(/\}\s*$/, `${entry}}\n`));
      registry.set(`${REG}\\ActiveProcess\\ActiveUser`, ID3('user_2'));
    };
    const result = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null, displayName: 'New', hasSecret: true }), {
      dryRun: false,
      getPassword: () => 'pw',
    });
    expect(result).toMatchObject({ ok: false, needsSignIn: false, cancelled: false, restored: null });
    expect(result.error).toBe('Steam signed in as user_2 instead of nobody.');
    expect(registry.writes).toEqual([]);
  });

  it('runs without a stored password or a password getter: Steam opens its sign-in form and the job parks there', async () => {
    const result = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null }), { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.needsSignIn).toBe(true);
    expect(processes.events.map((e) => e.args)).toEqual([['-login', 'nobody']]);
    expect(registry.writes).toEqual([]);
    expect(statusOf(result.steps).slice(2)).toEqual([
      ['Start Steam on its sign-in form', 'done'],
      ['Wait for Steam to come up', 'done'],
      ['Confirm Steam signed in', 'skipped'],
      ['Wait for you to sign in', 'failed'],
    ]);
  });
});

describe('SteamAdapter.restoreBackup', () => {
  it('puts the file and registry back and refuses while Steam is running', async () => {
    const original = readFileSync(loginUsers, 'utf8');
    const switched = await adapter().switchAccount(ref(), { dryRun: false });
    expect(switched.ok).toBe(true);
    expect(mostRecentOf(readFileSync(loginUsers, 'utf8'))).toEqual(['user_3']);

    await expect(adapter().restoreBackup(switched.backupId!)).rejects.toMatchObject({ code: 'LAUNCHER_RUNNING' });

    processes.setRunning('steam.exe', false);
    registry.writes.length = 0;
    const result = await adapter().restoreBackup(switched.backupId!);
    expect(result).toEqual({
      launcher: 'steam',
      id: switched.backupId,
      files: [loginUsers.toLowerCase()],
      registry: ['AutoLoginUser = user_1', 'RememberPassword (removed)'],
    });
    expect(readFileSync(loginUsers, 'utf8')).toBe(original);
    expect(registry.writes).toEqual([
      { op: 'set', path: `${REG}\\AutoLoginUser`, value: 'user_1' },
      { op: 'delete', path: `${REG}\\RememberPassword` },
    ]);
    await expect(adapter().restoreBackup('nope')).rejects.toMatchObject({ code: 'BACKUP' });
  });

  it('restores the oldest snapshot even when backups.keep has been reached', async () => {
    backups = new BackupService(join(root, 'backups'), { keep: () => 1 });
    const original = readFileSync(loginUsers, 'utf8');
    const switched = await adapter().switchAccount(ref(), { dryRun: false });
    expect(switched.ok).toBe(true);
    expect(backups.list('steam').map((s) => s.id)).toEqual([switched.backupId]);

    processes.setRunning('steam.exe', false);
    const result = await adapter().restoreBackup(switched.backupId!);
    expect(result.id).toBe(switched.backupId);
    expect(readFileSync(loginUsers, 'utf8')).toBe(original);
    expect(backups.list('steam').map((s) => s.id)).toContain(switched.backupId);
  });
});

describe('SteamAdapter.launchGame / shutdown', () => {
  it('launches through the steam:// protocol and rejects non-numeric ids', async () => {
    await adapter().launchGame({ launcherGameId: '252950', name: 'Rocket League' });
    expect(opened).toEqual(['steam://rungameid/252950']);
    await expect(adapter().launchGame({ launcherGameId: '../evil', name: 'x' })).rejects.toThrow(/Not a Steam app id/);
  });

  it('shutdown is a no-op when Steam is closed and graceful when it listens', async () => {
    await adapter().shutdown();
    expect(processes.events).toEqual([]);
    processes.setRunning('steam.exe', true);
    await adapter().shutdown();
    expect(processes.events.map((e) => e.kind)).toEqual(['start']);
    expect(await processes.isRunning('steam.exe')).toBe(false);
  });
});

describe('SteamAdapter with Steam automatic sign-in off (the default)', () => {
  it('plans the credentials path without the password even when one is stored', async () => {
    autoLogin = false;
    const plan = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null, displayName: 'New', hasSecret: true }), { dryRun: true });
    expect(plan.executable).toBe(true);
    expect(plan.steps[2]!.title).toBe('Start Steam on its sign-in form');
    expect(plan.steps[2]!.target).toBe(`"${join(steamDir, 'steam.exe').toLowerCase()}" -login nobody`);
    expect(plan.warnings[0]).toMatch(/offers to copy the login and password/);
    expect(JSON.stringify(plan)).not.toContain('<password>');
  });

  it('opens the sign-in form with only the account name, hands over, and finishes once the user signs in', async () => {
    autoLogin = false;
    const user = userSignsInWhenAsked();
    let asked = 0;
    const result = await adapter().switchAccount(ref({ login: 'nobody', launcherUid: null, displayName: 'New', hasSecret: true }), {
      dryRun: false,
      getPassword: () => {
        asked++;
        return 'pw';
      },
      onAttention: user.onAttention,
    });
    expect(result.ok).toBe(true);
    expect(asked).toBe(0);
    expect(processes.events.map((e) => e.args)).toEqual([['-login', 'nobody']]);
    expect(statusOf(result.steps).slice(2)).toEqual([
      ['Start Steam on its sign-in form', 'done'],
      ['Wait for Steam to come up', 'done'],
      ['Confirm Steam signed in', 'skipped'],
      ['Wait for you to sign in', 'done'],
    ]);
    expect(user.seen[0]).toMatchObject({ kind: 'sign-in', canCopyPassword: true, title: 'Steam is asking you to sign in as nobody' });
    expect(user.seen[0]?.message).toMatch(/waiting on its sign-in form/);
  });

  it('never retries an expired session with the stored password; it hands over instead', async () => {
    autoLogin = false;
    sim.knobs.expiredSessions.push('user_3');
    const user = userSignsInWhenAsked(ID3('user_3'));
    let asked = 0;
    const result = await adapter().switchAccount(ref({ hasSecret: true }), {
      dryRun: false,
      getPassword: () => {
        asked++;
        return 'correct horse';
      },
      onAttention: user.onAttention,
    });
    expect(result.ok).toBe(true);
    expect(asked).toBe(0);
    expect(processes.events.map((e) => e.args)).toEqual([[]]);
    expect(statusOf(result.steps).slice(7)).toEqual([
      ['Confirm Steam signed in', 'failed'],
      ['Fallback: sign in with the stored password', 'skipped'],
      ['Wait for you to sign in', 'done'],
    ]);
    expect(user.seen[0]).toMatchObject({ kind: 'sign-in', canCopyPassword: true, title: 'Steam is asking you to sign in as user_3' });
  });
});
