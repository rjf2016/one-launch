import { describe, expect, it } from 'vitest';
import type { HealthReport, InstalledGame, LauncherInstall, RestoreResult, RunningGame, SwitchPlan, VaultStatus } from '../src/shared/models';
import { migrate, openDatabase } from '../src/main/db';
import {
  LauncherNotInstalledError,
  LauncherRunningError,
  type AccountRef,
  type KnownLauncherState,
  type LauncherAdapter,
  type RememberedAccountEntry,
  type SwitchOptions,
  type SwitchPreflight,
  type SwitchResult,
} from '../src/main/launchers/types';
import { AccountsService, DuplicateAccountError } from '../src/main/services/accounts';
import { accountDirectory, AdapterError, LauncherService } from '../src/main/services/launchers';
import { createLogger, type Logger } from '../src/main/services/logger';
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

const remembered: RememberedAccountEntry[] = [
  {
    launcher: 'steam',
    launcherUid: '76561198000000001',
    login: 'user_1',
    personaName: 'Persona One',
    rememberPassword: true,
    mostRecent: true,
    lastLoginAt: null,
    sessionMayBeExpired: false,
  },
  {
    launcher: 'steam',
    launcherUid: '76561198000000002',
    login: 'user_2',
    personaName: '',
    rememberPassword: true,
    mostRecent: false,
    lastLoginAt: null,
    sessionMayBeExpired: true,
  },
];

class FakeSteam implements LauncherAdapter {
  readonly id = 'steam' as const;
  readonly displayName = 'Steam';
  failHealth = false;
  lastRef: AccountRef | null = null;

  chosen: string | null = null;
  chosenInstallDir(): string | null {
    return this.chosen;
  }
  installFromExe(): LauncherInstall | null {
    return null;
  }
  detectGate: Promise<void> | null = null;
  async detectInstall(): Promise<LauncherInstall | null> {
    if (this.detectGate) await this.detectGate;
    return { launcher: 'steam', installDir: 'D:\\Games\\Steam', exePath: 'D:\\Games\\Steam\\steam.exe', source: 'registry-hkcu' };
  }
  installed = true;
  failGames = false;
  refuseGames = false;
  async listInstalledGames(): Promise<InstalledGame[]> {
    if (!this.installed) throw new LauncherNotInstalledError('steam');
    if (this.refuseGames) throw new LauncherRunningError('Close Steam first');
    if (this.failGames) throw new Error('disk on fire');
    return [];
  }
  async listRememberedAccounts(): Promise<RememberedAccountEntry[]> {
    return remembered;
  }
  async isRunning(): Promise<boolean> {
    return false;
  }
  async shutdown(): Promise<void> {}
  async launchGame(): Promise<{ command: string }> {
    return { command: 'steam://rungameid/1' };
  }
  async runningGame(): Promise<RunningGame | null> {
    return null;
  }
  async restoreBackup(id: string): Promise<RestoreResult> {
    return { launcher: 'steam', id, files: [], registry: [] };
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
    this.lastRef = account;
    return {
      launcher: 'steam',
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
  healthKnown: KnownLauncherState | undefined;
  async healthCheck(known?: KnownLauncherState): Promise<HealthReport> {
    this.healthKnown = known;
    if (this.failHealth) {
      const err = new Error('loginusers.vdf exploded') as Error & { code: string };
      err.code = 'LAUNCHER_FILE';
      throw err;
    }
    return { launcher: 'steam', status: 'ok', checks: [], checkedAt: new Date().toISOString() };
  }
}

function setup() {
  const db = openDatabase(':memory:');
  migrate(db);
  const accounts = new AccountsService(db, new FakeVault());
  const steam = new FakeSteam();
  const service = new LauncherService([steam], accounts, createLogger('test:launchers'));
  return { accounts, steam, service };
}

describe('LauncherService.guard', () => {
  function capturing(): { log: Logger; lines: { level: string; message: string }[] } {
    const lines: { level: string; message: string }[] = [];
    const log: Logger = {
      debug: (m) => void lines.push({ level: 'debug', message: m }),
      info: (m) => void lines.push({ level: 'info', message: m }),
      warn: (m) => void lines.push({ level: 'warn', message: m }),
      error: (m) => void lines.push({ level: 'error', message: m }),
      child: () => log,
    };
    return { log, lines };
  }

  function guarded(): { steam: FakeSteam; service: LauncherService; lines: { level: string; message: string }[] } {
    const db = openDatabase(':memory:');
    migrate(db);
    const steam = new FakeSteam();
    const { log, lines } = capturing();
    return { steam, service: new LauncherService([steam], new AccountsService(db, new FakeVault()), log), lines };
  }

  it('does not log a launcher that is not installed as an error: on most PCs one of the three is missing', async () => {
    const { steam, service, lines } = guarded();
    steam.installed = false;
    await expect(service.installedGames('steam')).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
    expect(lines.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
    expect(lines).toContainEqual({ level: 'debug', message: 'launcher not installed' });
  });

  it('logs a status failure as an error while the app is running', async () => {
    const { steam, service, lines } = guarded();
    steam.failHealth = true;
    await service.status();
    expect(lines.filter((l) => l.level === 'error').map((l) => l.message)).toEqual(['adapter status failed']);
  });

  it('knows when adapter work is in flight, and a failure after quit began is not an error', async () => {
    const { steam, service, lines } = guarded();
    let release!: () => void;
    steam.detectGate = new Promise<void>((resolve) => (release = resolve));
    const pass = service.status();
    expect(service.isBusy()).toBe(true);
    expect(await service.whenIdle(20)).toBe(false);
    release();
    await pass;
    expect(service.isBusy()).toBe(false);
    expect(await service.whenIdle(20)).toBe(true);

    service.closing();
    steam.failHealth = true;
    const rows = await service.status();
    expect(rows.find((r) => r.launcher === 'steam')?.attention).not.toBeNull();
    expect(lines.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
    expect(lines).toContainEqual({ level: 'debug', message: 'adapter status failed after quit began' });
  });

  it('still logs every other adapter failure as an error', async () => {
    const { steam, service, lines } = guarded();
    steam.failGames = true;
    await expect(service.installedGames('steam')).rejects.toMatchObject({ code: 'ADAPTER_FAILED' });
    expect(lines.filter((l) => l.level === 'error').map((l) => l.message)).toEqual(['adapter call failed']);
  });

  it('logs an expected refusal as a warning, never an error', async () => {
    const { steam, service, lines } = guarded();
    steam.refuseGames = true;
    await expect(service.installedGames('steam')).rejects.toMatchObject({ code: 'LAUNCHER_RUNNING' });
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual(['adapter call refused']);
  });
});

describe('LauncherService.status', () => {
  it('reports every launcher and isolates a failing adapter as "attention"', async () => {
    const { steam, service } = setup();
    let statuses = await service.status();
    expect(statuses.map((s) => [s.launcher, s.implemented, s.attention])).toEqual([
      ['steam', true, null],
      ['epic', false, null],
      ['battlenet', false, null],
      ['riot', false, null],
    ]);
    expect(statuses[0]!.health?.status).toBe('ok');
    expect(statuses[0]!.running).toBe(false);
    expect(statuses.map((s) => s.chosenPath)).toEqual([null, null, null, null]);
    expect(steam.healthKnown).toEqual({ install: statuses[0]!.install, running: false });

    steam.chosen = 'E:\\Portable\\Steam';
    steam.failHealth = true;
    statuses = await service.status();
    expect(statuses[0]!.attention).toEqual({ message: 'loginusers.vdf exploded' });
    expect(statuses[0]!.install).not.toBeNull();
    expect(statuses[0]!.chosenPath).toBe('E:\\Portable\\Steam');
    expect(statuses[1]!.attention).toBeNull();
  });
});

describe('accountDirectory', () => {
  it('looks accounts up per launcher and refuses to link an id another account holds', () => {
    const { accounts } = setup();
    const main = accounts.create({ launcher: 'epic', displayName: 'Main', login: 'main@example.com', launcherUid: 'aaaa1111' });
    const alt = accounts.create({ launcher: 'epic', displayName: 'Alt', login: 'alt@example.com' });
    const other = accounts.create({ launcher: 'battlenet', displayName: 'Bnet', login: 'bnet@example.com', launcherUid: 'aaaa1111' });
    const dir = accountDirectory(accounts, 'epic');

    expect(dir.byLauncherUid('AAAA1111')?.id).toBe(main.id);
    expect(dir.byId(other.id)).toBeNull();
    expect(() => dir.setLauncherUid(alt.id, 'aaaa1111')).toThrow(DuplicateAccountError);
    expect(accounts.require(alt.id).launcherUid).toBeNull();
    dir.setLauncherUid(alt.id, 'bbbb2222');
    expect(accounts.require(alt.id).launcherUid).toBe('bbbb2222');
  });
});

describe('LauncherService.rememberedAccounts / importAccounts', () => {
  it('links remembered entries to existing accounts by uid or login', async () => {
    const { accounts, service } = setup();
    const existing = accounts.create({ launcher: 'steam', displayName: 'Second', login: 'USER_2' });
    const list = await service.rememberedAccounts('steam');
    expect(list.map((r) => [r.login, r.linkedAccountId])).toEqual([
      ['user_1', null],
      ['user_2', existing.id],
    ]);
  });

  it('creates accounts without passwords, fills in missing uids, and skips the rest', async () => {
    const { accounts, service } = setup();
    const existing = accounts.create({ launcher: 'steam', displayName: 'Second', login: 'user_2' });

    const result = await service.importAccounts('steam', ['76561198000000001', '76561198000000002', '76561198000000099', '76561198000000001']);
    expect(result.skipped).toEqual([{ launcherUid: '76561198000000099', reason: 'not remembered by the launcher' }]);
    expect(result.accounts).toHaveLength(2);

    const created = result.accounts.find((a) => a.login === 'user_1')!;
    expect(created).toMatchObject({ launcher: 'steam', displayName: 'Persona One', launcherUid: '76561198000000001', hasSecret: false, tags: [] });
    expect(result.accounts.find((a) => a.id === existing.id)).toMatchObject({ launcherUid: '76561198000000002', displayName: 'Second' });
    expect(accounts.list()).toHaveLength(2);

    const again = await service.importAccounts('steam', ['76561198000000001', '76561198000000002']);
    expect(again.accounts).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(['already in One Launch', 'already in One Launch']);
  });

  it('falls back to the login as display name when the persona name is empty', async () => {
    const { service } = setup();
    const result = await service.importAccounts('steam', ['76561198000000002']);
    expect(result.accounts[0]?.displayName).toBe('user_2');
  });

  it('rejects launchers without an adapter with NOT_IMPLEMENTED', async () => {
    const { service } = setup();
    await expect(service.rememberedAccounts('epic')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });
});

describe('LauncherService.switchPlan', () => {
  it('builds the AccountRef from the stored account without the secret', async () => {
    const { accounts, steam, service } = setup();
    const account = accounts.create({ launcher: 'steam', displayName: 'Main', login: 'user_1', password: 'hunter2', launcherUid: '76561198000000001' });
    const plan = await service.switchPlan(account.id);
    expect(plan.account.id).toBe(account.id);
    expect(steam.lastRef).toEqual({ id: account.id, displayName: 'Main', login: 'user_1', launcherUid: '76561198000000001', hasSecret: true });
    expect(JSON.stringify(steam.lastRef)).not.toContain('hunter2');
  });

  it('wraps adapter failures, keeping the adapter error code', async () => {
    const { accounts, steam, service } = setup();
    const account = accounts.create({ launcher: 'steam', displayName: 'Main', login: 'user_1' });
    steam.switchAccount = async () => {
      const err = new Error('boom') as Error & { code: string };
      err.code = 'LAUNCHER_FILE';
      throw err;
    };
    const failure = await service.switchPlan(account.id).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AdapterError);
    expect(failure).toMatchObject({ code: 'LAUNCHER_FILE', launcher: 'steam', message: 'Steam: boom' });

    await expect(service.switchPlan('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
