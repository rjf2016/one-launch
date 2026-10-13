import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import type { InstalledGame } from '@shared/models';
import type { ProcessInfo } from '../platform/processes';

const DRIVE_PATH = /^[a-z]:\\/i;

// Drive paths only: a relative folder would resolve against the app's own, and a launcher file must not send the app to a share it names.
async function resolvedFolder(folder: string): Promise<string | null> {
  if (!DRIVE_PATH.test(folder)) return null;
  try {
    return await realpath(folder);
  } catch {
    return null;
  }
}

/**
 * The installed game one of these processes runs out of, if any. A process path is where the image really is,
 * so each game folder is matched as the launcher records it and with junctions, links and subst drives followed.
 */
export async function gameWithRunningProcess(procs: readonly ProcessInfo[], games: readonly InstalledGame[]): Promise<InstalledGame | null> {
  const paths = procs.flatMap((p) => (p.path ? [p.path.toLowerCase()] : []));
  if (paths.length === 0) return null;
  const folders = await Promise.all(
    games.map(async (game) => {
      const resolved = await resolvedFolder(game.installPath);
      const prefixes = [game.installPath, ...(resolved ? [resolved] : [])].map((folder) => `${folder.toLowerCase()}${sep}`);
      return { game, prefixes };
    }),
  );
  for (const path of paths) {
    const hit = folders.find((f) => f.prefixes.some((prefix) => path.startsWith(prefix)));
    if (hit) return hit.game;
  }
  return null;
}
