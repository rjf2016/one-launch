import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcChannel, IpcEnvelope } from '../src/shared/ipc-contract';

const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
const opened: string[] = [];
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', isPackaged: false },
  shell: {
    openPath: async (dir: string) => {
      opened.push(dir);
      return '';
    },
  },
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
}));

const { registerIpcHandlers } = await import('../src/main/ipc');
import type { IpcDeps } from '../src/main/ipc';
import { createLogger } from '../src/main/services/logger';

/** Every service call a handler made, as "service.method". A refused request must leave this empty. */
let reached: { call: string; args: unknown[] }[] = [];
let answers: Record<string, (...args: unknown[]) => unknown> = {};

function service(name: string): unknown {
  return new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (...args: unknown[]) => {
          const call = `${name}.${String(method)}`;
          if (call !== 'launch.isBusy') reached.push({ call, args });
          return answers[call]?.(...args);
        },
    },
  );
}

beforeEach(() => {
  handlers.clear();
  opened.length = 0;
  reached = [];
  answers = {};
  registerIpcHandlers({
    log: createLogger('test:ipc-validation'),
    paths: { dataDir: 'D:\\data', dbPath: 'D:\\data\\x.db', artworkDir: 'D:\\data\\artwork', backupsDir: 'D:\\data\\backups', logsDir: 'D:\\data\\logs' },
    vault: service('vault'),
    vaultHealth: service('vaultHealth'),
    secrets: service('secrets'),
    settings: service('settings'),
    accounts: service('accounts'),
    clipboard: service('clipboard'),
    library: service('library'),
    launchers: service('launchers'),
    backups: service('backups'),
    launch: service('launch'),
    recovery: service('recovery'),
    artwork: service('artwork'),
    updates: service('updates'),
    rescan: async () => {
      reached.push({ call: 'rescan', args: [] });
      return [];
    },
    pickImage: async () => {
      reached.push({ call: 'pickImage', args: [] });
      return null;
    },
    pickLauncherExe: async () => {
      reached.push({ call: 'pickLauncherExe', args: [] });
      return null;
    },
    getStartupMetrics: () => ({ processToNodeMs: null, windowShownMs: null, readyToShowMs: null, didFinishLoadMs: null }),
    isTrustedSender: () => true,
  } as unknown as IpcDeps);
});

async function call(channel: IpcChannel, req?: unknown): Promise<IpcEnvelope<unknown>> {
  return (await handlers.get(channel)!({ senderFrame: { url: 'file:///x' } }, req)) as IpcEnvelope<unknown>;
}

const LONG_ID = 'x'.repeat(65);
const NOT_AN_OBJECT = [undefined, null, 'text', 7, ['a']];
const BAD_ACCOUNT_ID = [{}, { accountId: 5 }, { accountId: LONG_ID }];
const BAD_LAUNCHER = [{}, { launcher: 'origin' }, { launcher: 5 }];
const good = { launcher: 'steam', displayName: 'Main', login: 'user_1' };

/** Payloads each validator has to refuse before anything else happens. */
const REFUSED: Partial<Record<IpcChannel, unknown[]>> = {
  'app:ping': [...NOT_AN_OBJECT, {}, { message: 1 }, { message: 'x'.repeat(1001) }],
  'app:openPath': [...NOT_AN_OBJECT, {}, { target: 'secrets' }, { target: 'C:\\Windows' }],
  'app:reportError': [...NOT_AN_OBJECT, { source: 'render', message: 5, stack: null }, { source: 'render', message: 'm', stack: 5 }],
  'vault:setSecret': [...NOT_AN_OBJECT, { key: 'nope', value: 'x' }, { key: 'steamgriddb.apiKey' }, { key: 'steamgriddb.apiKey', value: 'x'.repeat(4097) }],
  'vault:getSecret': [...NOT_AN_OBJECT, {}, { key: 'vault.probe' }],
  'vault:deleteSecret': [...NOT_AN_OBJECT, {}, { key: 'nope' }],
  'settings:get': [...NOT_AN_OBJECT, {}, { key: 'nope' }],
  'settings:set': [
    ...NOT_AN_OBJECT,
    { key: 'nope', value: 'x' },
    { key: 'dryRun' },
    { key: 'dryRun', value: true },
    { key: 'window.bounds', value: '{}' },
    { key: 'window.closeToTray', value: 'maybe' },
    { key: 'updates.auto', value: 'yes' },
    { key: 'epic.launchUri', value: 'x' },
    { key: 'battlenet.launch', value: 'x' },
    { key: 'logLevel', value: 'x'.repeat(4097) },
  ],
  'accounts:get': [...NOT_AN_OBJECT, {}, { id: 5 }, { id: LONG_ID }],
  'accounts:create': [
    ...NOT_AN_OBJECT,
    { ...good, displayName: 'x'.repeat(121) },
    { ...good, login: 5 },
    { ...good, login: 'x'.repeat(257) },
    { ...good, password: 5 },
    { ...good, password: 'x'.repeat(1025) },
    { ...good, launcherUid: 'x'.repeat(65) },
    { ...good, tags: 'a' },
    { ...good, notes: 5 },
  ],
  'accounts:update': [
    ...NOT_AN_OBJECT,
    { id: 'a' },
    { id: 'a', patch: 'x' },
    { id: 5, patch: {} },
    { id: 'a', patch: { displayName: 5 } },
    { id: 'a', patch: { launcherUid: 5 } },
    { id: 'a', patch: { tags: [1] } },
    { id: 'a', patch: { notes: 'x'.repeat(20_001) } },
  ],
  'accounts:delete': [...NOT_AN_OBJECT, {}, { id: 5 }],
  'accounts:setPassword': [...NOT_AN_OBJECT, { id: 'a' }, { id: 'a', password: 5 }, { id: 'a', password: 'x'.repeat(1025) }],
  'accounts:clearPassword': [...NOT_AN_OBJECT, {}, { id: LONG_ID }],
  'accounts:copy': [...NOT_AN_OBJECT, { id: 'a' }, { id: 'a', field: 'notes' }, { field: 'login' }],
  'artwork:refresh': [...NOT_AN_OBJECT, { gameId: 5, force: true }, { gameId: LONG_ID, force: false }],
  'artwork:setManual': [...NOT_AN_OBJECT, { gameId: 'g' }, { gameId: 'g', kind: 'banner' }, { kind: 'grid' }],
  'launchers:locate': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'launchers:resetPath': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'launchers:games': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'launchers:rememberedAccounts': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'launchers:importAccounts': [
    ...NOT_AN_OBJECT,
    { launcher: 'steam' },
    { launcher: 'origin', launcherUids: [] },
    { launcher: 'steam', launcherUids: 'a' },
    { launcher: 'steam', launcherUids: [1] },
    { launcher: 'steam', launcherUids: Array.from({ length: 65 }, () => 'a') },
  ],
  'launchers:switchPlan': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'sessions:get': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'sessions:capture': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'sessions:forget': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'backups:list': [...NOT_AN_OBJECT, ...BAD_LAUNCHER],
  'backups:restore': [...NOT_AN_OBJECT, { launcher: 'steam' }, { launcher: 'origin', id: 'a' }, { launcher: 'steam', id: 'x'.repeat(129) }],
  'launch:preflight': [...NOT_AN_OBJECT, ...BAD_ACCOUNT_ID],
  'launch:start': [...NOT_AN_OBJECT, {}, { accountId: 5, gameId: null }, { accountId: 'a', gameId: 5 }, { accountId: 'a', gameId: LONG_ID }],
  'launch:status': [...NOT_AN_OBJECT, {}, { jobId: 5 }, { jobId: LONG_ID }],
  'launch:cancel': [...NOT_AN_OBJECT, {}, { jobId: 5 }],
  'launch:recent': NOT_AN_OBJECT,
};

/** Channels whose request type is `undefined`: there is nothing to validate. */
const NO_PAYLOAD: IpcChannel[] = [
  'app:info',
  'vault:status',
  'vault:reset',
  'settings:getAll',
  'accounts:list',
  'library:list',
  'library:rescan',
  'artwork:status',
  'launchers:status',
  'recovery:get',
  'recovery:restore',
  'recovery:dismiss',
  'updates:status',
  'updates:check',
  'updates:install',
];

describe('IPC request validation (B19)', () => {
  it('has a refusal table for every channel that takes a payload', async () => {
    const { IPC_CHANNELS } = await import('../src/shared/ipc-contract');
    expect([...Object.keys(REFUSED), ...NO_PAYLOAD].sort()).toEqual([...IPC_CHANNELS].sort());
  });

  for (const [channel, payloads] of Object.entries(REFUSED) as [IpcChannel, unknown[]][]) {
    it(`${channel} refuses ${payloads.length} malformed payloads before touching a service`, async () => {
      for (const payload of payloads) {
        reached = [];
        const result = await call(channel, payload);
        expect(result, JSON.stringify(payload)?.slice(0, 80)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
        expect(reached, JSON.stringify(payload)?.slice(0, 80)).toEqual([]);
      }
      expect(opened).toEqual([]);
    });
  }
});

describe('IPC handlers: what reaches the services (B19)', () => {
  it('opens only the three known folders', async () => {
    for (const target of ['logs', 'data', 'backups'] as const) await call('app:openPath', { target });
    expect(opened).toEqual(['D:\\data\\logs', 'D:\\data', 'D:\\data\\backups']);
  });

  it('treats only a literal true as a confirmation or a forced refresh', async () => {
    answers['launch.start'] = () => ({ id: 'job-1' });
    answers['artwork.refresh'] = () => 1;
    await call('launch:start', { accountId: 'a', gameId: null, confirmClose: 'true' });
    await call('launch:start', { accountId: 'a', gameId: 'g', confirmClose: true });
    await call('launch:start', { accountId: 'a' });
    await call('artwork:refresh', { gameId: null, force: 1 });
    await call('artwork:refresh', { force: true });
    expect(reached.map((r) => r.args)).toEqual([
      [{ accountId: 'a', gameId: null, confirmClose: false }],
      [{ accountId: 'a', gameId: 'g', confirmClose: true }],
      [{ accountId: 'a', gameId: null, confirmClose: false }],
      [null, false],
      [null, true],
    ]);
  });

  it('clamps the recent-launches limit instead of passing it through', async () => {
    answers['launch.recentLaunches'] = () => [];
    for (const limit of [3, 1e9, 0, -5, 2.5, '7', undefined]) await call('launch:recent', { limit });
    expect(reached.map((r) => r.args[0])).toEqual([3, 50, 10, 10, 10, 10, 10]);
  });

  it('refuses to restore a snapshot that is not in the list, without calling the adapter', async () => {
    answers['backups.get'] = () => null;
    expect(await call('backups:restore', { launcher: 'steam', id: '..\\..\\elsewhere' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(reached.map((r) => r.call)).toEqual(['backups.get']);
  });

  it('copies nothing when no password is stored, and never sends a password to the log or the renderer', async () => {
    answers['accounts.decryptPassword'] = () => null;
    expect(await call('accounts:copy', { id: 'a', field: 'password' })).toMatchObject({ ok: false, error: { code: 'NO_PASSWORD' } });
    expect(reached.map((r) => r.call)).toEqual(['accounts.decryptPassword']);

    reached = [];
    answers['accounts.decryptPassword'] = () => 'correct horse';
    answers['clipboard.copySensitive'] = () => ({ clearAfterMs: 30_000, historyExcluded: true });
    const result = await call('accounts:copy', { id: 'a', field: 'password' });
    expect(result).toEqual({ ok: true, data: { clearAfterMs: 30_000, historyExcluded: true } });
    expect(JSON.stringify(result)).not.toContain('correct horse');
    expect(reached.at(-1)).toEqual({ call: 'clipboard.copySensitive', args: ['correct horse'] });
  });

  it('never starts an update install while a switch runs', async () => {
    answers['launch.isBusy'] = () => true;
    expect(await call('updates:install', undefined)).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(reached).toEqual([]);
    answers['launch.isBusy'] = () => false;
    expect(await call('updates:install', undefined)).toEqual({ ok: true, data: { ok: true } });
    expect(reached.map((r) => r.call)).toEqual(['updates.requestInstall']);
  });

  it('only changes what an account patch names', async () => {
    answers['accounts.update'] = (_id, patch) => ({ id: 'a', patch });
    await call('accounts:update', { id: 'a', patch: { notes: 'n', launcherUid: null, hasSecret: true, password: 'x' } });
    expect(reached.at(-1)!.args).toEqual(['a', { notes: 'n', launcherUid: null }]);
  });
});
