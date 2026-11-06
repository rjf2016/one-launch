import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { App } from 'electron';
import { LOGIN_ITEM_NAME, loginItemAvailable, MemoryLoginItem, START_HIDDEN_FLAG, WindowsLoginItem } from '../src/main/platform/login-item';
import { UNINSTALLER_NAME, type InstallInput } from '../src/main/updates/availability';

const EXE = 'C:\\Users\\someone\\AppData\\Local\\Programs\\One Launch\\OneLaunch.exe';

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
  it('when unavailable reports off without reading the registry, and refuses to write', async () => {
    const { app, calls } = stubApp(true);
    const item = new WindowsLoginItem({ available: async () => false, execPath: EXE, app });
    expect(await item.status()).toEqual({ available: false, openAtLogin: false });
    await expect(item.set(true)).rejects.toThrow(/not available/);
    expect(calls).toEqual([]);
  });

  it('reports what Windows will launch, asked for this exe with its path quoted (Electron parses it as a command line)', async () => {
    const on = stubApp(true);
    expect(await new WindowsLoginItem({ available: async () => true, execPath: EXE, app: on.app }).status()).toEqual({ available: true, openAtLogin: true });
    expect(on.calls).toEqual([{ method: 'get', arg: { path: `"${EXE}"` } }]);
    const off = stubApp(false);
    expect(await new WindowsLoginItem({ available: async () => true, execPath: EXE, app: off.app }).status()).toEqual({ available: true, openAtLogin: false });
  });

  it('set(true) registers the named, enabled entry with the flag and returns the new status', async () => {
    const { app, calls } = stubApp(false);
    const item = new WindowsLoginItem({ available: async () => true, execPath: EXE, app });
    expect(await item.set(true)).toEqual({ available: true, openAtLogin: true });
    expect(calls[0]).toEqual({
      method: 'set',
      arg: { openAtLogin: true, enabled: true, path: EXE, args: [START_HIDDEN_FLAG], name: LOGIN_ITEM_NAME },
    });
    expect(calls[1]?.method).toBe('get');
  });

  it('set(false) removes the same named entry', async () => {
    const { app, calls } = stubApp(true);
    const item = new WindowsLoginItem({ available: async () => true, execPath: EXE, app });
    expect(await item.set(false)).toEqual({ available: true, openAtLogin: false });
    expect(calls[0]).toEqual({ method: 'set', arg: { openAtLogin: false, path: EXE, args: [START_HIDDEN_FLAG], name: LOGIN_ITEM_NAME } });
  });

  it('a reinstall removes an entry for another exe or for an all-users install, and never writes one', () => {
    const nsh = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');
    const install = /!macro customInstall\r?\n([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? '';
    expect(install).toContain(`ReadRegStr $0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${LOGIN_ITEM_NAME}"`);
    expect(install).toContain('$installMode == "all"');
    expect(install).toContain(`$1 != '"$appExe"'`);
    expect(install).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${LOGIN_ITEM_NAME}"`);
    expect(nsh).not.toMatch(/WriteReg/);
  });

  it('uses the value name the uninstaller deletes', () => {
    const nsh = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');
    expect(nsh).toContain(`"Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${LOGIN_ITEM_NAME}"`);
    expect(nsh).toContain(`"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${LOGIN_ITEM_NAME}"`);
  });
});

describe('MemoryLoginItem', () => {
  it('is available and remembers the last set', async () => {
    const item = new MemoryLoginItem();
    expect(await item.status()).toEqual({ available: true, openAtLogin: false });
    expect(await item.set(true)).toEqual({ available: true, openAtLogin: true });
    expect(await item.status()).toEqual({ available: true, openAtLogin: true });
    expect(await item.set(false)).toEqual({ available: true, openAtLogin: false });
  });
});

describe('loginItemAvailable', () => {
  const DIR = 'C:\\Users\\someone\\AppData\\Local\\Programs\\One Launch';
  const input = (overrides: Partial<InstallInput> = {}): InstallInput => ({
    isPackaged: true,
    dataDirSource: 'default',
    execPath: EXE,
    fileExists: (p) => p === `${DIR}\\${UNINSTALLER_NAME}`,
    perUserInstallLocation: async () => DIR,
    ...overrides,
  });

  it('only for a per-user install on the default data folder', async () => {
    expect(await loginItemAvailable(input())).toBe(true);
    expect(await loginItemAvailable(input({ isPackaged: false }))).toBe(false);
    expect(await loginItemAvailable(input({ dataDirSource: 'flag' }))).toBe(false);
    expect(await loginItemAvailable(input({ dataDirSource: 'env' }))).toBe(false);
  });

  it('not for a copy no uninstaller will remove, nor for an all-users install whose uninstaller reaches only one account', async () => {
    expect(await loginItemAvailable(input({ execPath: 'D:\\repo\\dist\\win-unpacked\\OneLaunch.exe' }))).toBe(false);
    expect(await loginItemAvailable(input({ perUserInstallLocation: async () => null }))).toBe(false);
  });

  it('is worked out once per run', async () => {
    let asked = 0;
    const item = new WindowsLoginItem({
      available: async () => {
        asked++;
        return true;
      },
      execPath: EXE,
      app: stubApp().app,
    });
    await item.status();
    await item.set(true);
    await item.status();
    expect(asked).toBe(1);
  });
});
