// @vitest-environment jsdom
import './setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Sidebar } from '../../src/renderer/src/components/Sidebar';
import { useUiStore } from '../../src/renderer/src/store/ui';
import { SettingsView } from '../../src/renderer/src/views/SettingsView';
import type { AppInfo, AutostartStatus, SettingKey } from '../../src/shared/models';
import { WHATS_NEW } from '../../src/shared/whats-new-releases';
import { BridgeError, installBridge, resetUi } from './harness';

resetUi();

const info: AppInfo = {
  version: '1.0.0-test',
  electron: '44.0.0',
  node: '24.0.0',
  chrome: '140.0.0.0',
  isPackaged: false,
  dataDir: 'C:\\scratch\\data',
  logDir: 'C:\\scratch\\data\\logs',
  dbPath: 'C:\\scratch\\data\\onelaunch.db',
  startup: { processToNodeMs: 100, windowShownMs: 400, readyToShowMs: 500, didFinishLoadMs: 600 },
  platformSource: 'fake',
};

/** A main process that remembers settings, like the real settings table. */
function settingsPage(initial: Partial<Record<SettingKey, string>> = {}, appInfo: AppInfo = info) {
  const stored: Partial<Record<SettingKey, string>> = { ...initial };
  let autostart: AutostartStatus = { available: true, openAtLogin: false };
  return installBridge({
    'app:info': () => appInfo,
    'vault:status': () => ({ available: true, backend: 'dpapi', readable: true }),
    'settings:getAll': () => ({ settings: { ...stored } }),
    'settings:get': (req) => ({ value: stored[req.key] ?? null }),
    'settings:set': (req) => {
      stored[req.key] = req.value;
      return { ok: true };
    },
    'launchers:status': () => ({ launchers: [] }),
    'backups:list': () => ({ snapshots: [] }),
    'artwork:status': () => ({ status: { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true } }),
    'updates:status': () => ({ state: 'idle' }),
    'autostart:status': () => autostart,
    'autostart:set': (req) => {
      autostart = { ...autostart, openAtLogin: req.openAtLogin };
      return autostart;
    },
  });
}

const traySwitch = () => screen.findByRole('switch', { name: 'Keep running in the system tray' });
const tab = (name: string) => screen.getByRole('tab', { name });

describe('Settings › General: keep running in the system tray', () => {
  it('is on until the user turns it off, and stores the choice', async () => {
    const bridge = settingsPage();
    const user = userEvent.setup();
    render(<SettingsView />);
    const toggle = await traySwitch();
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await user.click(toggle);
    await waitFor(() => expect(bridge.sent('settings:set')).toEqual([{ key: 'window.closeToTray', value: 'false' }]));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });

  it('shows a stored off as off and turns it back on', async () => {
    const bridge = settingsPage({ 'window.closeToTray': 'false' });
    const user = userEvent.setup();
    render(<SettingsView />);
    const toggle = await traySwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(() => expect(bridge.sent('settings:set')).toEqual([{ key: 'window.closeToTray', value: 'true' }]));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });
});

describe('Settings › General: start with Windows', () => {
  const autostartSwitch = () => screen.findByRole('switch', { name: 'Start with Windows' });

  it('is off until the user turns it on, and asks Windows to start One Launch', async () => {
    const bridge = settingsPage();
    const user = userEvent.setup();
    render(<SettingsView />);
    const toggle = await autostartSwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(() => expect(bridge.sent('autostart:set')).toEqual([{ openAtLogin: true }]));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('turns off again', async () => {
    const bridge = settingsPage();
    const user = userEvent.setup();
    render(<SettingsView />);
    const toggle = await autostartSwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    await user.click(toggle);
    await waitFor(() => expect(bridge.sent('autostart:set')).toEqual([{ openAtLogin: true }, { openAtLogin: false }]));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });

  it('cannot be changed on a copy that may not start with Windows', async () => {
    const bridge = settingsPage();
    bridge.on('autostart:status', () => ({ available: false, openAtLogin: false }));
    render(<SettingsView />);
    const toggle = await autostartSwitch();
    await waitFor(() => expect(bridge.sent('autostart:status').length).toBeGreaterThan(0));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('says so under its row when Windows refuses, and stays off', async () => {
    const bridge = settingsPage();
    bridge.on('autostart:set', () => {
      throw new BridgeError('UNAVAILABLE', 'not in this copy');
    });
    const user = userEvent.setup();
    render(<SettingsView />);
    const toggle = await autostartSwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    await user.click(toggle);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not save the setting: not in this copy');
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(bridge.sent('autostart:status').length).toBeGreaterThan(1);
  });
});

describe("Settings › Updates: what's new", () => {
  const whatsNewSwitch = () => screen.findByRole('switch', { name: "Show what's new after an update" });
  const showButton = () => screen.getByRole('button', { name: "Show what's new" });

  it('is on until the user turns it off, and Show opens the newest notes for the running version', async () => {
    const bridge = settingsPage({}, { ...info, version: '99.0.0' });
    const user = userEvent.setup();
    render(<SettingsView />);
    const toggle = await whatsNewSwitch();
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await user.click(toggle);
    await waitFor(() => expect(bridge.sent('settings:set')).toEqual([{ key: 'whatsNew.enabled', value: 'false' }]));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    await waitFor(() => expect(showButton().hasAttribute('disabled')).toBe(false));
    await user.click(showButton());
    expect(useUiStore.getState().whatsNew).toEqual({ release: WHATS_NEW[0], version: '99.0.0' });
  });

  it('has nothing to show on a version older than every entry', async () => {
    settingsPage({}, { ...info, version: '0.0.1' });
    render(<SettingsView />);
    const toggle = await whatsNewSwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(showButton().hasAttribute('disabled')).toBe(true);
    expect(useUiStore.getState().whatsNew).toBeNull();
  });
});

describe('Settings › tabs', () => {
  it('opens on General and mounts a tab only once it is chosen', async () => {
    const bridge = settingsPage();
    const user = userEvent.setup();
    render(<SettingsView />);
    await traySwitch();
    expect(tab('General').getAttribute('aria-selected')).toBe('true');
    expect(bridge.sent('backups:list')).toHaveLength(0);
    await user.click(tab('Backups'));
    expect(tab('Backups').getAttribute('aria-selected')).toBe('true');
    expect(tab('General').getAttribute('aria-selected')).toBe('false');
    expect(await screen.findByRole('heading', { name: 'Backups' })).toBeTruthy();
    await waitFor(() => expect(bridge.sent('backups:list').length).toBeGreaterThan(0));
    expect(screen.queryByRole('switch', { name: 'Keep running in the system tray' })).toBeNull();
  });

  it('moves with the arrow keys, Home and End, wrapping at the ends', async () => {
    settingsPage();
    const user = userEvent.setup();
    render(<SettingsView />);
    await traySwitch();
    tab('General').focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab('Launchers'));
    expect(tab('Launchers').getAttribute('aria-selected')).toBe('true');
    expect(tab('General').getAttribute('tabindex')).toBe('-1');
    expect(await screen.findByRole('heading', { name: 'Play' })).toBeTruthy();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(tab('Advanced'));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab('General'));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(tab('Advanced'));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(tab('General'));
    expect(tab('General').getAttribute('tabindex')).toBe('0');
  });

  it('keeps the chosen tab for the session, and openSettings picks one from anywhere', async () => {
    const store = useUiStore.getState();
    store.openSettings('advanced');
    await waitFor(() => expect(useUiStore.getState()).toMatchObject({ view: 'settings', settingsTab: 'advanced' }));
    store.setView('library');
    await waitFor(() => expect(useUiStore.getState().view).toBe('library'));
    store.setView('settings');
    await waitFor(() => expect(useUiStore.getState().view).toBe('settings'));
    expect(useUiStore.getState().settingsTab).toBe('advanced');
  });

  it('stays put when a form with unsaved edits says no', async () => {
    useUiStore.setState({ leaveGuard: () => Promise.resolve(false) });
    useUiStore.getState().openSettings('backups');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useUiStore.getState()).toMatchObject({ view: 'library', settingsTab: 'general' });
  });
});

describe('Settings › Advanced: preview mode', () => {
  it('lives under Advanced, off until the user turns it on', async () => {
    const bridge = settingsPage();
    const user = userEvent.setup();
    render(<SettingsView />);
    await traySwitch();
    expect(screen.queryByRole('switch', { name: 'Preview mode' })).toBeNull();
    await user.click(tab('Advanced'));
    const toggle = await screen.findByRole('switch', { name: 'Preview mode' });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(() => expect(bridge.sent('settings:set')).toEqual([{ key: 'dryRun', value: 'true' }]));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });
});

describe('Settings › a setting that will not save', () => {
  it('says so under its row and puts the control back', async () => {
    const bridge = settingsPage();
    bridge.on('settings:set', () => {
      throw new BridgeError('DB_ERROR', 'disk full');
    });
    const user = userEvent.setup();
    render(<SettingsView />);
    const toggle = await traySwitch();
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    await user.click(toggle);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not save the setting: disk full');
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('re-reads every setting when another part of the app changes one', async () => {
    const bridge = settingsPage();
    render(<SettingsView />);
    await traySwitch();
    const before = bridge.sent('settings:getAll').length;
    act(() => useUiStore.getState().settingsChanged());
    await waitFor(() => expect(bridge.sent('settings:getAll')).toHaveLength(before + 1));
  });
});

describe('Sidebar › Preview mode card', () => {
  it('opens Settings on Advanced', async () => {
    settingsPage({ dryRun: 'true' });
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.click(await screen.findByRole('button', { name: 'Preview mode is on' }));
    await waitFor(() => expect(useUiStore.getState()).toMatchObject({ view: 'settings', settingsTab: 'advanced' }));
  });
});

describe('Settings › Developer (development builds only)', () => {
  it('previews any entry in the file, whatever the running version', async () => {
    settingsPage({}, { ...info, version: '0.0.1' });
    const user = userEvent.setup();
    render(<SettingsView />);
    const show = await screen.findByRole('button', { name: "Show what's new" });
    expect(show.hasAttribute('disabled')).toBe(true);
    await user.click(tab('Advanced'));
    const preview = await screen.findByRole('button', { name: 'Preview' });
    await waitFor(() => expect(preview.hasAttribute('disabled')).toBe(false));
    await user.click(preview);
    expect(useUiStore.getState().whatsNew).toEqual({ release: WHATS_NEW[0], version: '0.0.1' });
  });
});
