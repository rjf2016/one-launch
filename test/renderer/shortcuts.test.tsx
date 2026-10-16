// @vitest-environment jsdom
import './setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';
import { isShortcut, modalOpen } from '../../src/renderer/src/lib/shortcuts';
import { useUiStore } from '../../src/renderer/src/store/ui';
import type { AppInfo } from '../../src/shared/models';
import { account, game, installBridge, resetUi } from './harness';

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

function shell() {
  return installBridge({
    'app:info': () => info,
    'settings:getAll': () => ({ settings: { 'firstRun.dismissed': 'true', 'whatsNew.lastSeen': info.version } }),
    'library:list': () => ({ games: [game()] }),
    'launch:recent': () => ({ recent: [] }),
    'artwork:status': () => ({ status: { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true } }),
    'launchers:status': () => ({ launchers: [] }),
    'accounts:list': () => ({ accounts: [account()] }),
  });
}

const chord = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { ctrlKey: true, ...init });
const press = (key: string): boolean => fireEvent.keyDown(window, { key, ctrlKey: true });

describe('isShortcut', () => {
  it('matches the plain Ctrl chord only, whatever the case of the key', () => {
    expect(isShortcut(chord({ key: '2' }), '2')).toBe(true);
    expect(isShortcut(chord({ key: 'F' }), 'f')).toBe(true);
    expect(isShortcut(chord({ key: '2', ctrlKey: false }), '2')).toBe(false);
    expect(isShortcut(chord({ key: '2', shiftKey: true }), '2')).toBe(false);
    expect(isShortcut(chord({ key: '2', altKey: true }), '2')).toBe(false);
    expect(isShortcut(chord({ key: '3' }), '2')).toBe(false);
  });

  it('is refused while a modal dialog is open', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    try {
      expect(modalOpen()).toBe(true);
      expect(isShortcut(chord({ key: '2' }), '2')).toBe(false);
    } finally {
      dialog.remove();
    }
    expect(modalOpen()).toBe(false);
    expect(isShortcut(chord({ key: '2' }), '2')).toBe(true);
  });

  it('skips a text field only when asked to', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const seen: { event: KeyboardEvent | null } = { event: null };
    input.addEventListener('keydown', (e) => {
      seen.event = e;
    });
    try {
      fireEvent.keyDown(input, { key: 's', ctrlKey: true });
      expect(seen.event).not.toBeNull();
      expect(isShortcut(seen.event!, 's')).toBe(true);
      expect(isShortcut(seen.event!, 's', { inFields: false })).toBe(false);
    } finally {
      input.remove();
    }
  });
});

describe('shortcuts while a dialog is open', () => {
  it('Ctrl+2 and Ctrl+F do nothing until the launch dialog is closed', async () => {
    shell();
    render(<App />);
    await screen.findByRole('heading', { name: 'Library' });
    act(() => useUiStore.getState().openLaunch({ game: game(), initialAccountId: null }));
    await screen.findByRole('dialog');

    press('2');
    expect(useUiStore.getState().view).toBe('library');
    expect(screen.getByRole('dialog')).toBeTruthy();
    press('f');
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Search games' }));

    act(() => useUiStore.getState().closeLaunch());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    press('2');
    await waitFor(() => expect(useUiStore.getState().view).toBe('accounts'));
  });
});
