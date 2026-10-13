import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import electronUpdater, { type CancellationToken as CancellationTokenType, type NsisUpdater as NsisUpdaterType } from 'electron-updater';
import type { Logger } from '../services/logger';
import type { UpdateTestFeed } from './test-feed';
import type { UpdateEngine } from './update-service';

const { CancellationToken, NsisUpdater } = electronUpdater;

export const RELEASE_FEED = { provider: 'github', owner: 'rjf2016', repo: 'one-launch' } as const;

// electron-updater sends a per-install UUID (written to .updaterId) with every request; every copy sends this one instead.
export const SHARED_STAGING_ID = '00000000-0000-0000-0000-000000000000';

function sharedStagingId(updater: NsisUpdaterType): void {
  Object.defineProperty(updater, 'stagingUserIdPromise', { value: { value: Promise.resolve(SHARED_STAGING_ID) } });
}

function updaterLogger(log: Logger): { info(m?: unknown): void; warn(m?: unknown): void; error(m?: unknown): void; debug(m: string): void } {
  const text = (m: unknown): string => (typeof m === 'string' ? m : m instanceof Error ? m.message : String(m));
  // Its own error listener reports every failed check; the service logs those itself, so an offline PC never writes an ERROR line.
  return {
    debug: (m) => log.debug(text(m)),
    info: (m) => log.debug(text(m)),
    warn: (m) => log.warn(text(m)),
    error: (m) => log.warn(text(m)),
  };
}

class TestFeedUpdater extends NsisUpdater {
  private readonly testLog: Logger;

  constructor(cacheRoot: string, log: Logger) {
    super();
    this.testLog = log;
    Object.defineProperty(this.app, 'baseCachePath', { get: () => cacheRoot });
  }

  protected override doInstall(): boolean {
    this.testLog.info('update install (test feed, installer not run)');
    return true;
  }
}

export interface EngineOptions {
  log: Logger;
  dataDir: string;
  testFeed: UpdateTestFeed | null;
}

export function createUpdateEngine({ log, dataDir, testFeed }: EngineOptions): UpdateEngine {
  let updater: NsisUpdaterType;
  if (testFeed) {
    const configPath = join(dataDir, 'dev-app-update.yml');
    writeFileSync(configPath, `provider: generic\nurl: ${JSON.stringify(testFeed.url)}\nupdaterCacheDirName: update-cache\n`);
    updater = new TestFeedUpdater(dataDir, log);
    updater.updateConfigPath = configPath;
    updater.forceDevUpdateConfig = true;
    updater.disableDifferentialDownload = true;
  } else {
    updater = new NsisUpdater();
    updater.setFeedURL(RELEASE_FEED);
  }
  sharedStagingId(updater);
  updater.logger = updaterLogger(log);
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;

  return {
    async check() {
      const result = await updater.checkForUpdates();
      return result?.isUpdateAvailable ? result.updateInfo : null;
    },
    download(onProgress) {
      const token: CancellationTokenType = new CancellationToken();
      const progress = (p: { percent: number }): void => onProgress(p.percent);
      updater.on('download-progress', progress);
      const done = updater
        .downloadUpdate(token)
        .then((files) => files[0] ?? Promise.reject(new Error('the download produced no file')))
        .catch((err: unknown) => {
          if (token.cancelled) return null;
          throw err;
        })
        .finally(() => updater.off('download-progress', progress));
      return { done, cancel: () => token.cancel() };
    },
    install(relaunch) {
      return updater.install(true, relaunch);
    },
  };
}
