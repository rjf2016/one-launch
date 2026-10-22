import { existsSync } from 'node:fs';
import { join, win32 } from 'node:path';
import type { PlatformSource } from '@shared/models';
import type { BattlenetAdapterDeps } from '../launchers/battlenet/adapter';
import type { EpicAdapterDeps } from '../launchers/epic/adapter';
import type { RiotAdapterDeps } from '../launchers/riot/adapter';
import { WindowsRiotLocalLaunch, type RiotLocalLaunch } from '../launchers/riot/local-launch';
import type { SeedTargets } from '../launchers/sim/seed';
import type { SteamAdapterDeps } from '../launchers/steam/adapter';
import type { FetchLike } from '../services/artwork';
import type { ClipboardLike } from '../services/clipboard';
import type { Logger } from '../services/logger';
import { WindowsLoginItem, type LoginItem, type WindowsLoginItemOptions } from './login-item';
import { WindowsProcessController, type ProcessController } from './processes';
import { WindowsRegistry, type Registry } from './registry';

/** The folder a fake-launcher run reads its scenario from. Honoured only when unpackaged; the packaged exe never enters fake mode. */
export const FAKE_LAUNCHERS_ENV = 'ONELAUNCH_FAKE_LAUNCHERS';
export const SCENARIO_FILE = 'scenario.json';

export class FakeLaunchersError extends Error {}

/**
 * The scenario folder named by ONELAUNCH_FAKE_LAUNCHERS, or null. Always null when packaged, whatever the
 * environment says. A value that names nothing usable throws rather than being ignored, so a run that asked
 * for fake launchers can never quietly touch the real ones.
 */
export function resolveFakeLaunchersDir(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  if (isPackaged) return null;
  const value = (env[FAKE_LAUNCHERS_ENV] ?? '').trim();
  if (!value) return null;
  if (!win32.isAbsolute(value)) throw new FakeLaunchersError(`${FAKE_LAUNCHERS_ENV} needs an absolute folder path, got "${value}"`);
  const folder = win32.normalize(value).replace(/\\+$/, '');
  if (!existsSync(folder)) throw new FakeLaunchersError(`${FAKE_LAUNCHERS_ENV} names a folder that does not exist: "${folder}"`);
  if (!existsSync(join(folder, SCENARIO_FILE))) throw new FakeLaunchersError(`${FAKE_LAUNCHERS_ENV} folder has no ${SCENARIO_FILE}: "${folder}"`);
  return folder;
}

/**
 * Everything the adapters and services touch on the machine, in one place: the real registry, process list,
 * shell, and network, or in-process fakes rooted in a scenario folder. The composition root asks for it once.
 */
export interface LauncherPlatform {
  source: PlatformSource;
  registry: Registry;
  processes: ProcessController;
  openExternal: (url: string) => Promise<void>;
  fetch: FetchLike;
  /** The launch request the Riot Client's Play button sends to the client's local server (adapters/riot.md, rule 4). Fake: the simulator's Play. */
  riotLocalLaunch: RiotLocalLaunch;
  loginItem: LoginItem;
  roots: {
    steam: Pick<SteamAdapterDeps, 'defaultInstallDir'>;
    epic: Pick<EpicAdapterDeps, 'localAppData' | 'programData' | 'defaultInstallDir'>;
    battlenet: Pick<BattlenetAdapterDeps, 'appData' | 'localAppData' | 'programData' | 'defaultInstallDir'>;
    riot: Pick<RiotAdapterDeps, 'localAppData' | 'programData' | 'defaultInstallDir'>;
  };
  timing: {
    steam: NonNullable<SteamAdapterDeps['timing']>;
    epic: NonNullable<EpicAdapterDeps['timing']>;
    battlenet: NonNullable<BattlenetAdapterDeps['timing']>;
    riot: NonNullable<RiotAdapterDeps['timing']>;
  };
  /** Fake only: recorders in place of the system clipboard and the PowerShell private write. */
  clipboard?: { clipboard: ClipboardLike; writePrivately: (text: string) => Promise<void> };
  /** Fake only: seeds accounts, sessions, and settings once the services exist. Idempotent. */
  seed?: (targets: SeedTargets) => void;
  /** Fake only: what the scenario answers to the quit-during-switch prompt, instead of showing it. */
  quitDuringSwitch?: 'keep' | 'quit';
}

export interface PlatformOptions {
  fakeDir: string | null;
  dataDir: string;
  log: Logger;
  openExternal: (url: string) => Promise<void>;
  loginItem: Omit<WindowsLoginItemOptions, 'available'> & { available: (registry: Registry) => Promise<boolean> };
}

/** The simulators are a separate chunk, loaded only for a fake-launcher run, so a real start never parses them. */
export async function createPlatform(opts: PlatformOptions): Promise<LauncherPlatform> {
  if (opts.fakeDir) {
    const { materializeScenario } = await import('../launchers/sim/scenario');
    return materializeScenario({ dir: opts.fakeDir, dataDir: opts.dataDir, log: opts.log });
  }
  const registry = new WindowsRegistry();
  return {
    source: 'real',
    registry,
    processes: new WindowsProcessController(),
    openExternal: opts.openExternal,
    fetch: (url, init) => fetch(url, init),
    riotLocalLaunch: new WindowsRiotLocalLaunch(),
    loginItem: new WindowsLoginItem({ ...opts.loginItem, available: () => opts.loginItem.available(registry) }),
    roots: { steam: {}, epic: {}, battlenet: {}, riot: {} },
    timing: { steam: {}, epic: {}, battlenet: {}, riot: {} },
  };
}
