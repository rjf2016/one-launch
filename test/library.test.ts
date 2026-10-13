import { describe, expect, it } from 'vitest';
import type { InstalledGame } from '../src/shared/models';
import { migrate, openDatabase } from '../src/main/db';
import { LibraryService } from '../src/main/services/library';

const game = (id: string, name: string, over: Partial<InstalledGame> = {}): InstalledGame => ({
  launcher: 'steam',
  launcherGameId: id,
  name,
  installPath: `D:\\Games\\${id}`,
  libraryPath: 'D:\\Games',
  sizeOnDiskBytes: null,
  lastPlayedAt: null,
  needsUpdate: false,
  ...over,
});

describe('LibraryService.sync', () => {
  it('adds, updates in place, and marks vanished games uninstalled while keeping ids', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const lib = new LibraryService(db);

    expect(lib.sync('steam', [game('440', 'Team Fortress 2'), game('252950', 'Rocket League')])).toEqual({
      launcher: 'steam',
      added: 2,
      updated: 0,
      removed: 0,
    });
    const first = lib.list();
    expect(first.map((g) => g.name)).toEqual(['Rocket League', 'Team Fortress 2']);
    const rlId = first[0]!.id;

    expect(lib.sync('steam', [game('252950', 'Rocket League®', { installPath: 'E:\\rl' })])).toEqual({ launcher: 'steam', added: 0, updated: 1, removed: 1 });
    const second = lib.list();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ id: rlId, name: 'Rocket League®', installPath: 'E:\\rl', installed: true });
    expect(lib.get(first[1]!.id)).toMatchObject({ installed: false });

    // A game that comes back keeps its old id too.
    lib.sync('steam', [game('252950', 'Rocket League'), game('440', 'Team Fortress 2')]);
    expect(lib.list().find((g) => g.launcherGameId === '440')?.id).toBe(first[1]!.id);
  });

  it('stores needs_update and the launcher last-played time, and exposes artwork and last-launch joins', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const lib = new LibraryService(db);
    lib.sync('steam', [game('440', 'Team Fortress 2', { needsUpdate: true, lastPlayedAt: '2026-09-01T12:00:00.000Z' })]);
    let g = lib.list()[0]!;
    expect(g).toMatchObject({ needsUpdate: true, lastPlayedAt: '2026-09-01T12:00:00.000Z', artwork: null, artworkError: null, lastLaunch: null });

    db.prepare("INSERT INTO artwork (game_id, source, grid_path, hero_path, logo_path, fetched_at) VALUES (?, 'steamcdn', ?, NULL, NULL, ?)").run(
      g.id,
      `${g.id}/grid.jpg`,
      '2026-09-12T10:00:00.000Z',
    );
    db.prepare("INSERT INTO artwork_attempts (game_id, attempted_at, error) VALUES (?, ?, 'no hero')").run(g.id, '2026-09-12T10:00:00.000Z');
    const now = new Date().toISOString();
    db.prepare("INSERT INTO accounts (id, launcher, display_name, login, created_at, updated_at) VALUES ('a1', 'steam', 'Main', 'main', ?, ?)").run(now, now);
    db.prepare("INSERT INTO accounts (id, launcher, display_name, login, created_at, updated_at) VALUES ('a2', 'steam', 'Alt', 'alt', ?, ?)").run(now, now);
    const hist = db.prepare('INSERT INTO launch_history (id, game_id, account_id, launched_at, result) VALUES (?, ?, ?, ?, ?)');
    hist.run('h1', g.id, 'a1', '2026-09-10T00:00:00.000Z', 'ok');
    hist.run('h2', g.id, 'a2', '2026-09-11T00:00:00.000Z', 'ok');
    hist.run('h3', g.id, 'a1', '2026-09-12T00:00:00.000Z', 'failed');

    g = lib.get(g.id)!;
    expect(g.artwork).toEqual({
      source: 'steamcdn',
      grid: `onelaunch-art://art/${g.id}/grid.jpg?v=2026-09-12T10%3A00%3A00.000Z`,
      hero: null,
      logo: null,
      fetchedAt: '2026-09-12T10:00:00.000Z',
    });
    expect(g.artworkError).toBe('no hero');
    expect(g.lastLaunch).toEqual({ accountId: 'a2', accountName: 'Alt', launchedAt: '2026-09-11T00:00:00.000Z' });

    // A rescan keeps the row (and its artwork) and clears needs_update when the launcher says so.
    lib.sync('steam', [game('440', 'Team Fortress 2')]);
    const again = lib.get(g.id)!;
    expect(again.needsUpdate).toBe(false);
    expect(again.lastPlayedAt).toBeNull();
    expect(again.artwork?.grid).toBe(g.artwork?.grid);

    // Deleting a game cascades to artwork and attempts.
    db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM artwork').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM artwork_attempts').get()).toEqual({ n: 0 });
  });

  it('bumps the revision on sync and on bump()', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const lib = new LibraryService(db);
    expect(lib.revision).toBe(0);
    lib.sync('steam', []);
    expect(lib.revision).toBe(1);
    lib.bump();
    expect(lib.revision).toBe(2);
  });

  it('does not touch other launchers', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const lib = new LibraryService(db);
    lib.sync('steam', [game('440', 'Team Fortress 2')]);
    lib.sync('epic', [game('rl', 'Rocket League', { launcher: 'epic' })]);
    expect(lib.sync('steam', []).removed).toBe(1);
    expect(lib.list().map((g) => g.launcher)).toEqual(['epic']);
    expect(() => lib.require('nope')).toThrow(/does not exist/);
  });
});
