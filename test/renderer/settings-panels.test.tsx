// @vitest-environment jsdom
import './setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ArtworkPanel } from '../../src/renderer/src/components/ArtworkPanel';
import { BackupsPanel } from '../../src/renderer/src/components/BackupsPanel';
import { LauncherStatusPanel } from '../../src/renderer/src/components/LauncherStatusPanel';
import type { ArtworkStatus, LauncherStatus } from '../../src/shared/models';
import { BridgeError, deferred, installBridge, resetUi } from './harness';

resetUi();

describe('ArtworkPanel: getting a SteamGridDB key', () => {
  const status = (hasApiKey: boolean): ArtworkStatus => ({ queued: 0, running: 0, completed: 0, failed: 0, hasApiKey, revision: 1, scanned: true });

  it('says who needs a key and opens the page to get one through main, never a URL of its own', async () => {
    const bridge = installBridge({ 'artwork:status': () => ({ status: status(false) }), 'app:openUrl': () => ({ ok: true }) });
    const user = userEvent.setup();
    render(<ArtworkPanel autoFetch settingsLoading={false} vaultAvailable onAutoFetch={() => undefined} />);
    expect(screen.getByText('Covers come from Steam. Other games need a free SteamGridDB key.')).toBeTruthy();
    expect(await screen.findByText('Free. Press Get a key, sign in, paste it here.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Get a key' }));
    await waitFor(() => expect(bridge.sent('app:openUrl')).toEqual([{ target: 'steamgriddb-api-key' }]));
  });

  it('drops the button once a key is stored', async () => {
    installBridge({ 'artwork:status': () => ({ status: status(true) }) });
    render(<ArtworkPanel autoFetch settingsLoading={false} vaultAvailable onAutoFetch={() => undefined} />);
    expect(await screen.findByText('Paste a new key to replace the stored one.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Get a key' })).toBeNull();
  });

  it('says when the browser could not be opened', async () => {
    installBridge({
      'artwork:status': () => ({ status: status(false) }),
      'app:openUrl': () => {
        throw new BridgeError('OPEN_FAILED', 'no browser');
      },
    });
    const user = userEvent.setup();
    render(<ArtworkPanel autoFetch settingsLoading={false} vaultAvailable onAutoFetch={() => undefined} />);
    await user.click(await screen.findByRole('button', { name: 'Get a key' }));
    expect(await screen.findByText('Could not open the browser: no browser')).toBeTruthy();
  });
});

function launcher(over: Partial<LauncherStatus> & Pick<LauncherStatus, 'launcher' | 'displayName'>): LauncherStatus {
  return {
    implemented: true,
    install: {
      launcher: over.launcher,
      installDir: `C:\\Launchers\\${over.displayName}`,
      exePath: `C:\\Launchers\\${over.displayName}\\x.exe`,
      source: 'registry-hklm',
    },
    chosenPath: null,
    running: false,
    health: {
      launcher: over.launcher,
      status: 'ok',
      checks: [{ id: 'install', label: 'Installation', status: 'ok', detail: 'found' }],
      checkedAt: '2026-09-18T10:00:00.000Z',
    },
    attention: null,
    ...over,
  };
}

describe('BackupsPanel: snapshots to keep (B14)', () => {
  const lists = { 'backups:list': () => ({ snapshots: [] }) };

  it('shows the default when nothing is stored and writes the choice', async () => {
    let stored: string | null = null;
    const bridge = installBridge({
      ...lists,
      'settings:get': () => ({ value: stored }),
      'settings:set': (req) => {
        stored = req.value;
        return { ok: true };
      },
    });
    const user = userEvent.setup();
    render(<BackupsPanel />);
    await user.click(await screen.findByRole('button', { name: /20 \(default\)/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['5', '10', '20 (default)', '50', '100']);
    await user.click(screen.getByRole('option', { name: '50' }));
    await waitFor(() => expect(bridge.sent('settings:set')).toEqual([{ key: 'backups.keep', value: '50' }]));
    expect(await screen.findByRole('button', { name: 'Snapshots to keep: 50' })).toBeTruthy();
  });

  it('keeps a number that was set outside the app selectable', async () => {
    installBridge({ ...lists, 'settings:get': () => ({ value: '30' }) });
    const user = userEvent.setup();
    render(<BackupsPanel />);
    await user.click(await screen.findByRole('button', { name: 'Snapshots to keep: 30' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['5', '10', '20 (default)', '30', '50', '100']);
  });

  it('says so when the setting cannot be saved, and shows the stored value again', async () => {
    installBridge({
      ...lists,
      'settings:get': () => ({ value: null }),
      'settings:set': () => {
        throw new BridgeError('INTERNAL', 'database is locked');
      },
    });
    const user = userEvent.setup();
    render(<BackupsPanel />);
    await user.click(await screen.findByRole('button', { name: /20 \(default\)/ }));
    await user.click(screen.getByRole('option', { name: '100' }));
    expect(await screen.findByText('Could not save the setting: database is locked')).toBeTruthy();
    expect(screen.getByRole('button', { name: /20 \(default\)/ })).toBeTruthy();
  });
});

describe('BackupsPanel: snapshots kept out of the clean-up (B23)', () => {
  it('marks a pinned snapshot as Kept and says why, and leaves ordinary ones unmarked', async () => {
    const snapshot = (id: string, pinned: string | null) => ({
      id,
      launcher: 'epic' as const,
      createdAt: '2026-09-18T10:00:00.000Z',
      reason: 'Before switching to Alt',
      files: ['Config/Windows/GameUserSettings.ini'],
      bytes: 2048,
      pinned,
      path: `D:\\data\\backups\\epic\\${id}`,
    });
    installBridge({
      'settings:get': () => ({ value: null }),
      'backups:list': (req) => ({
        snapshots:
          req.launcher === 'epic'
            ? [snapshot('2026-09-18T10-00-00.000Z', null), snapshot('2026-09-17T10-00-00.000Z', 'Holds a sign-in that no One Launch account owns')]
            : [],
      }),
    });
    const user = userEvent.setup();
    render(<BackupsPanel />);
    expect(screen.getByText(/Kept snapshots never count/)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: /Epic Games.*2 snapshots/ }));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).queryByText('Kept')).toBeNull();
    expect(within(rows[1]!).getByText('Kept')).toBeTruthy();
    expect(rows[1]!.textContent).toContain('Holds a sign-in that no One Launch account owns · Before switching to Alt');
  });
});

describe('LauncherStatusPanel: Locate and Reset (B6)', () => {
  const steam = launcher({ launcher: 'steam', displayName: 'Steam' });
  const epicMissing = launcher({
    launcher: 'epic',
    displayName: 'Epic Games',
    install: null,
    running: null,
    health: {
      launcher: 'epic',
      status: 'absent',
      checks: [{ id: 'install', label: 'Installation', status: 'absent', detail: 'not installed' }],
      checkedAt: 'x',
    },
  });
  const bnetChosen = launcher({
    launcher: 'battlenet',
    displayName: 'Battle.net',
    chosenPath: 'E:\\Blizzard\\Battle.net',
    install: { launcher: 'battlenet', installDir: 'E:\\Blizzard\\Battle.net', exePath: 'E:\\Blizzard\\Battle.net\\Battle.net.exe', source: 'user' },
  });
  const row = (name: string): HTMLElement => screen.getByText(name).closest('div.py-2\\.5') as HTMLElement;

  it('offers Locate on the row of a launcher that was not found, names only the launcher, and re-checks after a pick', async () => {
    let statusCalls = 0;
    const bridge = installBridge({
      'launchers:status': () => {
        statusCalls++;
        return { launchers: [steam, epicMissing, bnetChosen] };
      },
      'launchers:locate': () => ({ install: { launcher: 'epic', installDir: 'E:\\Epic\\Launcher', exePath: 'E:\\Epic\\Launcher\\x.exe', source: 'user' } }),
    });
    const user = userEvent.setup();
    render(<LauncherStatusPanel />);
    await screen.findAllByText('Not installed');
    expect(within(row('Steam')).queryByRole('button', { name: 'Locate…' })).toBeNull();
    await user.click(within(row('Epic Games')).getByRole('button', { name: 'Locate…' }));
    await waitFor(() => expect(statusCalls).toBe(2));
    expect(bridge.sent('launchers:locate')).toEqual([{ launcher: 'epic' }]);
  });

  it('does nothing more when the file dialog was cancelled, and shows a wrong file as an alert', async () => {
    let statusCalls = 0;
    let answer: 'cancel' | 'wrong' = 'cancel';
    installBridge({
      'launchers:status': () => {
        statusCalls++;
        return { launchers: [steam, epicMissing, bnetChosen] };
      },
      'launchers:locate': () => {
        if (answer === 'wrong')
          throw new BridgeError('NOT_A_LAUNCHER', 'That file is not Epic Games. Choose EpicGamesLauncher.exe in the folder Epic Games is installed in.');
        return { install: null };
      },
    });
    const user = userEvent.setup();
    render(<LauncherStatusPanel />);
    await screen.findAllByText('Not installed');
    await user.click(within(row('Epic Games')).getByRole('button', { name: 'Locate…' }));
    await waitFor(() => expect((within(row('Epic Games')).getByRole('button', { name: 'Locate…' }) as HTMLButtonElement).disabled).toBe(false));
    expect(statusCalls).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();

    answer = 'wrong';
    await user.click(within(row('Epic Games')).getByRole('button', { name: 'Locate…' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/^That file is not Epic Games\./);
    expect(statusCalls).toBe(1);
  });

  it('says where the installation came from, and offers Reset only for a folder the user chose', async () => {
    let statusCalls = 0;
    const bridge = installBridge({
      'launchers:status': () => {
        statusCalls++;
        return { launchers: [steam, epicMissing, bnetChosen] };
      },
      'launchers:resetPath': () => ({ ok: true }),
    });
    const user = userEvent.setup();
    render(<LauncherStatusPanel />);
    await user.click(await screen.findByRole('button', { name: /Steam/ }));
    expect(within(row('Steam')).getByText('Found automatically.')).toBeTruthy();
    expect(within(row('Steam')).getByRole('button', { name: 'Locate…' })).toBeTruthy();
    expect(within(row('Steam')).queryByRole('button', { name: 'Reset' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Battle\.net/ }));
    expect(within(row('Battle.net')).getByText('You chose this folder.')).toBeTruthy();
    await user.click(within(row('Battle.net')).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(statusCalls).toBe(2));
    expect(bridge.sent('launchers:resetPath')).toEqual([{ launcher: 'battlenet' }]);
  });

  it('shows Checking… on the row that changed its folder until the re-check is back', async () => {
    const recheck = deferred<{ launchers: LauncherStatus[] }>();
    let statusCalls = 0;
    installBridge({
      'launchers:status': () => (++statusCalls === 1 ? { launchers: [steam, epicMissing, bnetChosen] } : recheck.promise),
      'launchers:resetPath': () => ({ ok: true }),
    });
    const user = userEvent.setup();
    render(<LauncherStatusPanel />);
    await user.click(await screen.findByRole('button', { name: /Battle\.net/ }));
    await user.click(within(row('Battle.net')).getByRole('button', { name: 'Reset' }));
    expect(await within(row('Battle.net')).findByText('Checking…')).toBeTruthy();
    expect((within(row('Battle.net')).getByRole('button', { name: 'Reset' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(row('Battle.net')).getByRole('button', { name: 'Locate…' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => recheck.resolve({ launchers: [steam, epicMissing, launcher({ launcher: 'battlenet', displayName: 'Battle.net' })] }));
    expect(within(row('Battle.net')).getByText('Found automatically.')).toBeTruthy();
    expect(within(row('Battle.net')).queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('shows the last known rows at once on the next visit, while the fresh status loads', async () => {
    const slow = deferred<{ launchers: LauncherStatus[] }>();
    let statusCalls = 0;
    installBridge({ 'launchers:status': () => (++statusCalls === 1 ? { launchers: [steam, epicMissing, bnetChosen] } : slow.promise) });
    const first = render(<LauncherStatusPanel />);
    await screen.findByText('C:\\Launchers\\Steam');
    first.unmount();

    render(<LauncherStatusPanel />);
    expect(screen.getByText('C:\\Launchers\\Steam')).toBeTruthy();
    expect(statusCalls).toBe(2);
    await act(async () => slow.resolve({ launchers: [launcher({ launcher: 'steam', displayName: 'Steam', running: true }), epicMissing, bnetChosen] }));
    expect(within(row('Steam')).getByText('Running')).toBeTruthy();
  });

  it('tells the user when the folder they chose no longer holds the launcher', async () => {
    const stale = launcher({ launcher: 'steam', displayName: 'Steam', chosenPath: 'E:\\Old\\Steam' });
    installBridge({ 'launchers:status': () => ({ launchers: [stale] }) });
    const user = userEvent.setup();
    render(<LauncherStatusPanel />);
    await user.click(await screen.findByRole('button', { name: /Steam/ }));
    expect(screen.getByText('steam.exe is no longer in the folder you chose.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy();
  });
});
