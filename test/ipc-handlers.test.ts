import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcChannel, IpcEnvelope, IpcRequest } from '../src/shared/ipc-contract';
import type { SwitchRecovery } from '../src/shared/models';

/** The main-process handlers register through ipcMain; capture them instead of touching Electron. */
const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', isPackaged: false },
  shell: { openPath: async () => '', openExternal: async () => undefined },
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
}));

const { registerIpcHandlers } = await import('../src/main/ipc');
import { migrate, openDatabase } from '../src/main/db';
import { AccountsService } from '../src/main/services/accounts';
import { createLogger } from '../src/main/services/logger';
import { SecretStore } from '../src/main/services/secrets';
import { SettingsService } from '../src/main/services/settings';
import type { Vault } from '../src/main/services/vault';
import { VaultHealth } from '../src/main/services/vault-health';
import type { IpcDeps } from '../src/main/ipc';
import { MemoryLoginItem, type LoginItem } from '../src/main/platform/login-item';
import { UpdateNotReadyError } from '../src/main/updates/update-service';

class FakeVault implements Vault {
  readonly backend = 'dpapi' as const;
  isAvailable(): boolean {
    return true;
  }
  status() {
    return { available: true, backend: 'dpapi' as const };
  }
  encrypt(plaintext: string): Buffer {
    return Buffer.from(plaintext, 'utf8');
  }
  decrypt(ciphertext: Buffer): string {
    return ciphertext.toString('utf8');
  }
}

let settings: SettingsService;
let accounts: AccountsService;
let secrets: SecretStore;
let busy = false;
let pending: SwitchRecovery | null = null;
let recoveryCalls: string[] = [];
/** What the user picks in main's file dialog; null is a cancel. */
let picked: string | null = null;
let rescans = 0;
let artworkStarts = 0;
let installRequests = 0;
let updateReady = false;
let loginItem: LoginItem;
/** A rescan in the fake main process finishes only when this does. */
let rescanGate: Promise<void> = Promise.resolve();

beforeEach(() => {
  handlers.clear();
  busy = false;
  pending = null;
  recoveryCalls = [];
  picked = null;
  rescans = 0;
  artworkStarts = 0;
  installRequests = 0;
  updateReady = false;
  loginItem = new MemoryLoginItem();
  rescanGate = Promise.resolve();
  const db = openDatabase(':memory:');
  migrate(db);
  const vault = new FakeVault();
  const log = createLogger('test:ipc');
  settings = new SettingsService(db);
  accounts = new AccountsService(db, vault);
  secrets = new SecretStore(db, vault);
  const deps = {
    log,
    paths: { dataDir: 'D:\\data', dbPath: 'D:\\data\\x.db', artworkDir: 'D:\\data\\artwork', backupsDir: 'D:\\data\\backups', logsDir: 'D:\\data\\logs' },
    vault,
    vaultHealth: new VaultHealth(db, vault, secrets, log),
    secrets,
    settings,
    accounts,
    launch: { isBusy: () => busy },
    artwork: {
      enqueueAfterScan: () => {
        artworkStarts++;
        return 0;
      },
    },
    updates: {
      status: () => ({ state: 'idle' }),
      check: () => ({ state: 'checking' }),
      requestInstall: () => {
        if (!updateReady) throw new UpdateNotReadyError();
        installRequests++;
      },
    },
    loginItem: {
      status: () => loginItem.status(),
      set: (openAtLogin: boolean) => loginItem.set(openAtLogin),
    },
    launchers: {
      installFromExe: async (launcher: string, exePath: string) =>
        launcher === 'steam' && exePath.endsWith('\\steam.exe')
          ? { launcher, installDir: exePath.slice(0, -'\\steam.exe'.length), exePath, source: 'user' }
          : null,
    },
    rescan: async () => {
      rescans++;
      await rescanGate;
      return [];
    },
    pickLauncherExe: async () => picked,
    recovery: {
      get: () => pending,
      restore: async () => {
        recoveryCalls.push('restore');
        return { launcher: 'steam', id: 'snap-1', files: [], registry: [] };
      },
      dismiss: () => recoveryCalls.push('dismiss'),
    },
    getStartupMetrics: () => ({ processToNodeMs: null, windowShownMs: null, readyToShowMs: null, didFinishLoadMs: null }),
    isTrustedSender: () => true,
  } as unknown as IpcDeps;
  registerIpcHandlers(deps);
});

async function call<K extends IpcChannel>(channel: K, req?: IpcRequest<K>): Promise<IpcEnvelope<unknown>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return (await fn({ senderFrame: { url: 'file:///x' } }, req)) as IpcEnvelope<unknown>;
}

describe('IPC handlers', () => {
  it('registers every channel in the contract', async () => {
    const { IPC_CHANNELS } = await import('../src/shared/ipc-contract');
    for (const channel of IPC_CHANNELS) expect(handlers.has(channel), channel).toBe(true);
  });

  it('validates settings values, not just keys', async () => {
    expect(await call('settings:set', { key: 'dryRun', value: 'maybe' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'artwork.autoFetch', value: '' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'backups.keep', value: '0' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'backups.keep', value: '1e3' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'logLevel', value: 'loud' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'steam.autoLogin', value: 'maybe' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'riot.pressPlay', value: 'maybe' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'riot.pressPlay', value: 'false' })).toEqual({ ok: true, data: { ok: true } });
    expect(settings.getBool('riot.pressPlay', true)).toBe(false);
    expect(await call('settings:set', { key: 'dryRun', value: 'false' })).toEqual({ ok: true, data: { ok: true } });
    expect(await call('settings:set', { key: 'backups.keep', value: '30' })).toEqual({ ok: true, data: { ok: true } });
    expect(settings.getBool('dryRun', true)).toBe(false);
    expect(settings.getInt('backups.keep', 20)).toBe(30);
  });

  it('starts the artwork lookup when automatic fetching is turned back on, and only then (A10)', async () => {
    expect(await call('settings:set', { key: 'artwork.autoFetch', value: 'true' })).toEqual({ ok: true, data: { ok: true } });
    expect(artworkStarts).toBe(0);
    expect(await call('settings:set', { key: 'artwork.autoFetch', value: 'false' })).toEqual({ ok: true, data: { ok: true } });
    expect(artworkStarts).toBe(0);
    expect(await call('settings:set', { key: 'artwork.autoFetch', value: 'true' })).toEqual({ ok: true, data: { ok: true } });
    expect(artworkStarts).toBe(1);
    expect(await call('settings:set', { key: 'dryRun', value: 'true' })).toEqual({ ok: true, data: { ok: true } });
    expect(artworkStarts).toBe(1);
  });

  it('remembers that the welcome panel was dismissed, as true or false only (A10)', async () => {
    expect(await call('settings:set', { key: 'firstRun.dismissed', value: 'yes' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'firstRun.dismissed', value: 'true' })).toEqual({ ok: true, data: { ok: true } });
    expect(settings.get('firstRun.dismissed')).toBe('true');
  });

  it('keeps the automatic-updates switch to true or false', async () => {
    expect(await call('settings:set', { key: 'updates.auto', value: 'on' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'updates.auto', value: 'false' })).toEqual({ ok: true, data: { ok: true } });
    expect(settings.getBool('updates.auto', true)).toBe(false);
  });

  it("keeps the What's New switch to true or false, and its last-seen version to a version", async () => {
    expect(await call('settings:set', { key: 'whatsNew.enabled', value: 'maybe' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'whatsNew.enabled', value: 'false' })).toEqual({ ok: true, data: { ok: true } });
    expect(settings.getBool('whatsNew.enabled', true)).toBe(false);
    expect(await call('settings:set', { key: 'whatsNew.lastSeen', value: 'latest' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('settings:set', { key: 'whatsNew.lastSeen', value: '1.2.3-beta.1' })).toEqual({ ok: true, data: { ok: true } });
    expect(settings.get('whatsNew.lastSeen')).toBe('1.2.3-beta.1');
  });

  it('refuses an update install with nothing verified, or during a switch', async () => {
    expect(await call('updates:install')).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    updateReady = true;
    busy = true;
    expect(await call('updates:install')).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(installRequests).toBe(0);
    busy = false;
    expect(await call('updates:install')).toEqual({ ok: true, data: { ok: true } });
    expect(installRequests).toBe(1);
  });

  it('reports and changes Start with Windows', async () => {
    expect(await call('autostart:status')).toEqual({ ok: true, data: { available: true, openAtLogin: false } });
    expect(await call('autostart:set', { openAtLogin: true })).toEqual({ ok: true, data: { available: true, openAtLogin: true } });
    expect(await call('autostart:status')).toEqual({ ok: true, data: { available: true, openAtLogin: true } });
    expect(await call('autostart:set', { openAtLogin: false })).toEqual({ ok: true, data: { available: true, openAtLogin: false } });
  });

  it('refuses Start with Windows on a copy that may not register, and a body that is not a boolean', async () => {
    let writes = 0;
    loginItem = {
      status: () => ({ available: false, openAtLogin: false }),
      set: () => {
        writes++;
        return { available: false, openAtLogin: false };
      },
    };
    expect(await call('autostart:status')).toEqual({ ok: true, data: { available: false, openAtLogin: false } });
    expect(await call('autostart:set', { openAtLogin: true })).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(await call('autostart:set', { openAtLogin: 'true' } as never)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(writes).toBe(0);
  });

  it('never hands a real secret back to the renderer', async () => {
    secrets.set('steamgriddb.apiKey', 'sgdb-key');
    expect(await call('vault:getSecret', { key: 'steamgriddb.apiKey' } as never)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    await call('vault:setSecret', { key: 'diagnostics.roundtrip', value: 'probe' });
    expect(await call('vault:getSecret', { key: 'diagnostics.roundtrip' })).toEqual({ ok: true, data: { value: 'probe' } });
  });

  it('never lets the renderer write or delete the vault probe, which would read as a lost vault key', async () => {
    secrets.set('vault.probe', 'one-launch-vault-probe');
    expect(await call('vault:setSecret', { key: 'vault.probe', value: 'x' } as never)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await call('vault:deleteSecret', { key: 'vault.probe' } as never)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(secrets.get('vault.probe')).toBe('one-launch-vault-probe');
    expect(await call('vault:setSecret', { key: 'steamgriddb.apiKey', value: 'k' })).toEqual({ ok: true, data: { ok: true } });
    expect(await call('vault:deleteSecret', { key: 'steamgriddb.apiKey' })).toEqual({ ok: true, data: { ok: true } });
    expect(await call('vault:deleteSecret', { key: 'diagnostics.roundtrip' })).toEqual({ ok: true, data: { ok: true } });
  });

  it('rejects malformed account payloads and accepts a well-formed one', async () => {
    expect(await call('accounts:create', { launcher: 'origin', displayName: 'x', login: 'y' } as never)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(await call('accounts:create', { launcher: 'steam', displayName: 'x', login: 'y', tags: ['a', 1] } as never)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(await call('accounts:create', { launcher: 'steam', displayName: '   ', login: 'y' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    const created = await call('accounts:create', { launcher: 'steam', displayName: 'Main', login: 'user_1', password: 'pw' });
    expect(created).toMatchObject({ ok: true, data: { account: { displayName: 'Main', hasSecret: true } } });
    expect(accounts.list()).toHaveLength(1);
  });

  it('refuses account, session, and backup mutations while a switch is running', async () => {
    const created = (await call('accounts:create', { launcher: 'steam', displayName: 'Main', login: 'user_1' })) as { data: { account: { id: string } } };
    const id = created.data.account.id;
    busy = true;
    const refused = { ok: false, error: { code: 'BUSY' } };
    expect(await call('accounts:update', { id, patch: { notes: 'x' } })).toMatchObject(refused);
    expect(await call('accounts:delete', { id })).toMatchObject(refused);
    expect(await call('accounts:setPassword', { id, password: 'pw' })).toMatchObject(refused);
    expect(await call('accounts:clearPassword', { id })).toMatchObject(refused);
    expect(await call('sessions:capture', { accountId: id })).toMatchObject(refused);
    expect(await call('sessions:forget', { accountId: id })).toMatchObject(refused);
    expect(await call('backups:restore', { launcher: 'steam', id: 'snap' })).toMatchObject(refused);
    expect(accounts.require(id).notes).toBe('');
    busy = false;
    expect(await call('accounts:delete', { id })).toEqual({ ok: true, data: { ok: true } });
  });

  it('serves the interrupted-switch prompt, and refuses its restore while a switch is running', async () => {
    expect(await call('recovery:get')).toEqual({ ok: true, data: { recovery: null } });
    pending = {
      jobId: 'job-1',
      launcher: 'steam',
      accountName: 'Main',
      startedAt: '2026-09-18T10:00:00.000Z',
      backupId: 'snap-1',
      snapshotAvailable: true,
      phase: 'writing',
    };
    expect(await call('recovery:get')).toEqual({ ok: true, data: { recovery: pending } });
    busy = true;
    expect(await call('recovery:restore')).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(recoveryCalls).toEqual([]);
    busy = false;
    expect(await call('recovery:restore')).toMatchObject({ ok: true, data: { result: { id: 'snap-1' } } });
    expect(await call('recovery:dismiss')).toEqual({ ok: true, data: { ok: true } });
    expect(recoveryCalls).toEqual(['restore', 'dismiss']);
  });

  it('takes a launcher folder only from the file dialog in main, never from the renderer', async () => {
    for (const key of ['steam.path', 'epic.path', 'battlenet.path'] as const) {
      expect(await call('settings:set', { key, value: 'C:\\Evil' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    }
    expect(await call('launchers:locate', { launcher: 'steam', path: 'C:\\Evil\\steam.exe' } as never)).toEqual({ ok: true, data: { install: null } });
    expect(settings.get('steam.path')).toBeNull();

    picked = 'D:\\Tools\\notepad.exe';
    expect(await call('launchers:locate', { launcher: 'steam' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_A_LAUNCHER', message: 'That file is not Steam. Choose steam.exe in the folder Steam is installed in.' },
    });
    expect(settings.get('steam.path')).toBeNull();
    expect(rescans).toBe(0);

    picked = 'E:\\Portable\\Steam\\steam.exe';
    expect(await call('launchers:locate', { launcher: 'steam' })).toMatchObject({
      ok: true,
      data: { install: { installDir: 'E:\\Portable\\Steam', source: 'user' } },
    });
    expect(settings.get('steam.path')).toBe('E:\\Portable\\Steam');
    expect(rescans).toBe(1);

    busy = true;
    expect(await call('launchers:locate', { launcher: 'steam' })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(await call('launchers:resetPath', { launcher: 'steam' })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(settings.get('steam.path')).toBe('E:\\Portable\\Steam');
    busy = false;
    expect(await call('launchers:resetPath', { launcher: 'steam' })).toEqual({ ok: true, data: { ok: true } });
    expect(settings.get('steam.path')).toBeNull();
    expect(rescans).toBe(2);
    expect(await call('launchers:locate', { launcher: 'origin' } as never)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  it('answers Locate and Reset without waiting for the rescan they start', async () => {
    let finish: () => void = () => undefined;
    rescanGate = new Promise<void>((resolve) => (finish = resolve));
    picked = 'E:\\Portable\\Steam\\steam.exe';
    expect(await call('launchers:locate', { launcher: 'steam' })).toMatchObject({ ok: true });
    expect(await call('launchers:resetPath', { launcher: 'steam' })).toEqual({ ok: true, data: { ok: true } });
    expect(rescans).toBe(2);
    finish();
  });

  it('does not store a folder when a switch started while the file dialog was open', async () => {
    picked = 'E:\\Portable\\Steam\\steam.exe';
    const answer = call('launchers:locate', { launcher: 'steam' });
    busy = true;
    expect(await answer).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(settings.get('steam.path')).toBeNull();
  });

  it('rejects calls from an untrusted sender', async () => {
    handlers.clear();
    registerIpcHandlers({ log: createLogger('t'), isTrustedSender: () => false } as unknown as IpcDeps);
    expect(await call('app:ping', { message: 'hi' })).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } });
  });

  it('logs renderer errors and bounds their size', async () => {
    expect(await call('app:reportError', { source: 'render', message: 'boom', stack: null })).toEqual({ ok: true, data: { ok: true } });
    expect(await call('app:reportError', { source: 'render', message: 'x'.repeat(10_000), stack: null })).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(await call('app:reportError', { source: 'elsewhere', message: 'boom', stack: null } as never)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
  });
});
