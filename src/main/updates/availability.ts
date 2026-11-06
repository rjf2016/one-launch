import { dirname, join } from 'node:path';
import type { UpdateUnavailableReason } from '@shared/models';
import { samePath } from '../platform/fs-path';
import type { DataDirSource } from '../platform/paths';

// electron-builder names the installer's registry key UUIDv5(appId, its own namespace); test/update-availability.test.ts recomputes it from electron-builder.yml.
export const INSTALLER_GUID = '37275e3e-77ba-54aa-bc32-31551d28dc0d';
export const INSTALL_REGISTRY_KEY = `Software\\${INSTALLER_GUID}`;
export const UNINSTALLER_NAME = 'Uninstall OneLaunch.exe';

export type UpdateAvailability = { ok: true } | { ok: false; reason: UpdateUnavailableReason };

export interface InstallInput {
  isPackaged: boolean;
  dataDirSource: DataDirSource;
  execPath: string;
  fileExists: (path: string) => boolean;
  perUserInstallLocation: () => Promise<string | null>;
}

export interface AvailabilityInput extends InstallInput {
  testFeed: boolean;
}

export async function updateAvailability(input: AvailabilityInput): Promise<UpdateAvailability> {
  if (input.testFeed) return { ok: true };
  return perUserInstall(input);
}

/** Whether this is a per-user install's exe running on the default data folder. */
export async function perUserInstall(input: InstallInput): Promise<UpdateAvailability> {
  if (!input.isPackaged) return { ok: false, reason: 'development' };
  if (input.dataDirSource !== 'default') return { ok: false, reason: 'custom-data-folder' };
  const exeDir = dirname(input.execPath);
  if (!input.fileExists(join(exeDir, UNINSTALLER_NAME))) return { ok: false, reason: 'not-installed' };
  const location = await input.perUserInstallLocation().catch(() => null);
  if (!location || !samePath(location, exeDir)) return { ok: false, reason: 'all-users-install' };
  return { ok: true };
}
