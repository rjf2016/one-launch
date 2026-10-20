// @vitest-environment jsdom
import './setup';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';
import { RecoveryHost } from '../../src/renderer/src/components/RecoveryDialog';
import { ipc, useIpcQuery } from '../../src/renderer/src/lib/ipc';
import { closeStartup, peekStartup, prefetchStartup } from '../../src/renderer/src/lib/startup';
import { LibraryView } from '../../src/renderer/src/views/LibraryView';
import { STARTUP_REQUESTS } from '../../src/shared/ipc-contract';
import type { AppInfo, SwitchRecovery } from '../../src/shared/models';
import { account, BridgeError, deferred, game, installBridge, resetUi, type Handlers } from './harness';

resetUi();

const info: AppInfo = {
  version: '1.0.0-beta.3',
  electron: '44.0.0',
  node: '24.0.0',
  chrome: '140.0.0.0',
  isPackaged: true,
  dataDir: 'C:\\scratch\\data',
  logDir: 'C:\\scratch\\data\\logs',
  dbPath: 'C:\\scratch\\data\\onelaunch.db',
  startup: { processToNodeMs: 100, windowShownMs: 400, readyToShowMs: 500, didFinishLoadMs: 600 },
  platformSource: 'real',
};

const status = { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true };

function everyday(over: Handlers = {}): Handlers {
  return {
    'app:info': () => info,
    'settings:getAll': () => ({ settings: { 'firstRun.dismissed': 'true', 'whatsNew.lastSeen': info.version } }),
    'accounts:list': () => ({ accounts: [account()] }),
    'library:list': () => ({ games: [game({ id: 'g1', name: 'Dota 2' }), game({ id: 'g2', name: 'Hades' })], revision: 1 }),
    'launch:recent': () => ({ recent: [] }),
    'recovery:get': () => ({ recovery: null }),
    'updates:status': () => ({ state: 'idle', version: null, error: null, checkedAt: null, reason: null }) as never,
    'artwork:status': () => ({ status }),
    ...over,
  };
}

function Probe() {
  const q = useIpcQuery(
    () => ipc.invoke('accounts:list'),
    [],
    () => peekStartup('accounts:list'),
  );
  return (
    <div>
      <span data-testid="data">{q.data?.accounts.map((a) => a.displayName).join(',') ?? ''}</span>
      <span data-testid="loading">{String(q.loading)}</span>
    </div>
  );
}

describe('startup prefetch (lib/startup.ts)', () => {
  it('sends exactly the startup requests, through the startup answers, and resolves at the cap when one answer is slow', async () => {
    const held = deferred<{ recent: never[] }>();
    const bridge = installBridge(everyday({ 'launch:recent': () => held.promise }));
    const started = Date.now();
    await prefetchStartup(window.oneLaunch, 30);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(bridge.calls.map((c) => [c.channel, c.req])).toEqual(Object.entries(STARTUP_REQUESTS));
    expect(peekStartup('library:list')?.games.map((g) => g.name)).toEqual(['Dota 2', 'Hades']);
    expect(peekStartup('launch:recent', { limit: 8 })).toBeUndefined();
    held.resolve({ recent: [] });
    await act(async () => undefined);
    expect(peekStartup('launch:recent', { limit: 8 })).toEqual({ recent: [] });
  });

  it('never serves a failure, another request, or anything after the window has closed', async () => {
    installBridge(
      everyday({
        'library:list': () => {
          throw new BridgeError('INTERNAL', 'database is locked');
        },
      }),
    );
    await prefetchStartup(window.oneLaunch, 30);
    expect(peekStartup('library:list')).toBeUndefined();
    expect(peekStartup('launch:recent', { limit: 5 })).toBeUndefined();
    expect(peekStartup('app:info')?.version).toBe(info.version);
    closeStartup();
    expect(peekStartup('app:info')).toBeUndefined();
  });

  it('lets an invoke during the window join the startup call, and asks main again once it has closed', async () => {
    let served = 0;
    const bridge = installBridge(
      everyday({
        'library:list': () => {
          served++;
          return { games: [], revision: 1 };
        },
      }),
    );
    await prefetchStartup(window.oneLaunch, 30);
    await ipc.invoke('library:list');
    await ipc.invoke('library:list');
    expect(served).toBe(1);
    expect(bridge.sent('library:list')).toHaveLength(1);
    closeStartup();
    await ipc.invoke('library:list');
    expect(served).toBe(2);
  });

  it('seeds useIpcQuery synchronously, with no first fetch', async () => {
    const bridge = installBridge(everyday());
    await prefetchStartup(window.oneLaunch, 30);
    render(<Probe />);
    expect(screen.getByTestId('data').textContent).toBe('Main');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    await act(async () => undefined);
    expect(bridge.sent('accounts:list')).toHaveLength(1);
  });

  it('falls back to fetching when a bridge has no startup answers', async () => {
    const bridge = installBridge(everyday());
    const { startup: _startup, ...invokeOnly } = window.oneLaunch;
    await prefetchStartup(invokeOnly as typeof window.oneLaunch, 30);
    expect(bridge.calls.map((c) => c.channel)).toEqual(Object.keys(STARTUP_REQUESTS));
    expect(peekStartup('app:info')?.version).toBe(info.version);
  });
});

describe('the first commit holds the library', () => {
  it('renders the grid synchronously from the prefetched list, without the scanning state, and lists once', async () => {
    const bridge = installBridge(everyday());
    await prefetchStartup(window.oneLaunch, 30);
    render(<LibraryView />);
    expect(screen.getAllByRole('button', { name: /^Play / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Play Dota 2', 'Play Hades']);
    expect(screen.queryByText('Scanning your launchers…')).toBeNull();
    await act(async () => undefined);
    expect(bridge.sent('library:list')).toHaveLength(1);
  });

  it('lists again when the startup scan finished between the prefetch and the first poll', async () => {
    let scanned = false;
    const bridge = installBridge(
      everyday({
        'library:list': () => ({ games: scanned ? [game({ id: 'g1', name: 'Dota 2' })] : [], revision: scanned ? 2 : 1 }),
        'artwork:status': () => ({ status: { ...status, revision: scanned ? 2 : 1 } }),
      }),
    );
    await prefetchStartup(window.oneLaunch, 30);
    scanned = true;
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Play Dota 2' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Play Dota 2' })).toBeTruthy();
    expect(bridge.sent('library:list')).toHaveLength(2);
  });

  it('shows the usual error when the prefetched list failed, after one call in total', async () => {
    let served = 0;
    const bridge = installBridge(
      everyday({
        'library:list': () => {
          served++;
          throw new BridgeError('INTERNAL', 'database is locked');
        },
      }),
    );
    await prefetchStartup(window.oneLaunch, 30);
    render(<LibraryView />);
    await act(async () => undefined);
    expect(screen.getByText(/Could not load the library: database is locked/)).toBeTruthy();
    expect(served).toBe(1);
    expect(bridge.sent('library:list')).toHaveLength(1);
  });

  it('puts the recovery question in the first commit', async () => {
    const recovery: SwitchRecovery = {
      launcher: 'steam',
      account: { id: 'acct-alt', displayName: 'Alt', login: 'user_2' },
      backupId: 'b1',
      startedAt: '2026-10-18T10:00:00.000Z',
      step: 'file',
      launcherRunning: false,
    } as never;
    const bridge = installBridge(everyday({ 'recovery:get': () => ({ recovery }) }));
    await prefetchStartup(window.oneLaunch, 30);
    render(<RecoveryHost />);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => undefined);
    expect(bridge.sent('recovery:get')).toHaveLength(1);
  });

  it('App asks for each startup answer once and closes the window after its first effects', async () => {
    const bridge = installBridge(everyday());
    await prefetchStartup(window.oneLaunch, 30);
    render(<App />);
    expect(screen.getByRole('button', { name: 'Play Dota 2' })).toBeTruthy();
    await act(async () => undefined);
    for (const channel of ['app:info', 'settings:getAll', 'recovery:get', 'library:list', 'launch:recent', 'accounts:list'] as const) {
      expect(bridge.sent(channel), channel).toHaveLength(1);
    }
    expect(peekStartup('app:info')).toBeUndefined();
  });
});
