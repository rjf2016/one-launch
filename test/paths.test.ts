import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { isPackaged: false, paths: new Map<string, string>() };
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getPath: (name: string) => state.paths.get(name) ?? '',
    setPath: (name: string, value: string) => void state.paths.set(name, value),
  },
}));

const { configureAppPaths, dataDirFromArgv, DataDirFlagError, ensureAppDirs, getAppPaths } = await import('../src/main/platform/paths');

const ROAMING = 'C:\\Users\\someone\\AppData\\Roaming';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env['ONELAUNCH_DATA_DIR'];
  delete process.env['ONELAUNCH_DATA_DIR'];
  state.isPackaged = false;
  state.paths = new Map([['appData', ROAMING]]);
});

afterEach(() => {
  if (saved === undefined) delete process.env['ONELAUNCH_DATA_DIR'];
  else process.env['ONELAUNCH_DATA_DIR'] = saved;
});

describe('app paths (B19)', () => {
  it('puts the data under %APPDATA%\\OneLaunch and keeps Chromium in its own subfolder', () => {
    configureAppPaths();
    expect(state.paths.get('userData')).toBe(join(ROAMING, 'OneLaunch'));
    expect(state.paths.get('sessionData')).toBe(join(ROAMING, 'OneLaunch', 'chromium'));
    expect(getAppPaths()).toEqual({
      dataDir: join(ROAMING, 'OneLaunch'),
      dbPath: join(ROAMING, 'OneLaunch', 'onelaunch.db'),
      artworkDir: join(ROAMING, 'OneLaunch', 'artwork'),
      backupsDir: join(ROAMING, 'OneLaunch', 'backups'),
      logsDir: join(ROAMING, 'OneLaunch', 'logs'),
      journalPath: join(ROAMING, 'OneLaunch', 'switch.json'),
    });
  });

  it('honours ONELAUNCH_DATA_DIR only in an unpackaged run, and ignores a blank one', () => {
    process.env['ONELAUNCH_DATA_DIR'] = '  D:\\scratch\\ol  ';
    configureAppPaths();
    expect(state.paths.get('userData')).toBe('D:\\scratch\\ol');
    expect(state.paths.get('sessionData')).toBe(join('D:\\scratch\\ol', 'chromium'));

    state.isPackaged = true;
    configureAppPaths();
    expect(state.paths.get('userData')).toBe(join(ROAMING, 'OneLaunch'));

    state.isPackaged = false;
    process.env['ONELAUNCH_DATA_DIR'] = '   ';
    configureAppPaths();
    expect(state.paths.get('userData')).toBe(join(ROAMING, 'OneLaunch'));
  });

  it('--data-dir= moves everything, packaged or not, and wins over the environment variable (A11)', () => {
    const exe = 'C:\\Program Files\\One Launch\\One Launch.exe';
    state.isPackaged = true;
    expect(configureAppPaths([exe, '--data-dir=D:\\scratch\\packaged'])).toBe('flag');
    expect(state.paths.get('userData')).toBe('D:\\scratch\\packaged');
    expect(state.paths.get('sessionData')).toBe(join('D:\\scratch\\packaged', 'chromium'));
    expect(getAppPaths().dbPath).toBe(join('D:\\scratch\\packaged', 'onelaunch.db'));

    state.isPackaged = false;
    process.env['ONELAUNCH_DATA_DIR'] = 'D:\\scratch\\env';
    expect(configureAppPaths(['electron.exe', '.', '--data-dir=D:\\scratch\\flag\\'])).toBe('flag');
    expect(state.paths.get('userData')).toBe('D:\\scratch\\flag');
    expect(configureAppPaths(['electron.exe', '.'])).toBe('env');
    expect(state.paths.get('userData')).toBe('D:\\scratch\\env');

    delete process.env['ONELAUNCH_DATA_DIR'];
    expect(configureAppPaths([exe])).toBe('default');
    expect(state.paths.get('userData')).toBe(join(ROAMING, 'OneLaunch'));
  });

  it('refuses a --data-dir= it cannot use instead of falling back to the real folder (A11)', () => {
    expect(dataDirFromArgv(['x.exe'])).toBeNull();
    expect(dataDirFromArgv(['x.exe', '--data-dir', 'D:\\scratch'])).toBeNull();
    expect(dataDirFromArgv(['x.exe', '--data-dir=D:/scratch/ol'])).toBe('D:\\scratch\\ol');
    expect(dataDirFromArgv(['x.exe', '--data-dir=D:\\a', '--data-dir=D:\\a'])).toBe('D:\\a');
    for (const bad of [
      '--data-dir=',
      '--data-dir=   ',
      '--data-dir=scratch',
      '--data-dir=.\\scratch',
      '--data-dir=D:',
      '--data-dir=D:\\',
      '--data-dir=\\\\server\\share\\',
    ]) {
      expect(() => dataDirFromArgv(['x.exe', bad]), bad).toThrow(DataDirFlagError);
    }
    expect(() => dataDirFromArgv(['x.exe', '--data-dir=D:\\a', '--data-dir=D:\\b'])).toThrow(DataDirFlagError);

    state.paths.delete('userData');
    expect(() => configureAppPaths(['x.exe', '--data-dir=scratch'])).toThrow(DataDirFlagError);
    expect(state.paths.has('userData')).toBe(false);
  });

  it('creates the data, artwork, backups, and logs folders, and is happy when they exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'onelaunch-paths-'));
    try {
      state.paths.set('userData', join(root, 'OneLaunch'));
      const paths = getAppPaths();
      ensureAppDirs(paths);
      ensureAppDirs(paths);
      for (const dir of [paths.dataDir, paths.artworkDir, paths.backupsDir, paths.logsDir]) expect(existsSync(dir)).toBe(true);
      expect(existsSync(paths.dbPath)).toBe(false);
      expect(existsSync(paths.journalPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
