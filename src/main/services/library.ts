import { randomUUID } from 'node:crypto';
import { isLauncherId, type ArtworkSource, type Game, type InstalledGame, type LauncherId } from '@shared/models';
import type { Db } from '../db';
import { artworkUrl } from './artwork-url';

interface GameRow {
  id: string;
  launcher: string;
  launcher_game_id: string;
  name: string;
  install_path: string | null;
  installed: number;
  last_seen_at: string;
  needs_update: number;
  last_played_at: string | null;
  art_source: string | null;
  grid_path: string | null;
  hero_path: string | null;
  logo_path: string | null;
  fetched_at: string | null;
  artwork_error: string | null;
  ll_account_id: string | null;
  ll_account_name: string | null;
  ll_launched_at: string | null;
}

export class GameNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(id: string) {
    super(`Game ${id} does not exist`);
    this.name = 'GameNotFoundError';
  }
}

function isArtworkSource(value: unknown): value is ArtworkSource {
  return value === 'steamgriddb' || value === 'steamcdn' || value === 'manual' || value === 'launcher';
}

function toGame(row: GameRow): Game | null {
  if (!isLauncherId(row.launcher)) return null;
  const url = (rel: string | null): string | null => (rel ? artworkUrl(rel, row.fetched_at) : null);
  return {
    id: row.id,
    launcher: row.launcher,
    launcherGameId: row.launcher_game_id,
    name: row.name,
    installPath: row.install_path,
    installed: row.installed === 1,
    lastSeenAt: row.last_seen_at,
    needsUpdate: row.needs_update === 1,
    lastPlayedAt: row.last_played_at,
    artwork: isArtworkSource(row.art_source)
      ? { source: row.art_source, grid: url(row.grid_path), hero: url(row.hero_path), logo: url(row.logo_path), fetchedAt: row.fetched_at }
      : null,
    artworkError: row.artwork_error,
    lastLaunch:
      row.ll_account_id && row.ll_launched_at ? { accountId: row.ll_account_id, accountName: row.ll_account_name, launchedAt: row.ll_launched_at } : null,
  };
}

export interface SyncResult {
  launcher: LauncherId;
  added: number;
  updated: number;
  removed: number;
}

const SELECT = `
  SELECT g.id, g.launcher, g.launcher_game_id, g.name, g.install_path, g.installed, g.last_seen_at,
         g.needs_update, g.last_played_at,
         a.source AS art_source, a.grid_path, a.hero_path, a.logo_path, a.fetched_at,
         att.error AS artwork_error,
         ll.account_id AS ll_account_id, acc.display_name AS ll_account_name, ll.launched_at AS ll_launched_at
  FROM games g
  LEFT JOIN artwork a ON a.game_id = g.id
  LEFT JOIN artwork_attempts att ON att.game_id = g.id
  LEFT JOIN (
    SELECT game_id, account_id, MAX(launched_at) AS launched_at
    FROM launch_history WHERE result = 'ok' GROUP BY game_id
  ) ll ON ll.game_id = g.id
  LEFT JOIN accounts acc ON acc.id = ll.account_id`;

/**
 * The games table joined with artwork and the last successful launch. `revision` moves on every
 * change so the renderer can poll for background work (scans, artwork) without a push channel.
 */
export class LibraryService {
  private readonly listStmt;
  private readonly getStmt;
  private readonly byLauncherStmt;
  private readonly upsertStmt;
  private readonly markMissingStmt;
  private readonly syncTx;
  private rev = 0;
  private hasScanned = false;

  constructor(private readonly db: Db) {
    this.listStmt = db.prepare<[], GameRow>(`${SELECT} WHERE g.installed = 1 ORDER BY g.name COLLATE NOCASE`);
    this.getStmt = db.prepare<[string], GameRow>(`${SELECT} WHERE g.id = ?`);
    this.byLauncherStmt = db.prepare<[string], { id: string; launcher_game_id: string }>('SELECT id, launcher_game_id FROM games WHERE launcher = ?');
    this.upsertStmt = db.prepare<[string, string, string, string, string | null, string, number, string | null]>(
      `INSERT INTO games (id, launcher, launcher_game_id, name, install_path, installed, last_seen_at, needs_update, last_played_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (launcher, launcher_game_id) DO UPDATE
         SET name = excluded.name, install_path = excluded.install_path, installed = 1, last_seen_at = excluded.last_seen_at,
             needs_update = excluded.needs_update, last_played_at = excluded.last_played_at`,
    );
    this.markMissingStmt = db.prepare<[string]>('UPDATE games SET installed = 0 WHERE id = ? AND installed = 1');
    this.syncTx = this.db.transaction((launcher: LauncherId, games: readonly InstalledGame[]): SyncResult => {
      const before = new Map(this.byLauncherStmt.all(launcher).map((r) => [r.launcher_game_id, r]));
      const now = new Date().toISOString();
      let added = 0;
      let updated = 0;
      for (const g of games) {
        const existing = before.get(g.launcherGameId);
        this.upsertStmt.run(existing?.id ?? randomUUID(), launcher, g.launcherGameId, g.name, g.installPath, now, g.needsUpdate ? 1 : 0, g.lastPlayedAt);
        if (existing) updated++;
        else added++;
      }
      const seen = new Set(games.map((g) => g.launcherGameId));
      let removed = 0;
      for (const row of before.values()) {
        if (!seen.has(row.launcher_game_id)) removed += this.markMissingStmt.run(row.id).changes;
      }
      return { launcher, added, updated, removed };
    });
  }

  get revision(): number {
    return this.rev;
  }

  /** Call after any change to games, artwork, or artwork_attempts made outside sync(). */
  bump(): void {
    this.rev++;
  }

  /** A scan has finished since the app started (see ArtworkStatus.scanned). */
  get scanned(): boolean {
    return this.hasScanned;
  }

  markScanned(): void {
    this.hasScanned = true;
  }

  list(): Game[] {
    return this.listStmt
      .all()
      .map(toGame)
      .filter((g): g is Game => g !== null);
  }

  get(id: string): Game | null {
    const row = this.getStmt.get(id);
    return row ? toGame(row) : null;
  }

  require(id: string): Game {
    const game = this.get(id);
    if (!game) throw new GameNotFoundError(id);
    return game;
  }

  /**
   * Replaces the launcher's installed set with what the adapter just found. Rows keep their ids
   * across scans so launch history and artwork stay attached; games that vanished are marked
   * uninstalled rather than deleted.
   */
  sync(launcher: LauncherId, games: readonly InstalledGame[]): SyncResult {
    const result = this.syncTx(launcher, games);
    this.rev++;
    return result;
  }
}
