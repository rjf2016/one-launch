import { resolve, sep } from 'node:path';
import type { ArtworkKind } from '@shared/models';

/**
 * The renderer loads cached artwork through this app-owned scheme. It is registered as a standard,
 * secure scheme so URLs parse as `onelaunch-art://art/<gameId>/<file>` and the CSP can name it.
 */
export const ARTWORK_SCHEME = 'onelaunch-art';
export const ARTWORK_HOST = 'art';

const GAME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME = /^(grid|hero|logo)\.(jpg|png|webp|ico)$/;

/** `ico` is only ever a launcher's own icon (a stand-in grid); downloads and manual picks are the other three. */
export type ArtworkExt = 'jpg' | 'png' | 'webp' | 'ico';

export function artworkFileName(kind: ArtworkKind, ext: ArtworkExt): string {
  return `${kind}.${ext}`;
}

/** Path relative to the artwork folder, always with forward slashes. */
export function artworkRelPath(gameId: string, kind: ArtworkKind, ext: ArtworkExt): string {
  return `${gameId}/${artworkFileName(kind, ext)}`;
}

/** URL the renderer can put in an <img>. `version` busts the renderer cache after a refresh. */
export function artworkUrl(relPath: string, version: string | null): string {
  const v = version ? `?v=${encodeURIComponent(version)}` : '';
  return `${ARTWORK_SCHEME}://${ARTWORK_HOST}/${relPath}${v}`;
}

/**
 * Maps a request URL to an absolute file under `artworkDir`, or null for anything that is not
 * exactly `<uuid>/<kind>.<ext>` inside that folder. Anything decoded, dotted, or absolute is refused.
 */
export function resolveArtworkPath(rawUrl: string, artworkDir: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${ARTWORK_SCHEME}:` || url.hostname !== ARTWORK_HOST) return null;
  const parts = url.pathname.split('/').filter((p) => p.length > 0);
  if (parts.length !== 2) return null;
  const [gameId, file] = parts as [string, string];
  if (!GAME_ID.test(gameId) || !FILE_NAME.test(file)) return null;
  const root = resolve(artworkDir);
  const full = resolve(root, gameId, file);
  if (!full.startsWith(root + sep)) return null;
  return full;
}

export const CONTENT_TYPE_BY_EXT: Readonly<Record<ArtworkExt, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  ico: 'image/x-icon',
};

/** A Windows icon file: the ICONDIR header (reserved 0, type 1) with at least one image. Chromium renders the largest frame in an <img>. */
export function sniffIcon(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  const u16 = (at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
  return u16(0) === 0 && u16(2) === 1 && u16(4) >= 1;
}

/** Sniffs JPEG, PNG, and WebP magic bytes. Anything else is not stored. */
export function sniffImage(bytes: Uint8Array): Exclude<ArtworkExt, 'ico'> | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}
