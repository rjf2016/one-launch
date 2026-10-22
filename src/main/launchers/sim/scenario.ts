import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LauncherId } from '@shared/models';
import { MemoryLoginItem } from '../../platform/login-item';
import type { LauncherPlatform } from '../../platform/wiring';
import { StaticRegistry } from '../../platform/registry';
import type { Logger } from '../../services/logger';
import { UNIFIED_AUTH_KEY } from '../battlenet/session';
import { sessionBlobFromIni } from '../epic/session';
import type { RiotLocalLaunch } from '../riot/local-launch';
import { fixtureFetch } from './artwork-fetch';
import { BattlenetSim, LOGGING_STARTED_LINE, type BattlenetKnobs } from './battlenet';
import { EpicSim, type EpicKnobs } from './epic';
import { SimProcessController } from './processes';
import { FakeReport } from './report';
import { RiotSim, type RiotKnobs } from './riot';
import { applyFakeSeed, type FakeSeed } from './seed';
import { SteamSim } from './steam';
import type { ProcessKnobs, SteamKnobs } from './types';

/** A launcher-shaped timing set short enough that a fake switch finishes in a few seconds yet every phase survives a 150 ms poll of the launch dialog. */
const SIM_TIMING = {
  pollMs: 100,
  logPollMs: 100,
  processPollMs: 100,
  shutdownMs: 3_000,
  killGraceMs: 1_000,
  restartWatchMs: 500,
  cleanExitWatchMs: 200,
  restartSettleMs: 2_000,
  startupMs: 5_000,
  signInMs: 8_000,
  guardMs: 8_000,
  updateMs: 20_000,
  manualSignInMs: 30_000,
  captureMs: 3_000,
  readyGraceMs: 300,
  launchConfirmMs: 2_000,
  playConfirmMs: 2_000,
} as const;

export interface Scenario {
  version: 1;
  installed: LauncherId[];
  files?: Record<string, unknown>;
  registry?: Record<string, string | number>;
  processes?: Partial<ProcessKnobs>;
  knobs?: { steam?: Partial<SteamKnobs>; epic?: Partial<EpicKnobs>; battlenet?: Partial<BattlenetKnobs>; riot?: Partial<RiotKnobs> };
  timing?: { steam?: Record<string, number>; epic?: Record<string, number>; battlenet?: Record<string, number>; riot?: Record<string, number> };
  /** The account each launcher's on-disk session signs in as. Riot needs none: its file names the account itself. */
  onDisk?: { epic?: string; battlenet?: string };
  seed?: FakeSeed;
  quitDuringSwitch?: 'keep' | 'quit';
}

const LAUNCHERS: readonly LauncherId[] = ['steam', 'epic', 'battlenet', 'riot'];

export function parseScenario(raw: unknown): Scenario {
  if (!raw || typeof raw !== 'object') throw new Error('scenario.json is not an object');
  const s = raw as Record<string, unknown>;
  if (s['version'] !== 1) throw new Error('scenario.json version must be 1');
  const installed = s['installed'];
  if (!Array.isArray(installed) || installed.some((l) => !LAUNCHERS.includes(l as LauncherId)))
    throw new Error('scenario.json "installed" must be launcher ids');
  return raw as Scenario;
}

export interface MaterializeOptions {
  dir: string;
  dataDir: string;
  log: Logger;
}

/**
 * Turns a scenario folder into the fake platform the adapters run on: an in-memory registry and process
 * table with the launcher simulators, every path root inside the folder, short timings, a fixture
 * network, and clipboard recorders. Nothing it returns reaches the real registry, process list, or network.
 */
export function materializeScenario(opts: MaterializeOptions): LauncherPlatform {
  const { dir, dataDir, log } = opts;
  const scenario = parseScenario(JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')));
  const knobsFile = join(dir, 'knobs.json');
  const overrides = existsSync(knobsFile) ? (JSON.parse(readFileSync(knobsFile, 'utf8')) as Partial<Scenario>) : {};
  const processKnobs = { ...scenario.processes, ...overrides.processes };
  const launcherKnobs = mergeKnobs(scenario.knobs, overrides.knobs);
  const timing = mergeTiming(scenario.timing, overrides.timing);
  const quitDuringSwitch = overrides.quitDuringSwitch ?? scenario.quitDuringSwitch;

  const report = new FakeReport();
  report.attach(dataDir);

  const roots = {
    steam: join(dir, 'steam'),
    epic: join(dir, 'epic'),
    battlenet: join(dir, 'battlenet'),
    riot: join(dir, 'riot'),
    localAppData: join(dir, 'localappdata'),
    appData: join(dir, 'appdata'),
    programData: join(dir, 'programdata'),
    games: join(dir, 'games'),
    nowhere: join(dir, 'nowhere'),
  };

  const registry = seededRegistry(scenario, roots, report);
  const processes = new SimProcessController(processKnobs);
  processes.addListener((exe, args) =>
    report.processEvent({ kind: exe.includes('<close>') || args[0] === '<close>' ? 'close' : 'start', exe, args: [...args] }),
  );
  processes.addKillListener((image) => report.processEvent({ kind: 'kill', exe: image, args: [] }));

  const installed = new Set(scenario.installed);
  const logins = battlenetLogins(scenario);
  if (installed.has('steam')) {
    const sim = new SteamSim({ steamDir: roots.steam, registry, processes, knobs: launcherKnobs.steam });
    processes.addListener((exe, args) => sim.onStart(exe, args));
  }
  if (installed.has('epic')) {
    const sim = new EpicSim({ localAppData: roots.localAppData, processes, servers: epicServers(scenario, roots), knobs: launcherKnobs.epic });
    processes.addListener((exe, args) => sim.onStart(exe, args));
  }
  if (installed.has('battlenet')) {
    const sim = new BattlenetSim({
      appData: roots.appData,
      localAppData: roots.localAppData,
      registry,
      processes,
      logins,
      servers: battlenetServers(scenario),
      gamesDir: roots.games,
      knobs: launcherKnobs.battlenet,
    });
    sim.ensureProductDb(roots.programData);
    // The sim owns every client log: a committed one would sort newer than its fresh sign-in logs and hide them. Lay down the current owner's run.
    const onDisk = scenario.onDisk?.battlenet;
    if (onDisk) sim.writeLog([LOGGING_STARTED_LINE, ...sim.installStateLines(), sim.signedInLine(onDisk)]);
    processes.addListener((exe, args) => sim.onStart(exe, args));
  }
  // The launch request the client's Play button sends: in the fake it is the simulator's Play, recorded for the scenario.
  let riotLocalLaunch: RiotLocalLaunch = {
    launch: async () => {
      throw new Error('no Riot Client in this scenario');
    },
  };
  if (installed.has('riot')) {
    RiotSim.ensureProducts({ programData: roots.programData, installDir: roots.riot, gamesDir: roots.games });
    const sim = new RiotSim({ localAppData: roots.localAppData, processes, knobs: launcherKnobs.riot });
    processes.addListener((exe, args) => sim.onStart(exe, args));
    riotLocalLaunch = {
      launch: async ({ product, patchline }) => {
        report.riotLaunchRequest(`${product}.${patchline}`);
        if (sim.knobs.pressPlayFails) throw new Error('the Riot Client answered the launch request with HTTP 500');
        sim.pressPlay(`${product}.${patchline}`);
      },
    };
  }

  const artwork = fixtureFetch(report);
  // Holds what was last written so the private write's read-back matches, as it does on a real machine.
  let held = '';
  const record = async (text: string): Promise<void> => {
    held = text;
    report.clipboardWrite();
  };
  const clipboardBoard = {
    writeText: record,
    readText: async () => held,
    clear: () => {
      held = '';
    },
  };

  log.info('fake launchers ready', { dir, installed: scenario.installed });
  return {
    source: 'fake',
    registry,
    processes,
    openExternal: async (url) => report.opened(url),
    fetch: artwork,
    riotLocalLaunch,
    loginItem: new MemoryLoginItem(),
    roots: {
      steam: { defaultInstallDir: roots.nowhere },
      epic: { localAppData: roots.localAppData, programData: roots.programData, defaultInstallDir: roots.nowhere },
      battlenet: { appData: roots.appData, localAppData: roots.localAppData, programData: roots.programData, defaultInstallDir: roots.nowhere },
      riot: { localAppData: roots.localAppData, programData: roots.programData, defaultInstallDir: roots.nowhere },
    },
    timing,
    clipboard: { clipboard: clipboardBoard, writePrivately: record },
    seed: (targets) => applyFakeSeed(scenario.seed ?? {}, targets, log),
    ...(quitDuringSwitch ? { quitDuringSwitch } : {}),
  };
}

type Roots = {
  steam: string;
  epic: string;
  battlenet: string;
  riot: string;
  localAppData: string;
  appData: string;
  programData: string;
  games: string;
  nowhere: string;
};

function seededRegistry(scenario: Scenario, roots: Roots, report: FakeReport): StaticRegistry {
  const seed: Record<string, string | number> = {};
  const installed = new Set(scenario.installed);
  if (installed.has('steam')) Object.assign(seed, SteamSim.defaultRegistry(roots.steam));
  if (installed.has('epic')) Object.assign(seed, EpicSim.defaultRegistry({ installLocation: roots.epic, programData: roots.programData }));
  if (installed.has('battlenet')) Object.assign(seed, BattlenetSim.defaultRegistry({ installDir: roots.battlenet, gamesDir: roots.games }));
  if (installed.has('riot')) Object.assign(seed, RiotSim.defaultRegistry({ installDir: roots.riot, gamesDir: roots.games, programData: roots.programData }));
  const registry = new StaticRegistry(seed);
  for (const [path, value] of Object.entries(scenario.registry ?? {})) {
    if (typeof value === 'string' && value.startsWith('binary:')) registry.setBinaryValue(path, value.slice('binary:'.length));
    else registry.set(path, value);
  }
  return recordingRegistry(registry, report);
}

/** Wraps the four write methods so every launcher write reaches the report; reads and seed helpers pass through. */
function recordingRegistry(registry: StaticRegistry, report: FakeReport): StaticRegistry {
  const wrap =
    <T extends unknown[]>(fn: (...a: T) => Promise<void>, describe: (...a: T) => { op: 'set' | 'delete'; path: string; value?: string | number }) =>
    async (...a: T): Promise<void> => {
      report.registryWrite(describe(...a));
      await fn.apply(registry, a);
    };
  registry.setString = wrap(registry.setString.bind(registry), (h, k, n, v) => ({ op: 'set', path: `${h}\\${k}\\${n}`, value: v }));
  registry.setDword = wrap(registry.setDword.bind(registry), (h, k, n, v) => ({ op: 'set', path: `${h}\\${k}\\${n}`, value: v }));
  registry.setBinary = wrap(registry.setBinary.bind(registry), (h, k, n) => ({ op: 'set', path: `${h}\\${k}\\${n}`, value: 'binary' }));
  registry.deleteValue = wrap(registry.deleteValue.bind(registry), (h, k, n) => ({ op: 'delete', path: `${h}\\${k}\\${n}` }));
  return registry;
}

/** The blob the Epic settings file holds on disk maps to onDisk.epic; each seeded session blob to its own uid. */
function epicServers(scenario: Scenario, roots: Roots): Map<string, string> {
  const servers = new Map<string, string>();
  const ini = join(roots.localAppData, 'EpicGamesLauncher', 'Saved', 'Config', 'Windows', 'GameUserSettings.ini');
  const onDisk = scenario.onDisk?.epic;
  if (onDisk && existsSync(ini)) {
    const blob = sessionBlobFromIni(readFileSync(ini, 'utf8'));
    if (blob) servers.set(blob.rememberMe.data, onDisk);
  }
  for (const s of scenario.seed?.sessions ?? []) if (s.launcher === 'epic') servers.set(s.blob.rememberMe.data, s.launcherUid);
  return servers;
}

/** The token seeded in the registry maps to onDisk.battlenet; each seeded session token to its own uid. */
function battlenetServers(scenario: Scenario): Map<string, string> {
  const servers = new Map<string, string>();
  const onDisk = scenario.onDisk?.battlenet;
  if (onDisk) {
    for (const [path, value] of Object.entries(scenario.registry ?? {})) {
      if (path.includes(UNIFIED_AUTH_KEY) && typeof value === 'string' && value.startsWith('binary:'))
        servers.set(value.slice('binary:'.length).toLowerCase(), onDisk);
    }
  }
  for (const s of scenario.seed?.sessions ?? []) if (s.launcher === 'battlenet') servers.set(s.blob.unifiedAuth.hex.toLowerCase(), s.launcherUid);
  return servers;
}

function battlenetLogins(scenario: Scenario): Record<string, string> {
  const logins: Record<string, string> = {};
  for (const a of scenario.seed?.accounts ?? []) if (a.launcher === 'battlenet' && a.launcherUid) logins[a.launcherUid] = a.login;
  return logins;
}

function mergeKnobs(base: Scenario['knobs'], over: Scenario['knobs']) {
  return {
    steam: { ...base?.steam, ...over?.steam },
    epic: { ...base?.epic, ...over?.epic },
    battlenet: { ...base?.battlenet, ...over?.battlenet },
    riot: { ...base?.riot, ...over?.riot },
  };
}

function mergeTiming(base: Scenario['timing'], over: Scenario['timing']) {
  return {
    steam: { ...SIM_TIMING, ...base?.steam, ...over?.steam },
    epic: { ...SIM_TIMING, ...base?.epic, ...over?.epic },
    battlenet: { ...SIM_TIMING, ...base?.battlenet, ...over?.battlenet },
    riot: { ...SIM_TIMING, ...base?.riot, ...over?.riot },
  };
}
