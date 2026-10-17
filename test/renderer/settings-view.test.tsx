// @vitest-environment jsdom
import './setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useUiStore } from '../../src/renderer/src/store/ui';
import { SettingsView } from '../../src/renderer/src/views/SettingsView';
import type { AppInfo, SettingKey } from '../../src/shared/models';
import { WHATS_NEW } from '../../src/shared/whats-new-releases';
import { installBridge, resetUi } from './harness';

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
  });
}

const traySwitch = () => screen.findByRole('switch', { name: 'Keep running in the system tray' });

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

describe("Settings › General: what's new", () => {
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

describe('Settings › Developer (development builds only)', () => {
  it('previews any entry in the file, whatever the running version', async () => {
    settingsPage({}, { ...info, version: '0.0.1' });
    const user = userEvent.setup();
    render(<SettingsView />);
    const preview = await screen.findByRole('button', { name: 'Preview' });
    await waitFor(() => expect(preview.hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('button', { name: "Show what's new" }).hasAttribute('disabled')).toBe(true);
    await user.click(preview);
    expect(useUiStore.getState().whatsNew).toEqual({ release: WHATS_NEW[0], version: '0.0.1' });
  });
});
