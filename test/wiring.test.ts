import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlatform, FAKE_LAUNCHERS_ENV, FakeLaunchersError, resolveFakeLaunchersDir } from '../src/main/platform/wiring';
import { createLogger } from '../src/main/services/logger';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'onelaunch-wiring-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveFakeLaunchersDir', () => {
  it('is null without the variable, and always null when packaged', () => {
    writeFileSync(join(root, 'scenario.json'), '{}');
    expect(resolveFakeLaunchersDir({}, false)).toBeNull();
    expect(resolveFakeLaunchersDir({ [FAKE_LAUNCHERS_ENV]: root }, true)).toBeNull();
  });

  it('returns the normalized folder when it holds a scenario', () => {
    writeFileSync(join(root, 'scenario.json'), '{}');
    expect(resolveFakeLaunchersDir({ [FAKE_LAUNCHERS_ENV]: `${root}\\` }, false)).toBe(root);
  });

  it('refuses a relative path, a missing folder, and a folder without scenario.json', () => {
    expect(() => resolveFakeLaunchersDir({ [FAKE_LAUNCHERS_ENV]: 'scratch\\launchers' }, false)).toThrow(FakeLaunchersError);
    expect(() => resolveFakeLaunchersDir({ [FAKE_LAUNCHERS_ENV]: join(root, 'missing') }, false)).toThrow(FakeLaunchersError);
    mkdirSync(join(root, 'empty'));
    expect(() => resolveFakeLaunchersDir({ [FAKE_LAUNCHERS_ENV]: join(root, 'empty') }, false)).toThrow(/scenario\.json/);
  });
});

describe('createPlatform', () => {
  const log = createLogger('test:wiring');
  const openExternal = async (): Promise<void> => undefined;
  const askedWith: unknown[] = [];
  const loginItem = {
    available: async (registry: unknown) => {
      askedWith.push(registry);
      return false;
    },
    execPath: 'C:\\x\\OneLaunch.exe',
    app: {
      getLoginItemSettings: () => {
        throw new Error('the registry is not read in tests');
      },
      setLoginItemSettings: () => {
        throw new Error('the registry is not written in tests');
      },
    },
  };

  it('without a fake folder is the real platform with no path overrides', async () => {
    const platform = await createPlatform({ fakeDir: null, dataDir: root, log, openExternal, loginItem });
    expect(platform.source).toBe('real');
    expect(platform.roots).toEqual({ steam: {}, epic: {}, battlenet: {}, riot: {} });
    expect(platform.quitDuringSwitch).toBeUndefined();
    expect(await platform.loginItem.status()).toEqual({ available: false, openAtLogin: false });
    expect(askedWith).toEqual([platform.registry]);
  });

  it('with a fake folder roots every path inside it and lets knobs.json answer the quit prompt', async () => {
    const fakeDir = join(root, 'launchers');
    const dataDir = join(root, 'data');
    mkdirSync(fakeDir);
    mkdirSync(dataDir);
    writeFileSync(join(fakeDir, 'scenario.json'), JSON.stringify({ version: 1, installed: [], quitDuringSwitch: 'keep' }));
    const plain = await createPlatform({ fakeDir, dataDir, log, openExternal, loginItem });
    expect(plain.source).toBe('fake');
    expect(plain.quitDuringSwitch).toBe('keep');
    expect(await plain.loginItem.set(true)).toEqual({ available: true, openAtLogin: true });
    for (const roots of Object.values(plain.roots)) {
      for (const path of Object.values(roots)) expect(path.toLowerCase().startsWith(fakeDir.toLowerCase()), path).toBe(true);
    }

    writeFileSync(join(fakeDir, 'knobs.json'), JSON.stringify({ quitDuringSwitch: 'quit' }));
    expect((await createPlatform({ fakeDir, dataDir, log, openExternal, loginItem })).quitDuringSwitch).toBe('quit');
  });
});
