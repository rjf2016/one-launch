import { mkdirSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { app } from 'electron';

/** Directory name under %APPDATA%. Spec section 5: all app data lives in %APPDATA%\OneLaunch\. */
export const APP_DIR_NAME = 'OneLaunch';

/** `--data-dir=<absolute folder>`: keeps every file of this run in that folder. Works in a packaged build, which the environment variable does not. */
export const DATA_DIR_FLAG = '--data-dir=';

export type DataDirSource = 'flag' | 'env' | 'default';

export class DataDirFlagError extends Error {}

export interface AppPaths {
  dataDir: string;
  dbPath: string;
  artworkDir: string;
  backupsDir: string;
  logsDir: string;
  /** The switch journal: present only while a switch runs, or after a run that ended during one. */
  journalPath: string;
}

/**
 * The folder `--data-dir=` names, or null without the flag. A flag that names nothing usable throws
 * instead of being ignored: a run that asked for a scratch folder must never end up in the real one.
 */
export function dataDirFromArgv(argv: readonly string[]): string | null {
  const values = argv.filter((a) => a.startsWith(DATA_DIR_FLAG)).map((a) => a.slice(DATA_DIR_FLAG.length).trim());
  if (values.length === 0) return null;
  if (new Set(values).size > 1) throw new DataDirFlagError(`${DATA_DIR_FLAG} was given more than once with different folders`);
  const value = values[0]!;
  if (!win32.isAbsolute(value)) throw new DataDirFlagError(`${DATA_DIR_FLAG} needs an absolute folder path, got "${value}"`);
  const folder = win32.normalize(value);
  if (win32.parse(folder).root === folder) throw new DataDirFlagError(`${DATA_DIR_FLAG} must name a folder, not the drive "${folder}"`);
  return folder.replace(/\\+$/, '');
}

/**
 * Point Electron's userData at %APPDATA%\OneLaunch instead of the default %APPDATA%\one-launch,
 * and keep Chromium's own profile clutter (caches, GPU state, local storage) in a subfolder so the
 * top level holds only what spec section 5 lists. Must run before the 'ready' event.
 */
export function configureAppPaths(argv: readonly string[] = process.argv): DataDirSource {
  const flagged = dataDirFromArgv(argv);
  // Development-only escape hatch so automated runs never touch the real %APPDATA%\OneLaunch.
  // Electron resolves appData through the Windows shell, so overriding %APPDATA% has no effect.
  const fromEnv = app.isPackaged ? '' : (process.env['ONELAUNCH_DATA_DIR'] ?? '').trim();
  const dataDir = flagged ?? (fromEnv || join(app.getPath('appData'), APP_DIR_NAME));
  app.setPath('userData', dataDir);
  app.setPath('sessionData', join(dataDir, 'chromium'));
  return flagged ? 'flag' : fromEnv ? 'env' : 'default';
}

export function getAppPaths(): AppPaths {
  const dataDir = app.getPath('userData');
  return {
    dataDir,
    dbPath: join(dataDir, 'onelaunch.db'),
    artworkDir: join(dataDir, 'artwork'),
    backupsDir: join(dataDir, 'backups'),
    logsDir: join(dataDir, 'logs'),
    journalPath: join(dataDir, 'switch.json'),
  };
}

export function ensureAppDirs(paths: AppPaths): void {
  for (const dir of [paths.dataDir, paths.artworkDir, paths.backupsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
