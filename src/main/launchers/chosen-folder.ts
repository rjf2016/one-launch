import { basename } from 'node:path';
import type { HealthCheck, LauncherInstall } from '@shared/models';
import { normalizeLauncherPath } from '../platform/fs-path';

/** The folder from the `<launcher>.path` setting, normalized, or null when none is set. */
export function chosenFolder(read: (() => string | null) | undefined): string | null {
  const raw = read?.();
  return raw && raw.trim() ? normalizeLauncherPath(raw) : null;
}

/** Whether `exePath` is a file with one of these names (Windows file names do not distinguish case). */
export function isNamed(exePath: string, names: readonly string[]): boolean {
  const name = basename(exePath).toLowerCase();
  return names.some((n) => n.toLowerCase() === name);
}

/** A warning for a chosen folder the launcher is no longer in; null while the choice is in use or none was made. */
export function chosenFolderCheck(chosen: string | null, install: LauncherInstall | null, exeName: string): HealthCheck | null {
  if (!chosen || install?.source === 'user') return null;
  return {
    id: 'chosen-folder',
    label: 'Chosen folder',
    status: 'warn',
    detail: `${exeName} is no longer in ${chosen}, the folder chosen in Settings, so ${
      install ? 'the installation found automatically is used' : 'nothing is used'
    }. Use Locate to choose it again, or Reset to go back to automatic detection.`,
  };
}
