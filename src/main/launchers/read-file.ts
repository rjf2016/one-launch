import { readFileSync, statSync } from 'node:fs';
import { LauncherFileError } from './types';

/** Real launcher files are kilobytes. Parsing one of many megabytes would stall or exhaust the main process, so it is refused before it is read. */
export const MAX_LAUNCHER_FILE_BYTES = 4 * 1024 * 1024;
/** The VDF parser holds some thirty bytes per character while it works, so Steam's files get a tighter limit. */
export const MAX_VDF_BYTES = 1024 * 1024;

function tooLarge(path: string, size: number): LauncherFileError {
  return new LauncherFileError(path, `Too large to be a launcher file (${size} bytes)`);
}

export function readLauncherBytes(path: string, maxBytes = MAX_LAUNCHER_FILE_BYTES): Buffer {
  const { size } = statSync(path);
  if (size > maxBytes) throw tooLarge(path, size);
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes) throw tooLarge(path, bytes.length);
  return bytes;
}

export function readLauncherText(path: string, maxBytes = MAX_LAUNCHER_FILE_BYTES): string {
  return readLauncherBytes(path, maxBytes).toString('utf8');
}
