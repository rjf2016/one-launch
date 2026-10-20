// @vitest-environment jsdom
import './setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/src/App';
import { isBack, isShortcut, modalOpen } from '../../src/renderer/src/lib/shortcuts';
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
    'library:list': () => ({ games: [game()], revision: 1 }),
    'launch:recent': () => ({ recent: [] }),
    'artwork:status': () => ({ status: { queued: 0, running: 0, completed: 0, failed: 0, hasApiKey: false, revision: 1, scanned: true } }),
    'launchers:status': () => ({ launchers: [] }),
    'accounts:list': () => ({ accounts: [account()] }),
    'accounts:get': (req) => ({ account: account({ id: req.id }) }),
  });
}

const chord = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { ctrlKey: true, ...init });
const press = (key: string): boolean => fireEvent.keyDown(window, { key, ctrlKey: true });
const mouseBack = (): boolean => fireEvent.mouseUp(window, { button: 3 });
const altLeft = (): boolean => fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });

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

describe('isBack', () => {
  it('matches the mouse Back button and Alt+Left, nothing else', () => {
    expect(isBack(new MouseEvent('mouseup', { button: 3 }))).toBe(true);
    expect(isBack(new MouseEvent('mouseup', { button: 4 }))).toBe(false);
    expect(isBack(new MouseEvent('mouseup', { button: 0 }))).toBe(false);
    expect(isBack(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }))).toBe(true);
    expect(isBack(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true }))).toBe(false);
    expect(isBack(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, ctrlKey: true }))).toBe(false);
    expect(isBack(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true }))).toBe(false);
    expect(isBack(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))).toBe(false);
  });

  it('is refused while a modal dialog is open', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    try {
      expect(isBack(new MouseEvent('mouseup', { button: 3 }))).toBe(false);
      expect(isBack(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }))).toBe(false);
    } finally {
      dialog.remove();
    }
  });
});

describe('Back from an account’s page', () => {
  it('the mouse Back button returns to the Accounts list, and does nothing anywhere else', async () => {
    shell();
    render(<App />);
    await screen.findByRole('heading', { name: 'Library' });
    mouseBack();
    expect(useUiStore.getState().view).toBe('library');

    act(() => useUiStore.getState().openAccount('acct-main'));
    await screen.findByRole('heading', { name: 'Main' });
    mouseBack();
    await waitFor(() => expect(useUiStore.getState().accountRoute).toEqual({ kind: 'list' }));
    await screen.findByRole('heading', { name: 'Accounts' });
    mouseBack();
    expect(useUiStore.getState().view).toBe('accounts');
    expect(useUiStore.getState().accountRoute).toEqual({ kind: 'list' });
  });

  it('Alt+Left does the same, from the create form too', async () => {
    shell();
    render(<App />);
    await screen.findByRole('heading', { name: 'Library' });
    act(() => useUiStore.getState().newAccount('steam'));
    await screen.findByRole('heading', { name: 'New Steam account' });
    altLeft();
    await waitFor(() => expect(useUiStore.getState().accountRoute).toEqual({ kind: 'list' }));
    await screen.findByRole('heading', { name: 'Accounts' });
  });

  it('asks the leave guard like any other navigation, and stays when it says no', async () => {
    shell();
    render(<App />);
    await screen.findByRole('heading', { name: 'Library' });
    act(() => useUiStore.getState().openAccount('acct-main'));
    await screen.findByRole('heading', { name: 'Main' });
    let asked = 0;
    act(() =>
      useUiStore.getState().setLeaveGuard(() => {
        asked += 1;
        return Promise.resolve(false);
      }),
    );
    mouseBack();
    await waitFor(() => expect(asked).toBe(1));
    expect(useUiStore.getState().accountRoute).toEqual({ kind: 'detail', id: 'acct-main' });
    expect(screen.getByRole('heading', { name: 'Main' })).toBeTruthy();
  });

  it('is ignored while a dialog is open', async () => {
    shell();
    render(<App />);
    await screen.findByRole('heading', { name: 'Library' });
    act(() => useUiStore.getState().openAccount('acct-main'));
    await screen.findByRole('heading', { name: 'Main' });
    act(() => useUiStore.getState().openLaunch({ game: game(), initialAccountId: null }));
    await screen.findByRole('dialog');
    mouseBack();
    altLeft();
    expect(useUiStore.getState().accountRoute).toEqual({ kind: 'detail', id: 'acct-main' });
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
