// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../src/renderer/src/components/Sidebar';
import { UpdatesPanel } from '../../src/renderer/src/components/UpdatesPanel';
import { useUiStore } from '../../src/renderer/src/store/ui';
import { SettingsView } from '../../src/renderer/src/views/SettingsView';
import type { AppInfo, SettingKey, UpdateStatus } from '../../src/shared/models';
import { BridgeError, installBridge, job, resetUi } from './harness';

resetUi();

const info: AppInfo = {
  version: '1.0.0-beta.2',
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

function updatesBridge(initial: UpdateStatus, settings: Partial<Record<SettingKey, string>> = {}) {
  let status = initial;
  const stored = { ...settings };
  const bridge = installBridge({
    'app:info': () => info,
    'vault:status': () => ({ available: true, backend: 'dpapi', readable: true }),
    'settings:getAll': () => ({ settings: { ...stored } }),
    'settings:set': (req) => {
      stored[req.key] = req.value;
      return { ok: true };
    },
    'launchers:status': () => ({ launchers: [] }),
    'backups:list': () => ({ snapshots: [] }),
    'artwork:status': () => ({ status: { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true } }),
    'updates:status': () => status,
    'updates:check': () => {
      status = { state: 'checking' };
      return status;
    },
    'updates:install': () => ({ ok: true }),
  });
  return { bridge, set: (next: UpdateStatus) => void (status = next) };
}

function panel(onAuto: (next: boolean) => void = () => {}, auto = true) {
  return render(<UpdatesPanel version="1.0.0-beta.2" auto={auto} settingsLoading={false} onAuto={onAuto} />);
}

describe('Settings › Updates', () => {
  it('keeps One Launch updated automatically until the user turns it off', async () => {
    const { bridge } = updatesBridge({ state: 'idle' });
    const user = userEvent.setup();
    render(<SettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Keep One Launch updated automatically' });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    await waitFor(() => expect(bridge.sent('settings:set')).toEqual([{ key: 'updates.auto', value: 'false' }]));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });

  it('checks when asked and shows the check running', async () => {
    const { bridge } = updatesBridge({ state: 'up-to-date', checkedAt: '2026-10-01T12:00:00.000Z' });
    const user = userEvent.setup();
    panel();
    expect(await screen.findByText('Up to date')).toBeTruthy();
    expect(screen.getByText(/^Last checked at /)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(bridge.sent('updates:check')).toHaveLength(1);
    expect(await screen.findByText(/Checking…/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled')).toBe(true);
  });

  it('follows a download to the end and then offers Restart to update', async () => {
    const { bridge, set } = updatesBridge({ state: 'downloading', version: '1.0.0-beta.3', percent: 40 });
    const user = userEvent.setup();
    panel();
    expect(await screen.findByText(/Downloading 1\.0\.0-beta\.3 · 40%/)).toBeTruthy();
    set({ state: 'ready', version: '1.0.0-beta.3' });
    const restart = await screen.findByRole('button', { name: 'Restart to update' }, { timeout: 3000 });
    expect(screen.getByText('It installs the next time One Launch restarts.')).toBeTruthy();
    await user.click(restart);
    await waitFor(() => expect(bridge.sent('updates:install')).toHaveLength(1));
  });

  it('says when an update was refused because it could not be verified', async () => {
    updatesBridge({ state: 'failed', step: 'verify', message: 'the release is not signed' });
    panel();
    expect((await screen.findByRole('alert')).textContent).toBe('Could not verify the update, so it was not installed: the release is not signed.');
    expect(screen.getByText('Not verified')).toBeTruthy();
  });

  it('explains why a copy cannot update itself and offers no check', async () => {
    updatesBridge({ state: 'unavailable', reason: 'custom-data-folder' });
    panel();
    expect(await screen.findByText('Updates are off while One Launch runs from a custom data folder.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows why Restart to update was refused', async () => {
    const { bridge } = updatesBridge({ state: 'ready', version: '1.0.0-beta.3' });
    bridge.on('updates:install', () => {
      throw new BridgeError('BUSY', 'Another switch or launch is still running');
    });
    const user = userEvent.setup();
    panel();
    await user.click(await screen.findByRole('button', { name: 'Restart to update' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not restart to update: Another switch or launch is still running');
  });
});

describe('Sidebar update card', () => {
  const card = (version = '1.0.0-beta.3') => screen.findByRole('button', { name: `Restart to install One Launch ${version}` });

  it('appears only once an update is ready, and restarts into it', async () => {
    const { bridge } = updatesBridge({ state: 'ready', version: '1.0.0-beta.3' });
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.click(await card());
    await waitFor(() => expect(bridge.sent('updates:install')).toHaveLength(1));
  });

  it('is not there while nothing is ready', async () => {
    const { bridge } = updatesBridge({ state: 'up-to-date', checkedAt: '2026-10-01T12:00:00.000Z' });
    render(<Sidebar />);
    await waitFor(() => expect(bridge.sent('updates:status').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Restart to install/ })).toBeNull();
  });

  it('waits while a switch runs', async () => {
    updatesBridge({ state: 'ready', version: '1.0.0-beta.3' });
    useUiStore.setState({ activeLaunch: { job: job({ state: 'running' }), game: null } });
    render(<Sidebar />);
    expect((await card()).hasAttribute('disabled')).toBe(true);
  });

  it('keeps unsaved edits when the user chooses to stay', async () => {
    const { bridge } = updatesBridge({ state: 'ready', version: '1.0.0-beta.3' });
    const guard = vi.fn(async () => false);
    useUiStore.setState({ leaveGuard: guard });
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.click(await card());
    await waitFor(() => expect(guard).toHaveBeenCalledTimes(1));
    expect(bridge.sent('updates:install')).toEqual([]);
    expect((await card()).hasAttribute('disabled')).toBe(false);
  });
});
