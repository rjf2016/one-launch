import { normalize, sep } from 'node:path';

/**
 * Normalize a path read from a launcher-owned file. Launchers are inconsistent:
 * Steam's registry value uses forward slashes, Epic manifests mix both in one string,
 * VDF files escape backslashes. Every adapter must pass external paths through here.
 */
export function normalizeLauncherPath(raw: string): string {
  let p = raw.trim();
  // VDF/JSON-escaped backslashes: "D:\\Games\\Steam" -> "D:\Games\Steam"
  p = p.replace(/\\\\/g, '\\');
  // Unify separators to the platform separator, collapse duplicates, resolve "." and "..".
  p = normalize(p.replace(/[\\/]+/g, sep));
  // Drop a trailing separator except for a bare drive root like "C:\".
  if (p.length > 3 && p.endsWith(sep)) p = p.slice(0, -1);
  return p;
}

/** What samePath compares: equal keys are the same Windows path. Lets a caller deduplicate with a Set instead of comparing every pair. */
export function pathKey(path: string): string {
  return normalizeLauncherPath(path).toLowerCase();
}

/** Case-insensitive, separator-insensitive equality for Windows paths. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}
