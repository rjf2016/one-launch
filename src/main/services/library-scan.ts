import type { LauncherId, LibraryScanResult } from '@shared/models';
import { AdapterError, type LauncherService } from './launchers';
import type { LibraryService } from './library';
import type { Logger } from './logger';

export interface LibraryScanDeps {
  launchers: LauncherService;
  library: LibraryService;
  log: Logger;
}

/**
 * Re-reads every implemented launcher and syncs the games table. One launcher failing (or simply
 * not being installed) never stops the others: a missing launcher syncs as having no installed
 * games, and any other failure is reported on its entry and leaves that launcher's rows untouched.
 */
export async function scanLibrary(deps: LibraryScanDeps): Promise<LibraryScanResult[]> {
  const results: LibraryScanResult[] = [];
  try {
    for (const launcher of deps.launchers.implemented()) {
      results.push(await scanOne(deps, launcher));
    }
  } finally {
    deps.library.markScanned();
  }
  return results;
}

async function scanOne(deps: LibraryScanDeps, launcher: LauncherId): Promise<LibraryScanResult> {
  try {
    const games = await deps.launchers.installedGames(launcher);
    const result = deps.library.sync(launcher, games);
    deps.log.info('library rescanned', result);
    return { ...result, installed: true, error: null };
  } catch (err) {
    if (err instanceof AdapterError && err.code === 'NOT_INSTALLED') {
      const result = deps.library.sync(launcher, []);
      deps.log.info('launcher not installed; library scan skipped', { launcher, removed: result.removed });
      return { ...result, installed: false, error: null };
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('library scan failed for launcher', { launcher, error: err });
    return { launcher, added: 0, updated: 0, removed: 0, installed: true, error: message };
  }
}
