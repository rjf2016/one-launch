import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { App } from 'electron';
import { LOGIN_ITEM_NAME, loginItemAvailable, MemoryLoginItem, START_HIDDEN_FLAG, WindowsLoginItem } from '../src/main/platform/login-item';

const EXE = 'C:\\Users\\someone\\AppData\\Local\\Programs\\One Launch\\One Launch.exe';

function stubApp(willLaunch = false) {
  const calls: { method: string; arg: unknown }[] = [];
  const app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'> = {
    getLoginItemSettings: (options) => {
      calls.push({ method: 'get', arg: options });
      return { openAtLogin: false, executableWillLaunchAtLogin: willLaunch, launchItems: [], wasOpenedAtLogin: false, status: 'not-registered' };
    },
    setLoginItemSettings: (settings) => {
      calls.push({ method: 'set', arg: settings });
      willLaunch = settings.openAtLogin === true;
    },
  };
  return { app, calls };
}

describe('WindowsLoginItem', () => {
  it('when unavailable reports off without reading the registry, and refuses to write', () => {
    const { app, calls } = stubApp(true);
    const item = new WindowsLoginItem({ available: false, execPath: EXE, app });
    expect(item.status()).toEqual({ available: false, openAtLogin: false });
    expect(() => item.set(true)).toThrow(/not available/);
    expect(calls).toEqual([]);
  });

  it('reports what Windows will launch, asked for this exe with its path quoted (Electron parses it as a command line)', () => {
    const on = stubApp(true);
    expect(new WindowsLoginItem({ available: true, execPath: EXE, app: on.app }).status()).toEqual({ available: true, openAtLogin: true });
    expect(on.calls).toEqual([{ method: 'get', arg: { path: `"${EXE}"` } }]);
    const off = stubApp(false);
    expect(new WindowsLoginItem({ available: true, execPath: EXE, app: off.app }).status()).toEqual({ available: true, openAtLogin: false });
  });

  it('set(true) registers the named, enabled entry with the flag and returns the new status', () => {
    const { app, calls } = stubApp(false);
    const item = new WindowsLoginItem({ available: true, execPath: EXE, app });
    expect(item.set(true)).toEqual({ available: true, openAtLogin: true });
    expect(calls[0]).toEqual({
      method: 'set',
      arg: { openAtLogin: true, enabled: true, path: EXE, args: [START_HIDDEN_FLAG], name: LOGIN_ITEM_NAME },
    });
    expect(calls[1]?.method).toBe('get');
  });

  it('set(false) removes the same named entry', () => {
    const { app, calls } = stubApp(true);
    const item = new WindowsLoginItem({ available: true, execPath: EXE, app });
    expect(item.set(false)).toEqual({ available: true, openAtLogin: false });
    expect(calls[0]).toEqual({ method: 'set', arg: { openAtLogin: false, path: EXE, args: [START_HIDDEN_FLAG], name: LOGIN_ITEM_NAME } });
  });

  it('uses the value name the uninstaller deletes', () => {
    const nsh = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');
    expect(nsh).toContain(`"Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${LOGIN_ITEM_NAME}"`);
    expect(nsh).toContain(`"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${LOGIN_ITEM_NAME}"`);
  });
});

describe('MemoryLoginItem', () => {
  it('is available and remembers the last set', () => {
    const item = new MemoryLoginItem();
    expect(item.status()).toEqual({ available: true, openAtLogin: false });
    expect(item.set(true)).toEqual({ available: true, openAtLogin: true });
    expect(item.status()).toEqual({ available: true, openAtLogin: true });
    expect(item.set(false)).toEqual({ available: true, openAtLogin: false });
  });
});

describe('loginItemAvailable', () => {
  it('only for a packaged copy on the default data folder', () => {
    expect(loginItemAvailable({ isPackaged: true, dataDirSource: 'default' })).toBe(true);
    expect(loginItemAvailable({ isPackaged: false, dataDirSource: 'default' })).toBe(false);
    expect(loginItemAvailable({ isPackaged: true, dataDirSource: 'flag' })).toBe(false);
    expect(loginItemAvailable({ isPackaged: true, dataDirSource: 'env' })).toBe(false);
  });
});
