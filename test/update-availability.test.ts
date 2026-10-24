import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { UUID } from 'builder-util-runtime';
import { describe, expect, it } from 'vitest';
import { INSTALLER_GUID, UNINSTALLER_NAME, updateAvailability, type AvailabilityInput } from '../src/main/updates/availability';
import { keyIdOf, publicKeyOf } from '../src/main/updates/manifest';
import { resolveUpdateTestFeed, UpdateTestFeedError } from '../src/main/updates/test-feed';

const EXE = 'C:\\Users\\player\\AppData\\Local\\Programs\\OneLaunch\\OneLaunch.exe';
const DIR = 'C:\\Users\\player\\AppData\\Local\\Programs\\OneLaunch';

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    testFeed: false,
    isPackaged: true,
    dataDirSource: 'default',
    execPath: EXE,
    fileExists: (p) => p === `${DIR}\\${UNINSTALLER_NAME}`,
    perUserInstallLocation: async () => DIR,
    ...overrides,
  };
}

describe('which copies may update themselves', () => {
  it('names the key electron-builder writes for this app id', () => {
    const appId = /^appId:\s*(\S+)\s*$/m.exec(readFileSync('electron-builder.yml', 'utf8'))?.[1];
    expect(appId).toBe('dev.onelaunch.app');
    expect(UUID.v5(appId!, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))).toBe(INSTALLER_GUID);
  });

  it('names the uninstaller after the executable name electron-builder is configured with', () => {
    const executableName = /^executableName:\s*(\S+)\s*$/m.exec(readFileSync('electron-builder.yml', 'utf8'))?.[1];
    expect(executableName).toBe('OneLaunch');
    expect(UNINSTALLER_NAME).toBe(`Uninstall ${executableName}.exe`);
  });

  it('allows an installed, per-user copy on the default data folder', async () => {
    expect(await updateAvailability(input())).toEqual({ ok: true });
    expect(await updateAvailability(input({ perUserInstallLocation: async () => `${DIR.toUpperCase()}\\` }))).toEqual({ ok: true });
  });

  it('refuses development runs, scratch data folders and loose copies of the exe', async () => {
    expect(await updateAvailability(input({ isPackaged: false }))).toEqual({ ok: false, reason: 'development' });
    expect(await updateAvailability(input({ dataDirSource: 'flag' }))).toEqual({ ok: false, reason: 'custom-data-folder' });
    expect(await updateAvailability(input({ execPath: 'D:\\repo\\dist\\win-unpacked\\OneLaunch.exe' }))).toEqual({ ok: false, reason: 'not-installed' });
  });

  it('refuses an install made for all users, whose update would need administrator rights', async () => {
    expect(await updateAvailability(input({ perUserInstallLocation: async () => null }))).toEqual({ ok: false, reason: 'all-users-install' });
    expect(await updateAvailability(input({ perUserInstallLocation: async () => 'D:\\Elsewhere' }))).toEqual({ ok: false, reason: 'all-users-install' });
    expect(await updateAvailability(input({ perUserInstallLocation: () => Promise.reject(new Error('reg.exe failed')) }))).toEqual({
      ok: false,
      reason: 'all-users-install',
    });
  });

  it('lets an unpackaged test-feed run through without looking at the install', async () => {
    expect(await updateAvailability(input({ testFeed: true, isPackaged: false, dataDirSource: 'flag', fileExists: () => false }))).toEqual({ ok: true });
  });
});

describe('the test feed', () => {
  const spki = publicKeyOf(generateKeyPairSync('ed25519').privateKey);

  it('is ignored by the packaged exe, whatever the environment says', () => {
    expect(resolveUpdateTestFeed({ ONELAUNCH_UPDATE_FEED: 'http://127.0.0.1:9/', ONELAUNCH_UPDATE_KEYS: spki }, true)).toBeNull();
  });

  it('reads a loopback feed and its keys when unpackaged', () => {
    expect(resolveUpdateTestFeed({}, false)).toBeNull();
    expect(resolveUpdateTestFeed({ ONELAUNCH_UPDATE_FEED: 'http://127.0.0.1:4100', ONELAUNCH_UPDATE_KEYS: ` ${spki} ` }, false)).toEqual({
      url: 'http://127.0.0.1:4100/',
      keys: [{ id: keyIdOf(spki), spki }],
    });
  });

  it('refuses anything but a loopback http address and Ed25519 keys', () => {
    for (const url of ['https://github.com/', 'http://localhost:4100/', 'http://10.0.0.1/', 'not a url']) {
      expect(() => resolveUpdateTestFeed({ ONELAUNCH_UPDATE_FEED: url }, false), url).toThrow(UpdateTestFeedError);
    }
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(() => resolveUpdateTestFeed({ ONELAUNCH_UPDATE_FEED: 'http://127.0.0.1:1/', ONELAUNCH_UPDATE_KEYS: rsa }, false)).toThrow(UpdateTestFeedError);
    expect(() => resolveUpdateTestFeed({ ONELAUNCH_UPDATE_FEED: 'http://127.0.0.1:1/', ONELAUNCH_UPDATE_KEYS: 'garbage' }, false)).toThrow(UpdateTestFeedError);
  });
});
