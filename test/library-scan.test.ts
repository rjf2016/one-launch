import { describe, expect, it } from 'vitest';
import type { HealthReport, InstalledGame, LauncherId, LauncherInstall, RestoreResult, RunningGame, SwitchPlan, VaultStatus } from '../src/shared/models';
import { migrate, openDatabase } from '../src/main/db';
import {
  LauncherNotInstalledError,
  type AccountRef,
  type LauncherAdapter,
  type RememberedAccountEntry,
  type SwitchOptions,
  type SwitchPreflight,
  type SwitchResult,
} from '../src/main/launchers/types';
import { AccountsService } from '../src/main/services/accounts';
import { LauncherService } from '../src/main/services/launchers';
import { LibraryService } from '../src/main/services/library';
import { scanLibrary } from '../src/main/services/library-scan';
import { createLogger } from '../src/main/services/logger';
import type { Vault } from '../src/main/services/vault';

class FakeVault implements Vault {
  readonly backend = 'dpapi' as const;
  isAvailable(): boolean {
    return true;
  }
  status(): VaultStatus {
    return { available: true, backend: 'dpapi' };
  }
  encrypt(plaintext: string): Buffer {
    return Buffer.from(plaintext, 'utf8');
  }
  decrypt(ciphertext: Buffer): string {
    return ciphertext.toString('utf8');
  }
}

type Behaviour = { kind: 'games'; games: InstalledGame[] } | { kind: 'not-installed' } | { kind: 'throws'; message: string };

class FakeAdapter implements LauncherAdapter {
  readonly displayName: string;
  constructor(
    readonly id: LauncherId,
    public behaviour: Behaviour,
  ) {
    this.displayName = id;
  }
  chosenInstallDir(): string | null {
    return null;
  }
  installFromExe(): LauncherInstall | null {
    return null;
  }
  async detectInstall(): Promise<LauncherInstall | null> {
    return this.behaviour.kind === 'not-installed' ? null : { launcher: this.id, installDir: 'D:\\x', exePath: 'D:\\x\\x.exe', source: 'default-path' };
  }
  async listInstalledGames(): Promise<InstalledGame[]> {
    if (this.behaviour.kind === 'not-installed') throw new LauncherNotInstalledError(this.id);
    if (this.behaviour.kind === 'throws') throw new Error(this.behaviour.message);
    return this.behaviour.games;
  }
  async listRememberedAccounts(): Promise<RememberedAccountEntry[]> {
    return [];
  }
  async isRunning(): Promise<boolean> {
    return false;
  }
  async shutdown(): Promise<void> {}
  async launchGame(): Promise<{ command: string }> {
    return { command: '' };
  }
  async runningGame(): Promise<RunningGame | null> {
    return null;
  }
  async restoreBackup(id: string): Promise<RestoreResult> {
    return { launcher: this.id, id, files: [], registry: [] };
  }
  async preflight(account: AccountRef): Promise<SwitchPreflight> {
    return {
      plan: await this.switchAccount(account, { dryRun: true }),
      launcherRunning: false,
      runningGame: null,
      alreadyActive: false,
      closeMessage: 'Not running.',
    };
  }
  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: true }): Promise<SwitchPlan>;
  switchAccount(account: AccountRef, opts: SwitchOptions & { dryRun: false }): Promise<SwitchResult>;
  switchAccount(account: AccountRef, opts: SwitchOptions): Promise<SwitchPlan | SwitchResult>;
  async switchAccount(account: AccountRef): Promise<SwitchPlan | SwitchResult> {
    return {
      launcher: this.id,
      account: { id: account.id, displayName: account.displayName, login: account.login, launcherUid: account.launcherUid },
      strategy: 'remembered',
      current: { mostRecentLogin: null, autoLoginUser: null, running: false },
      steps: [],
      warnings: [],
      notes: [],
      executable: true,
      generatedAt: new Date().toISOString(),
    };
  }
  async healthCheck(): Promise<HealthReport> {
    return { launcher: this.id, status: 'ok', checks: [], checkedAt: new Date().toISOString() };
  }
}

function game(launcher: LauncherId, id: string): InstalledGame {
  return {
    launcher,
    launcherGameId: id,
    name: `Game ${id}`,
    installPath: `D:\\g\\${id}`,
    libraryPath: 'D:\\g',
    sizeOnDiskBytes: null,
    lastPlayedAt: null,
    needsUpdate: false,
  };
}

function setup(adapters: LauncherAdapter[]) {
  const db = openDatabase(':memory:');
  migrate(db);
  const log = createLogger('test');
  const library = new LibraryService(db);
  const launchers = new LauncherService(adapters, new AccountsService(db, new FakeVault()), log);
  return { library, launchers, log };
}

describe('scanLibrary', () => {
  it('scans every launcher even when the first one is not installed', async () => {
    const deps = setup([
      new FakeAdapter('steam', { kind: 'not-installed' }),
      new FakeAdapter('epic', { kind: 'games', games: [game('epic', 'Sugar')] }),
      new FakeAdapter('battlenet', { kind: 'games', games: [game('battlenet', 'prometheus')] }),
    ]);
    expect(deps.library.scanned).toBe(false);
    const results = await scanLibrary(deps);
    expect(results.map((r) => [r.launcher, r.installed, r.added, r.error])).toEqual([
      ['steam', false, 0, null],
      ['epic', true, 1, null],
      ['battlenet', true, 1, null],
    ]);
    expect(deps.library.list().map((g) => g.launcher)).toEqual(['battlenet', 'epic']);
    expect(deps.library.scanned).toBe(true);
  });

  it('marks a launcher that has since been uninstalled as having no installed games', async () => {
    const steam = new FakeAdapter('steam', { kind: 'games', games: [game('steam', '1'), game('steam', '2')] });
    const deps = setup([steam]);
    await scanLibrary(deps);
    expect(deps.library.list()).toHaveLength(2);
    steam.behaviour = { kind: 'not-installed' };
    const [result] = await scanLibrary(deps);
    expect(result).toMatchObject({ launcher: 'steam', installed: false, removed: 2, error: null });
    expect(deps.library.list()).toHaveLength(0);
  });

  it('leaves the revision alone when a rescan finds the same games', async () => {
    const deps = setup([
      new FakeAdapter('steam', { kind: 'games', games: [game('steam', '1'), game('steam', '2')] }),
      new FakeAdapter('epic', { kind: 'not-installed' }),
    ]);
    await scanLibrary(deps);
    const rev = deps.library.revision;
    expect(rev).toBeGreaterThan(0);
    await scanLibrary(deps);
    expect(deps.library.revision).toBe(rev);
  });

  it('reports a failing launcher on its own entry and leaves its games alone', async () => {
    const epic = new FakeAdapter('epic', { kind: 'games', games: [game('epic', 'Sugar')] });
    const deps = setup([epic, new FakeAdapter('battlenet', { kind: 'games', games: [game('battlenet', 'pro')] })]);
    await scanLibrary(deps);
    epic.behaviour = { kind: 'throws', message: 'manifests folder unreadable' };
    const results = await scanLibrary(deps);
    expect(results[0]).toMatchObject({ launcher: 'epic', installed: true, added: 0, removed: 0 });
    expect(results[0]?.error).toContain('manifests folder unreadable');
    expect(results[1]).toMatchObject({ launcher: 'battlenet', updated: 1, error: null });
    expect(deps.library.list().map((g) => g.launcher)).toEqual(['battlenet', 'epic']);
  });
});
