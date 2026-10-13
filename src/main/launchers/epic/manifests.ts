/**
 * Epic Games Launcher library files (findings in docs/adapters/epic.md):
 * <AppDataPath>\Manifests\<InstallationGuid>.item, one JSON file per installed app, and
 * C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat as a cross-check.
 */

import { normalizeLauncherPath } from '../../platform/fs-path';

export class EpicManifestError extends Error {
  readonly code = 'MANIFEST_FORMAT';
  constructor(message: string) {
    super(message);
    this.name = 'EpicManifestError';
  }
}

export const ITEM_FILE = /^[0-9A-Fa-f]{32}\.item$/;

export interface EpicItemManifest {
  installationGuid: string;
  /** Epic's stable app identifier, e.g. "Sugar" for Rocket League. The library's launcher_game_id. */
  appName: string;
  displayName: string;
  catalogNamespace: string | null;
  catalogItemId: string | null;
  /** Normalized absolute install folder. The file mixes separators. */
  installLocation: string;
  /** Relative to installLocation, normalized. */
  launchExecutable: string | null;
  installSize: number | null;
  incomplete: boolean;
  /** For DLC and add-ons: the app they belong to. Equal to appName (or null) for a game itself. */
  mainGameAppName: string | null;
  categories: string[];
}

function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Parses one .item file. Session ids, hashes, and CDN URLs are deliberately not surfaced. */
export function parseItemManifest(text: string): EpicItemManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new EpicManifestError(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EpicManifestError('not a JSON object');
  const o = raw as Record<string, unknown>;
  const appName = str(o, 'AppName');
  if (!appName) throw new EpicManifestError('manifest has no AppName');
  const installLocation = str(o, 'InstallLocation');
  if (!installLocation) throw new EpicManifestError(`manifest for ${appName} has no InstallLocation`);
  const launchExecutable = str(o, 'LaunchExecutable');
  const categories = Array.isArray(o['AppCategories']) ? o['AppCategories'].filter((c): c is string => typeof c === 'string') : [];
  return {
    installationGuid: str(o, 'InstallationGuid') ?? '',
    appName,
    displayName: str(o, 'DisplayName') ?? appName,
    catalogNamespace: str(o, 'CatalogNamespace'),
    catalogItemId: str(o, 'CatalogItemId'),
    installLocation: normalizeLauncherPath(installLocation),
    launchExecutable: launchExecutable ? normalizeLauncherPath(launchExecutable) : null,
    installSize: num(o, 'InstallSize'),
    incomplete: o['bIsIncompleteInstall'] === true,
    mainGameAppName: str(o, 'MainGameAppName'),
    categories,
  };
}

/**
 * A manifest that should show up in the library: fully installed, a game (or uncategorized), and
 * not a DLC/add-on that points at another app. Unreal Engine installs carry the "engines" category.
 */
export function isLibraryGame(m: EpicItemManifest): boolean {
  if (m.incomplete) return false;
  if (m.mainGameAppName && m.mainGameAppName !== m.appName) return false;
  if (m.categories.length > 0 && !m.categories.includes('games')) return false;
  return true;
}

export interface LauncherInstalledEntry {
  appName: string;
  installLocation: string;
  namespaceId: string | null;
  itemId: string | null;
}

/** LauncherInstalled.dat: { "InstallationList": [ { InstallLocation, NamespaceId, ItemId, ArtifactId, AppVersion, AppName } ] }. */
export function parseLauncherInstalled(text: string): LauncherInstalledEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new EpicManifestError(`LauncherInstalled.dat is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const list = raw && typeof raw === 'object' ? (raw as { InstallationList?: unknown }).InstallationList : undefined;
  if (!Array.isArray(list)) throw new EpicManifestError('LauncherInstalled.dat has no InstallationList');
  const out: LauncherInstalledEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const appName = str(o, 'AppName') ?? str(o, 'ArtifactId');
    const location = str(o, 'InstallLocation');
    if (!appName || !location) continue;
    out.push({ appName, installLocation: normalizeLauncherPath(location), namespaceId: str(o, 'NamespaceId'), itemId: str(o, 'ItemId') });
  }
  return out;
}

/**
 * The launch URI. 'catalog' is what the launcher writes into its own desktop shortcuts
 * (com.epicgames.launcher://apps/<ns>%3A<item>%3A<AppName>?action=launch&silent=true); 'appname'
 * is the older form. Falls back to 'appname' when the catalog ids are unknown.
 */
export function launchUri(m: Pick<EpicItemManifest, 'appName' | 'catalogNamespace' | 'catalogItemId'>, form: 'catalog' | 'appname'): string {
  const id =
    form === 'catalog' && m.catalogNamespace && m.catalogItemId
      ? `${m.catalogNamespace}%3A${m.catalogItemId}%3A${encodeURIComponent(m.appName)}`
      : encodeURIComponent(m.appName);
  return `com.epicgames.launcher://apps/${id}?action=launch&silent=true`;
}
