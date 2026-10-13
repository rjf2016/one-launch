/**
 * Steam library files: <SteamPath>\steamapps\libraryfolders.vdf lists every library folder, and
 * each library's steamapps\appmanifest_<appid>.acf describes one installed app.
 */

import { normalizeLauncherPath, pathKey } from '../../platform/fs-path';
import { parseVdf, vdfInt, vdfObject, vdfString } from './vdf';

export class ManifestFormatError extends Error {
  readonly code = 'MANIFEST_FORMAT';
  constructor(message: string) {
    super(message);
    this.name = 'ManifestFormatError';
  }
}

/**
 * Library folder paths in file order, normalized and deduplicated. Accepts both the current format
 * ("0" { "path" "D:\\Games\\Steam" ... }) and the pre-2021 one ("1" "D:\\Games\\Steam").
 */
export function parseLibraryFolders(text: string): string[] {
  const root = parseVdf(text);
  const block = vdfObject(root, 'libraryfolders');
  if (!block) throw new ManifestFormatError('libraryfolders.vdf has no "libraryfolders" block');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(block)) {
    if (!/^\d+$/.test(key)) continue;
    const raw = typeof value === 'string' ? value : vdfString(value, 'path');
    if (!raw || !raw.trim()) continue;
    const p = normalizeLauncherPath(raw);
    if (seen.has(pathKey(p))) continue;
    seen.add(pathKey(p));
    out.push(p);
  }
  return out;
}

/** StateFlags bits (Steam's EAppState). Observed 6 = installed + update required on the user's machine. */
export const STEAM_STATE_UPDATE_REQUIRED = 2;
export const STEAM_STATE_FULLY_INSTALLED = 4;

export interface SteamAppManifest {
  appId: string;
  name: string;
  /** Folder name under steamapps\common. */
  installDir: string;
  stateFlags: number;
  /** Unix seconds, or null when never played / absent. */
  lastPlayed: number | null;
  sizeOnDisk: number | null;
  buildId: string | null;
}

/**
 * Parses one appmanifest_<appid>.acf. LastOwner (a SteamID64) is deliberately not surfaced:
 * the library has no business knowing who bought a game, and it must never reach the logs.
 */
export function parseAppManifest(text: string): SteamAppManifest {
  const root = parseVdf(text);
  const state = vdfObject(root, 'AppState');
  if (!state) throw new ManifestFormatError('appmanifest has no "AppState" block');
  const appId = vdfString(state, 'appid')?.trim();
  if (!appId || !/^\d+$/.test(appId)) throw new ManifestFormatError('appmanifest has no numeric appid');
  const installDir = vdfString(state, 'installdir')?.trim();
  if (!installDir) throw new ManifestFormatError(`appmanifest ${appId} has no installdir`);
  const lastPlayed = vdfInt(state, 'LastPlayed');
  return {
    appId,
    name: vdfString(state, 'name')?.trim() || `App ${appId}`,
    installDir,
    stateFlags: vdfInt(state, 'StateFlags') ?? 0,
    lastPlayed: lastPlayed && lastPlayed > 0 ? lastPlayed : null,
    sizeOnDisk: vdfInt(state, 'SizeOnDisk'),
    buildId: vdfString(state, 'buildid')?.trim() ?? null,
  };
}

export function isFullyInstalled(stateFlags: number): boolean {
  return (stateFlags & STEAM_STATE_FULLY_INSTALLED) === STEAM_STATE_FULLY_INSTALLED;
}

export function needsUpdate(stateFlags: number): boolean {
  return (stateFlags & STEAM_STATE_UPDATE_REQUIRED) === STEAM_STATE_UPDATE_REQUIRED;
}

export const APP_MANIFEST_FILE = /^appmanifest_(\d+)\.acf$/i;
