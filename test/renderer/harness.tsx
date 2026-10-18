import './setup';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import type { IpcChannel, IpcEnvelope, IpcRequest, IpcResponse } from '../../src/shared/ipc-contract';
import type { Account, Game, JobStep, LaunchJob, LaunchPreflight, SwitchPlan } from '../../src/shared/models';

/** An error the fake main process answers with: it crosses the bridge as `{ ok: false, error }`, like the real one. */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Handler<K extends IpcChannel> = (req: IpcRequest<K>) => IpcResponse<K> | Promise<IpcResponse<K>>;
export type Handlers = { [K in IpcChannel]?: Handler<K> };

export interface Bridge {
  /** Every call the renderer made, in order. */
  calls: { channel: IpcChannel; req: unknown }[];
  /** Replace or add handlers mid-test. */
  on<K extends IpcChannel>(channel: K, handler: Handler<K>): void;
  /** The requests sent on one channel. */
  sent<K extends IpcChannel>(channel: K): IpcRequest<K>[];
}

/** Stands in for the preload bridge: `window.oneLaunch.invoke` answers from `handlers`, and a channel nobody handles fails the test loudly. */
export function installBridge(handlers: Handlers = {}): Bridge {
  const table = new Map<string, (req: unknown) => unknown>(Object.entries(handlers) as [string, (req: unknown) => unknown][]);
  const calls: Bridge['calls'] = [];
  window.oneLaunch = {
    invoke: (async (channel: IpcChannel, req?: unknown): Promise<IpcEnvelope<unknown>> => {
      calls.push({ channel, req });
      const handler = table.get(channel);
      if (!handler) return { ok: false, error: { code: 'NO_TEST_HANDLER', message: `the test has no handler for ${channel}` } };
      try {
        return { ok: true, data: await handler(req) };
      } catch (err) {
        if (err instanceof BridgeError) return { ok: false, error: { code: err.code, message: err.message } };
        throw err;
      }
    }) as typeof window.oneLaunch.invoke,
  };
  return {
    calls,
    on: (channel, handler) => void table.set(channel, handler as (req: unknown) => unknown),
    sent: (channel) => calls.filter((c) => c.channel === channel).map((c) => c.req) as never,
  };
}

/** A promise a test settles by hand, for holding an IPC call open. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function resetUi(): void {
  beforeEach(async () => {
    const { useUiStore } = await import('../../src/renderer/src/store/ui');
    useUiStore.setState({
      view: 'library',
      settingsTab: 'general',
      launchRequest: null,
      activeLaunch: null,
      launcherStatus: null,
      updateStatus: null,
      confirm: null,
      leaveGuard: null,
      settingsRevision: 0,
      setupGuide: null,
      whatsNew: null,
      returnTo: null,
      importIntent: null,
    });
  });
  afterEach(() => cleanup());
}

// --- fixtures (placeholders only) ---------------------------------------------------------------

export function account(over: Partial<Account> = {}): Account {
  return {
    id: 'acct-main',
    launcher: 'steam',
    displayName: 'Main',
    login: 'user_1',
    hasSecret: false,
    hasSession: false,
    launcherUid: null,
    tags: [],
    notes: '',
    lastUsedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  };
}

export function game(over: Partial<Game> = {}): Game {
  return {
    id: 'game-1',
    launcher: 'steam',
    launcherGameId: '570',
    name: 'Dota 2',
    installPath: 'D:\\Games\\dota',
    installed: true,
    lastSeenAt: '2026-09-18T10:00:00.000Z',
    needsUpdate: false,
    lastPlayedAt: null,
    artwork: null,
    artworkError: null,
    lastLaunch: null,
    ...over,
  };
}

export function plan(over: Partial<SwitchPlan> = {}): SwitchPlan {
  const step = (id: string, title: string): SwitchPlan['steps'][number] => ({
    id,
    kind: 'process',
    title,
    target: '',
    detail: '',
    changes: [],
    skipped: false,
  });
  return {
    launcher: 'steam',
    account: { id: 'acct-alt', displayName: 'Alt', login: 'user_2', launcherUid: null },
    strategy: 'remembered',
    current: { mostRecentLogin: 'user_1', autoLoginUser: 'user_1', running: false },
    steps: [
      step('close', 'Close Steam'),
      step('backup', 'Take a snapshot'),
      step('file', 'Write loginusers.vdf'),
      step('start', 'Start Steam'),
      step('verify', 'Confirm the sign-in'),
    ],
    warnings: [],
    notes: [],
    executable: true,
    generatedAt: '2026-09-18T10:00:00.000Z',
    ...over,
  };
}

export function preflight(over: Partial<LaunchPreflight> = {}): LaunchPreflight {
  return {
    plan: plan(),
    dryRun: false,
    launcherRunning: false,
    runningGame: null,
    alreadyActive: false,
    needsConfirmation: false,
    closeMessage: null,
    blocked: null,
    ...over,
  };
}

export function jobStep(id: string, status: JobStep['status'], title = id): JobStep {
  return { id, title, status, detail: '' };
}

export function job(over: Partial<LaunchJob> = {}): LaunchJob {
  return {
    id: 'job-1',
    state: 'running',
    launcher: 'steam',
    account: { id: 'acct-alt', displayName: 'Alt', login: 'user_2' },
    game: { id: 'game-1', name: 'Dota 2', launcherGameId: '570' },
    steps: [
      jobStep('close', 'done'),
      jobStep('backup', 'running', 'Take a snapshot'),
      jobStep('start', 'pending'),
      jobStep('verify', 'pending'),
      jobStep('launch', 'pending'),
    ],
    attention: null,
    switched: false,
    handOff: null,
    backupId: null,
    restored: null,
    error: null,
    startedAt: '2026-09-18T10:00:00.000Z',
    finishedAt: null,
    ...over,
  };
}
