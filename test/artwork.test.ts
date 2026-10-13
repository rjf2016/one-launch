import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Game, InstalledGame } from '../src/shared/models';
import { migrate, openDatabase } from '../src/main/db';
import { solidIco } from '../src/main/launchers/sim/artwork-fetch';
import { ArtworkService, type FetchLike } from '../src/main/services/artwork';
import { sniffIcon } from '../src/main/services/artwork-url';
import { LibraryService } from '../src/main/services/library';
import { createLogger } from '../src/main/services/logger';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'steamgriddb');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const HTML = Buffer.from('<!doctype html><html><body>not found</body></html>');

const image = (bytes: Buffer, type = 'image/jpeg') =>
  new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } });
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response(HTML, { status: 404, headers: { 'content-type': 'text/html' } });

const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/252950';
const STEAM_CDN_ALT = 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/252950';
const SGDB = 'https://www.steamgriddb.com/api/v2';

interface Call {
  url: string;
  auth: string | null;
  redirect: string | null;
}

/** Routes by exact URL (minus nothing); unknown URLs are a 404 so a test cannot hit the network by accident. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, auth: init?.headers?.['Authorization'] ?? null, redirect: init?.redirect ?? null });
    const route = routes[url];
    return route ? route() : notFound();
  };
  return { fetch, calls };
}

const game = (over: Partial<InstalledGame> = {}): InstalledGame => ({
  launcher: 'steam',
  launcherGameId: '252950',
  name: 'Rocket League',
  installPath: 'D:\\Games\\rl',
  libraryPath: 'D:\\Games',
  sizeOnDiskBytes: null,
  lastPlayedAt: null,
  needsUpdate: false,
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(
  routes: Record<string, () => Response>,
  opts: {
    apiKey?: string | null;
    games?: InstalledGame[];
    retryAfterMs?: number;
    autoFetch?: () => boolean;
    launcherIcon?: (game: Game) => Promise<string | null>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'onelaunch-art-'));
  dirs.push(dir);
  const db = openDatabase(':memory:');
  migrate(db);
  const library = new LibraryService(db);
  const games = opts.games ?? [game()];
  for (const launcher of ['steam', 'epic', 'battlenet', 'riot'] as const) {
    const mine = games.filter((g) => g.launcher === launcher);
    if (mine.length || launcher === 'steam') library.sync(launcher, mine);
  }
  const { fetch, calls } = fakeFetch(routes);
  const artwork = new ArtworkService(db, {
    dir,
    fetch,
    apiKey: () => opts.apiKey ?? null,
    hasApiKey: () => (opts.apiKey ?? null) !== null,
    autoFetch: opts.autoFetch ?? (() => true),
    ...(opts.launcherIcon ? { launcherIcon: opts.launcherIcon } : {}),
    library,
    log: createLogger('test:artwork'),
    concurrency: 2,
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
  });
  return { dir, db, library, artwork, calls, gameId: library.list()[0]!.id };
}

describe('ArtworkService with the Steam CDN', () => {
  it('caches grid, hero, and logo from the CDN, validated and renamed into place', async () => {
    const { dir, library, artwork, calls, gameId } = setup({
      [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG),
      [`${STEAM_CDN}/library_hero.jpg`]: () => image(JPEG),
      [`${STEAM_CDN}/logo.png`]: () => image(PNG, 'image/png'),
    });
    const before = library.revision;
    expect(artwork.enqueueMissing()).toBe(1);
    expect(artwork.status()).toMatchObject({ queued: 0, running: 1, completed: 0 });
    await artwork.idle();

    const g = library.get(gameId)!;
    expect(g.artwork).toMatchObject({ source: 'steamcdn' });
    expect(g.artwork?.grid).toMatch(new RegExp(`^onelaunch-art://art/${gameId}/grid\\.jpg\\?v=`));
    expect(g.artwork?.hero).toContain('/hero.jpg');
    expect(g.artwork?.logo).toContain('/logo.png');
    expect(g.artworkError).toBeNull();
    expect(readdirSync(join(dir, gameId)).sort()).toEqual(['grid.jpg', 'hero.jpg', 'logo.png']);
    expect(readFileSync(join(dir, gameId, 'grid.jpg'))).toEqual(JPEG);
    expect(library.revision).toBeGreaterThan(before);
    expect(artwork.status()).toMatchObject({ queued: 0, running: 0, completed: 1, failed: 0 });
    for (const c of calls) expect(c.auth).toBeNull();
  });

  it('does not fetch again when cached, and enqueueMissing skips games that have a grid', async () => {
    const { artwork, calls } = setup({ [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG) });
    artwork.enqueueMissing();
    await artwork.idle();
    const n = calls.length;
    expect(artwork.enqueueMissing()).toBe(0);
    expect(artwork.refresh(null, false)).toBe(0);
    await artwork.idle();
    expect(calls.length).toBe(n);
  });

  it('rejects wrong content types, bad magic bytes, and oversized bodies', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024)]);
    const { library, artwork, gameId } = setup({
      [`${STEAM_CDN}/library_600x900.jpg`]: () => image(HTML, 'image/jpeg'),
      [`${STEAM_CDN}/library_hero.jpg`]: () => new Response(JPEG, { status: 200, headers: { 'content-type': 'text/html' } }),
      [`${STEAM_CDN}/logo.png`]: () => image(big, 'image/png'),
    });
    artwork.enqueueMissing();
    await artwork.idle();
    const g = library.get(gameId)!;
    expect(g.artwork).toBeNull();
    expect(g.artworkError).toMatch(/unrecognised image data/);
    expect(g.artworkError).toMatch(/not an image/);
    expect(g.artworkError).toMatch(/too large/);
    expect(artwork.status().failed).toBe(1);
  });

  it('records a miss and does not retry it on the next start until the window passes', async () => {
    const { db, artwork, library, gameId, calls } = setup({}, { retryAfterMs: 60_000 });
    artwork.enqueueMissing();
    await artwork.idle();
    expect(library.get(gameId)?.artworkError).toMatch(/No SteamGridDB API key/);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);

    expect(artwork.enqueueMissing()).toBe(0);
    expect(calls.length).toBe(first);

    expect(artwork.refresh(null, false)).toBe(1);
    await artwork.idle();
    expect(calls.length).toBeGreaterThan(first);

    db.prepare('UPDATE artwork_attempts SET attempted_at = ?').run(new Date(Date.now() - 120_000).toISOString());
    expect(artwork.enqueueMissing()).toBe(1);
    await artwork.idle();
  });

  it('tries the second CDN host after a 404 and stops on other errors', async () => {
    const { library, artwork, gameId, calls } = setup({
      [`${STEAM_CDN_ALT}/library_600x900.jpg`]: () => image(JPEG),
      [`${STEAM_CDN}/library_hero.jpg`]: () => new Response(null, { status: 500 }),
    });
    artwork.enqueueMissing();
    await artwork.idle();
    expect(library.get(gameId)?.artwork?.grid).toContain('/grid.jpg');
    expect(calls.filter((c) => c.url.endsWith('library_hero.jpg'))).toHaveLength(1);
  });
});

describe('ArtworkService with SteamGridDB', () => {
  it('falls back to SteamGridDB by Steam appid for what the CDN lacks, sending the key only to the API', async () => {
    const { library, artwork, gameId, calls } = setup(
      {
        [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG),
        [`${SGDB}/heroes/steam/252950?types=static&nsfw=false&humor=false`]: () => json(fixture('heroes-game-5267.json')),
        [`${SGDB}/logos/steam/252950?types=static&nsfw=false&humor=false`]: () => json(fixture('empty.json')),
        'https://cdn2.steamgriddb.com/hero/cccc3333.jpg': () => image(JPEG),
      },
      { apiKey: 'sgdb-test-key' },
    );
    artwork.enqueueMissing();
    await artwork.idle();
    const g = library.get(gameId)!;
    expect(g.artwork).toMatchObject({ source: 'steamcdn' });
    expect(g.artwork?.hero).toContain('/hero.jpg');
    expect(g.artwork?.logo).toBeNull();
    expect(g.artworkError).toBeNull();
    for (const c of calls) {
      if (c.url.startsWith(SGDB)) expect(c.auth).toBe('Bearer sgdb-test-key');
      else expect(c.auth).toBeNull();
    }
  });

  it('searches by name for non-Steam games and picks the top grid', async () => {
    const { library, artwork, calls } = setup(
      {
        [`${SGDB}/search/autocomplete/Rocket%20League`]: () => json(fixture('autocomplete-rocket-league.json')),
        [`${SGDB}/grids/game/5267?dimensions=600x900&types=static&nsfw=false&humor=false`]: () => json(fixture('grids-steam-252950.json')),
        [`${SGDB}/heroes/game/5267?types=static&nsfw=false&humor=false`]: () => json(fixture('heroes-game-5267.json')),
        [`${SGDB}/logos/game/5267?types=static&nsfw=false&humor=false`]: () => json(fixture('empty.json')),
        'https://cdn2.steamgriddb.com/grid/aaaa1111.png': () => image(PNG, 'image/png'),
        'https://cdn2.steamgriddb.com/hero/cccc3333.jpg': () => image(JPEG),
      },
      { apiKey: 'k', games: [game({ launcher: 'epic', launcherGameId: 'Kiwi', name: 'Rocket League' })] },
    );
    artwork.enqueueMissing();
    await artwork.idle();
    const g = library.list()[0]!;
    expect(g.launcher).toBe('epic');
    expect(g.artwork).toMatchObject({ source: 'steamgriddb' });
    expect(g.artwork?.grid).toContain('/grid.png');
    expect(g.artwork?.hero).toContain('/hero.jpg');
    expect(calls.some((c) => c.url.includes('steamstatic'))).toBe(false);
  });

  it('reports a rejected key without retrying every kind', async () => {
    const { library, artwork, gameId, calls } = setup(
      { [`${SGDB}/grids/steam/252950?dimensions=600x900&types=static&nsfw=false&humor=false`]: () => json(fixture('unauthorized.json'), 401) },
      { apiKey: 'bad' },
    );
    artwork.enqueueMissing();
    await artwork.idle();
    expect(library.get(gameId)?.artworkError).toMatch(/API key was rejected/);
    expect(calls.filter((c) => c.url.startsWith(SGDB))).toHaveLength(1);
  });
});

describe('ArtworkService keyless Steam lookups for other launchers', () => {
  const STORE_SEARCH = (term: string) => `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
  const COMMUNITY_SEARCH = (term: string) => `https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(term)}`;
  const storeHits = (items: { id: number; name: string; type?: string }[]) => json(JSON.stringify({ total: items.length, items }));

  it('resolves an Epic game to its Steam appid by exact name and uses the CDN with no key', async () => {
    const { library, artwork, calls } = setup(
      {
        [STORE_SEARCH('Rocket League')]: () =>
          storeHits([
            { id: 999, name: 'Rocket League Sideswipe Companion', type: 'app' },
            { id: 252950, name: 'Rocket League®', type: 'app' },
          ]),
        [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG),
        [`${STEAM_CDN}/library_hero.jpg`]: () => image(JPEG),
        [`${STEAM_CDN}/logo.png`]: () => image(PNG, 'image/png'),
      },
      { games: [game({ launcher: 'epic', launcherGameId: 'Sugar', name: 'Rocket League®' })] },
    );
    artwork.enqueueMissing();
    await artwork.idle();
    const g = library.list()[0]!;
    expect(g.launcher).toBe('epic');
    expect(g.artwork).toMatchObject({ source: 'steamcdn' });
    expect(g.artwork?.grid).toContain('/grid.jpg');
    expect(g.artwork?.logo).toContain('/logo.png');
    expect(g.artworkError).toBeNull();
    expect(calls.some((c) => c.url.startsWith(SGDB))).toBe(false);
    for (const c of calls) expect(c.auth).toBeNull();
  });

  it('falls through to the community search and refuses near matches', async () => {
    const { library, artwork, calls } = setup(
      {
        [STORE_SEARCH('Overwatch')]: () => storeHits([{ id: 4586850, name: 'Overwatch® BlizzCon® Bundle', type: 'app' }]),
        [COMMUNITY_SEARCH('Overwatch')]: () => json(JSON.stringify([{ appid: '2357570', name: 'Overwatch®' }])),
        [`${STEAM_CDN_ALT.replace('252950', '2357570')}/library_600x900.jpg`]: () => image(JPEG),
      },
      { games: [game({ launcher: 'epic', launcherGameId: 'ow', name: 'Overwatch' })] },
    );
    artwork.enqueueMissing();
    await artwork.idle();
    expect(library.list()[0]?.artwork).toMatchObject({ source: 'steamcdn' });
    expect(calls.some((c) => c.url.includes('/4586850/'))).toBe(false);
  });

  it('uses the Battle.net product table without searching, and SteamGridDB by that appid for what the CDN lacks', async () => {
    const OW_CDN = STEAM_CDN.replace('252950', '2357570');
    const { library, artwork, calls } = setup(
      {
        [`${OW_CDN}/library_600x900.jpg`]: () => image(JPEG),
        [`${SGDB}/heroes/steam/2357570?types=static&nsfw=false&humor=false`]: () => json(fixture('heroes-game-5267.json')),
        [`${SGDB}/logos/steam/2357570?types=static&nsfw=false&humor=false`]: () => json(fixture('empty.json')),
        'https://cdn2.steamgriddb.com/hero/cccc3333.jpg': () => image(JPEG),
      },
      { apiKey: 'k', games: [game({ launcher: 'battlenet', launcherGameId: 'prometheus', name: 'Overwatch' })] },
    );
    artwork.enqueueMissing();
    await artwork.idle();
    const g = library.list()[0]!;
    expect(g.launcher).toBe('battlenet');
    expect(g.artwork).toMatchObject({ source: 'steamcdn' });
    expect(g.artwork?.grid).toContain('/grid.jpg');
    expect(g.artwork?.hero).toContain('/hero.jpg');
    expect(calls.some((c) => c.url.includes('storesearch') || c.url.includes('SearchApps'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/search/autocomplete/'))).toBe(false);
  });

  it('uses the Epic known-id table for games delisted from the Steam store, without searching', async () => {
    const { library, artwork, calls } = setup(
      { [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG) },
      { games: [game({ launcher: 'epic', launcherGameId: 'Sugar', name: 'Rocket League®' })] },
    );
    artwork.enqueueMissing();
    await artwork.idle();
    expect(library.list()[0]?.artwork).toMatchObject({ source: 'steamcdn' });
    expect(calls.some((c) => c.url.includes('storesearch') || c.url.includes('SearchApps'))).toBe(false);
  });

  it('explains that a game not on Steam needs a SteamGridDB key', async () => {
    const { library, artwork, calls } = setup({}, { games: [game({ launcher: 'battlenet', launcherGameId: 'hs_beta', name: 'Hearthstone' })] });
    artwork.enqueueMissing();
    await artwork.idle();
    const g = library.list()[0]!;
    expect(g.artwork).toBeNull();
    expect(g.artworkError).toMatch(/Not found on Steam; add a SteamGridDB API key/);
    expect(calls.some((c) => c.url.includes('steamstatic'))).toBe(false);
  });
});

describe('ArtworkService manual override and refresh', () => {
  it('copies the chosen file into the cache as manual and protects it from refresh-all', async () => {
    const { dir, library, artwork, gameId, calls } = setup({ [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG) });
    const src = join(dir, 'mine.png');
    writeFileSync(src, PNG);
    const updated = artwork.setManual(gameId, 'grid', src);
    expect(updated.artwork).toMatchObject({ source: 'manual' });
    expect(updated.artwork?.grid).toContain('/grid.png');
    expect(readFileSync(join(dir, gameId, 'grid.png'))).toEqual(PNG);
    expect(existsSync(src)).toBe(true);

    expect(artwork.refresh(null, true)).toBe(0);
    expect(artwork.enqueueMissing()).toBe(0);
    await artwork.idle();
    expect(calls).toHaveLength(0);
    expect(library.get(gameId)?.artwork?.source).toBe('manual');

    expect(artwork.refresh(gameId, true)).toBe(1);
    await artwork.idle();
    expect(library.get(gameId)?.artwork).toMatchObject({ source: 'steamcdn' });
    expect(readdirSync(join(dir, gameId))).toEqual(['grid.jpg']);
  });

  it('refuses files that are not images or are too large, and unknown games', () => {
    const { dir, artwork, gameId } = setup({});
    const bad = join(dir, 'bad.png');
    writeFileSync(bad, HTML);
    expect(() => artwork.setManual(gameId, 'grid', bad)).toThrow(/not a JPEG, PNG, or WebP/);
    expect(() => artwork.setManual('nope', 'grid', bad)).toThrow(/does not exist/);
    expect(existsSync(join(dir, gameId))).toBe(false);
  });

  it('force refresh re-downloads a cached game once and merges partial results without a manual flag', async () => {
    const routes = { [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG) };
    const { library, artwork, gameId, calls } = setup(routes);
    artwork.enqueueMissing();
    await artwork.idle();
    const first = library.get(gameId)!.artwork!;
    await new Promise((r) => setTimeout(r, 5));
    expect(artwork.refresh(gameId, true)).toBe(1);
    expect(artwork.refresh(gameId, true)).toBe(0);
    await artwork.idle();
    const second = library.get(gameId)!.artwork!;
    expect(second.grid).not.toBe(first.grid);
    expect(calls.filter((c) => c.url.endsWith('library_600x900.jpg'))).toHaveLength(2);
  });

  /** A CDN response that the test lets go when it chooses, so something else can happen while the download is in flight. */
  const heldBack = (bytes: Buffer): { route: () => Promise<Response>; release: () => void; requested: Promise<void> } => {
    let release!: () => void;
    let seen!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const requested = new Promise<void>((r) => (seen = r));
    return {
      route: async () => {
        seen();
        await gate;
        return image(bytes);
      },
      release,
      requested,
    };
  };

  it('keeps an image the user picked while a background fetch for the same game was downloading', async () => {
    const held = heldBack(JPEG);
    const { dir, library, artwork, gameId } = setup({ [`${STEAM_CDN}/library_600x900.jpg`]: held.route as unknown as () => Response });
    artwork.enqueueMissing();
    await held.requested;
    const src = join(dir, 'mine.jpg');
    const mine = Buffer.concat([JPEG, Buffer.from('mine')]);
    writeFileSync(src, mine);
    artwork.setManual(gameId, 'grid', src);
    held.release();
    await artwork.idle();
    expect(library.get(gameId)?.artwork).toMatchObject({ source: 'manual' });
    expect(readFileSync(join(dir, gameId, 'grid.jpg'))).toEqual(mine);
    expect(artwork.status()).toMatchObject({ completed: 1, failed: 0 });
  });

  it('runs a forced refresh after the unforced job it arrived during, instead of dropping it', async () => {
    const held = heldBack(JPEG);
    let served = 0;
    const { artwork, gameId, calls } = setup({
      [`${STEAM_CDN}/library_600x900.jpg`]: (() => (served++ === 0 ? held.route() : image(PNG, 'image/png'))) as unknown as () => Response,
    });
    expect(artwork.enqueueMissing()).toBe(1);
    await held.requested;
    expect(artwork.refresh(gameId, true)).toBe(1);
    // A second forced request is a double click: the one already waiting covers it.
    expect(artwork.refresh(gameId, true)).toBe(0);
    held.release();
    await artwork.idle();
    expect(calls.filter((c) => c.url.endsWith('library_600x900.jpg'))).toHaveLength(2);
    expect(artwork.status()).toMatchObject({ completed: 2, failed: 0, queued: 0, running: 0 });
  });

  it('counts a game with no artwork anywhere as not found, not as done', async () => {
    const { artwork } = setup({});
    artwork.enqueueMissing();
    await artwork.idle();
    expect(artwork.status()).toMatchObject({ completed: 0, failed: 1 });
  });

  it('fetches again when a cached file was deleted from disk', async () => {
    const { dir, library, artwork, gameId, calls } = setup({ [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG) });
    artwork.enqueueMissing();
    await artwork.idle();
    expect(artwork.enqueueMissing()).toBe(0);
    rmSync(join(dir, gameId, 'grid.jpg'));
    expect(artwork.enqueueMissing({ ignoreAttempts: true })).toBe(1);
    await artwork.idle();
    expect(existsSync(join(dir, gameId, 'grid.jpg'))).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('library_600x900.jpg'))).toHaveLength(2);
    expect(library.get(gameId)?.artwork?.grid).toBeTruthy();
  });

  it('runs at most `concurrency` downloads at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<Response>((resolve) =>
        setTimeout(() => {
          inFlight--;
          resolve(image(JPEG));
        }, 5),
      );
    };
    const games = ['1', '2', '3', '4', '5'].map((id) => game({ launcherGameId: id, name: `Game ${id}` }));
    const dir = mkdtempSync(join(tmpdir(), 'onelaunch-art-'));
    dirs.push(dir);
    const db = openDatabase(':memory:');
    migrate(db);
    const library = new LibraryService(db);
    library.sync('steam', games);
    const artwork = new ArtworkService(db, {
      dir,
      fetch: () => slow(),
      apiKey: () => null,
      hasApiKey: () => false,
      autoFetch: () => true,
      library,
      log: createLogger('test:artwork'),
      concurrency: 2,
    });
    expect(artwork.enqueueMissing()).toBe(5);
    await artwork.idle();
    expect(peak).toBeLessThanOrEqual(2);
    expect(library.list().every((g) => g.artwork?.grid)).toBe(true);
    expect(artwork.status().completed).toBe(5);
  });

  it('stop() drops the queue, and the downloads already in flight finish without writing to the database', async () => {
    const games = ['1', '2', '3', '4', '5'].map((id) => game({ launcherGameId: id, name: `Game ${id}` }));
    const dir = mkdtempSync(join(tmpdir(), 'onelaunch-art-'));
    dirs.push(dir);
    const db = openDatabase(':memory:');
    migrate(db);
    const library = new LibraryService(db);
    library.sync('steam', games);
    const artwork = new ArtworkService(db, {
      dir,
      fetch: () => new Promise<Response>((resolve) => setTimeout(() => resolve(image(JPEG)), 5)),
      apiKey: () => null,
      hasApiKey: () => false,
      autoFetch: () => true,
      library,
      log: createLogger('test:artwork'),
      concurrency: 2,
    });
    expect(artwork.enqueueMissing()).toBe(5);
    artwork.stop();
    expect(artwork.status()).toMatchObject({ queued: 0, running: 2 });
    const revision = library.revision;
    await artwork.idle();
    expect(db.prepare('SELECT COUNT(*) AS n FROM artwork').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM artwork_attempts').get()).toEqual({ n: 0 });
    expect(library.revision).toBe(revision);
    expect(artwork.enqueueMissing()).toBe(0);
  });
});

describe('ArtworkService and the automatic fetch setting (A10)', () => {
  const routes = { [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG) };

  it('fetches what is missing after a scan while the setting is on, which is the default', async () => {
    const { artwork, calls, library, gameId } = setup(routes);
    expect(artwork.enqueueAfterScan()).toBe(1);
    await artwork.idle();
    expect(calls.length).toBeGreaterThan(0);
    expect(library.get(gameId)?.artwork?.grid).toBeTruthy();
  });

  it('fetches nothing after a scan while the setting is off, but a refresh the user asks for still runs', async () => {
    let on = false;
    const { artwork, calls, gameId } = setup(routes, { autoFetch: () => on });
    expect(artwork.enqueueAfterScan()).toBe(0);
    await artwork.idle();
    expect(calls).toEqual([]);
    expect(artwork.refresh(gameId, true)).toBe(1);
    await artwork.idle();
    expect(calls.length).toBeGreaterThan(0);
    on = true;
    expect(artwork.enqueueAfterScan()).toBe(0);
  });
});

describe('ArtworkService.prune', () => {
  it('removes the cache of games that are no longer installed and leaves the rest', async () => {
    const two = [game(), game({ launcherGameId: '440', name: 'Team Fortress 2' })];
    const routes = {
      [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG),
      ['https://cdn.cloudflare.steamstatic.com/steam/apps/440/library_600x900.jpg']: () => image(JPEG),
    };
    const { dir, library, artwork } = setup(routes, { games: two });
    artwork.refresh(null, false);
    await artwork.idle();
    const ids = library.list().map((g) => g.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(existsSync(join(dir, id))).toBe(true);
    mkdirSync(join(dir, 'not-a-game-any-more'), { recursive: true });

    expect(artwork.prune()).toBe(1);
    for (const id of ids) expect(existsSync(join(dir, id))).toBe(true);
    expect(existsSync(join(dir, 'not-a-game-any-more'))).toBe(false);

    library.sync('steam', [two[0]!]);
    const kept = library.list().map((g) => g.id);
    expect(kept).toHaveLength(1);
    const gone = ids.find((id) => !kept.includes(id))!;
    expect(artwork.prune()).toBe(1);
    expect(existsSync(join(dir, gone))).toBe(false);
    expect(existsSync(join(dir, kept[0]!))).toBe(true);
    expect(library.list()[0]?.artwork?.grid).toBeTruthy();
  });

  it('sweeps the rows of a game that is gone even when its folder is already gone', async () => {
    const two = [game(), game({ launcherGameId: '440', name: 'Team Fortress 2' })];
    const { dir, db, library, artwork } = setup(
      { ['https://cdn.cloudflare.steamstatic.com/steam/apps/440/library_600x900.jpg']: () => image(JPEG) },
      { games: two },
    );
    artwork.refresh(null, false);
    await artwork.idle();
    const rows = (): number => (db.prepare('SELECT (SELECT COUNT(*) FROM artwork) + (SELECT COUNT(*) FROM artwork_attempts) AS n').get() as { n: number }).n;
    expect(rows()).toBe(2);
    const ids = library.list().map((g) => g.id);
    library.sync('steam', []);
    for (const id of ids) rmSync(join(dir, id), { recursive: true, force: true });
    writeFileSync(join(dir, 'not-a-folder.txt'), 'x');
    expect(artwork.prune()).toBe(2);
    expect(rows()).toBe(0);
    expect(existsSync(join(dir, 'not-a-folder.txt'))).toBe(true);
  });
});

describe('ArtworkService fetch limits (H3)', () => {
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
  const SHARED = 'https://shared.steamstatic.com/store_item_assets/steam/apps/252950';

  it('follows a redirect between the artwork hosts and never one that leaves them', async () => {
    const { library, artwork, gameId, calls } = setup({
      [`${STEAM_CDN_ALT}/library_600x900.jpg`]: () => redirect(`${SHARED}/library_600x900.jpg`, 301),
      [`${SHARED}/library_600x900.jpg`]: () => image(JPEG),
      [`${STEAM_CDN}/library_hero.jpg`]: () => redirect('https://127.0.0.1/hero.jpg'),
      'https://127.0.0.1/hero.jpg': () => image(JPEG),
      [`${STEAM_CDN}/logo.png`]: () => redirect('http://cdn.cloudflare.steamstatic.com/steam/apps/252950/logo.png', 307),
      'http://cdn.cloudflare.steamstatic.com/steam/apps/252950/logo.png': () => image(PNG, 'image/png'),
    });
    artwork.enqueueMissing();
    await artwork.idle();
    const g = library.get(gameId)!;
    expect(g.artwork?.grid).toContain('/grid.jpg');
    expect(g.artwork?.hero).toBeNull();
    expect(g.artwork?.logo).toBeNull();
    expect(calls.filter((c) => c.url.startsWith('https://127.0.0.1') || c.url.startsWith('http://'))).toEqual([]);
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
  });

  it('gives up after a few redirects and says why', async () => {
    const loop = (file: string) => ({ [`${STEAM_CDN}/${file}`]: () => redirect(`${STEAM_CDN}/${file}`) });
    const { library, artwork, gameId, calls } = setup({ ...loop('library_600x900.jpg'), ...loop('library_hero.jpg'), ...loop('logo.png') });
    artwork.enqueueMissing();
    await artwork.idle();
    expect(library.get(gameId)!.artworkError).toMatch(/too many redirects/);
    expect(calls.filter((c) => c.url.endsWith('logo.png'))).toHaveLength(4);
  });

  it('stops reading an image past the size limit when no length was declared', async () => {
    let pulls = 0;
    let cancelled = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled++;
          },
        }),
        { status: 200, headers: { 'content-type': 'image/jpeg' } },
      );
    const { library, artwork, gameId } = setup({
      [`${STEAM_CDN}/library_600x900.jpg`]: endless,
      [`${STEAM_CDN}/library_hero.jpg`]: endless,
      [`${STEAM_CDN}/logo.png`]: endless,
    });
    artwork.enqueueMissing();
    await artwork.idle();
    expect(library.get(gameId)!.artworkError).toMatch(/too large \(over 10485760 bytes\)/);
    expect(cancelled).toBe(3);
    expect(pulls).toBeLessThan(3 * 14);
  });

  it('asks SteamGridDB with redirects off and never fetches an image it names on another host', async () => {
    const elsewhere = JSON.stringify({ success: true, data: [{ id: 1, url: 'https://images.example/hero.jpg' }] });
    const { library, artwork, calls } = setup(
      {
        [`${SGDB}/search/autocomplete/Rocket%20League`]: () => json(fixture('autocomplete-rocket-league.json')),
        [`${SGDB}/grids/game/5267?dimensions=600x900&types=static&nsfw=false&humor=false`]: () => json(fixture('grids-steam-252950.json')),
        [`${SGDB}/heroes/game/5267?types=static&nsfw=false&humor=false`]: () => json(elsewhere),
        [`${SGDB}/logos/game/5267?types=static&nsfw=false&humor=false`]: () => json(fixture('empty.json')),
        'https://cdn2.steamgriddb.com/grid/aaaa1111.png': () => image(PNG, 'image/png'),
        'https://images.example/hero.jpg': () => image(JPEG),
      },
      { apiKey: 'k', games: [game({ launcher: 'epic', launcherGameId: 'Kiwi', name: 'Rocket League' })] },
    );
    artwork.enqueueMissing();
    await artwork.idle();
    const g = library.list()[0]!;
    expect(g.artwork?.grid).toContain('/grid.png');
    expect(g.artwork?.hero).toBeNull();
    expect(calls.some((c) => c.url.includes('images.example'))).toBe(false);
    const lookups = calls.filter((c) => c.url.startsWith(SGDB) || c.url.includes('store.steampowered.com') || c.url.includes('steamcommunity.com'));
    expect(lookups.length).toBeGreaterThan(3);
    expect(lookups.every((c) => c.redirect === 'error')).toBe(true);
    expect(calls.filter((c) => !lookups.includes(c)).every((c) => c.redirect === 'manual' && c.auth === null)).toBe(true);
  });

  it('refuses an API answer over a megabyte and keeps a long error list short', async () => {
    const grids = `${SGDB}/grids/steam/252950?dimensions=600x900&types=static&nsfw=false&humor=false`;
    const huge = setup({ [grids]: () => json(JSON.stringify({ success: true, data: [{ url: 'x'.repeat(2 * 1024 * 1024) }] })) }, { apiKey: 'k' });
    huge.artwork.enqueueMissing();
    await huge.artwork.idle();
    expect(huge.library.get(huge.gameId)!.artworkError).toMatch(/SteamGridDB: too large \(over 1048576 bytes\)/);

    const noisy = setup({ [grids]: () => json(JSON.stringify({ success: false, errors: ['e'.repeat(5000)] })) }, { apiKey: 'k' });
    noisy.artwork.enqueueMissing();
    await noisy.artwork.idle();
    const error = noisy.library.get(noisy.gameId)!.artworkError!;
    expect(error).toContain('eeee');
    expect(error.length).toBeLessThan(400);
  });
});

describe('ArtworkService and the launcher’s own icon (R10)', () => {
  const riot = (): InstalledGame =>
    game({ launcher: 'riot', launcherGameId: 'valorant.live', name: 'VALORANT', installPath: 'D:\\Riot Games\\VALORANT\\live' });
  const SEARCH = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent('VALORANT')}&l=english&cc=US`;
  const COMMUNITY = `https://steamcommunity.com/actions/SearchApps/${encodeURIComponent('VALORANT')}`;
  const NOT_ON_STEAM = { [SEARCH]: () => json('{"items":[]}'), [COMMUNITY]: () => json('[]') };
  /** Writes a real icon file where a launcher would keep it and hands its path to the service. */
  const withIcon = (bytes: Buffer = solidIco(32, [200, 40, 60])) => {
    const dir = mkdtempSync(join(tmpdir(), 'onelaunch-icon-'));
    dirs.push(dir);
    const path = join(dir, 'valorant.live.ico');
    writeFileSync(path, bytes);
    const asked: string[] = [];
    const launcherIcon = async (g: Game): Promise<string | null> => {
      asked.push(g.launcherGameId);
      return g.launcher === 'riot' ? path : null;
    };
    return { path, asked, launcherIcon };
  };

  it('stands the icon in for the grid when nothing online has a cover, keeps the miss on record, and asks online again when told to', async () => {
    const { asked, launcherIcon } = withIcon();
    const { dir, library, artwork, gameId } = setup(NOT_ON_STEAM, { games: [riot()], launcherIcon });
    expect(artwork.enqueueMissing()).toBe(1);
    await artwork.idle();

    const g = library.get(gameId)!;
    expect(g.artwork).toMatchObject({ source: 'launcher', hero: null, logo: null });
    expect(g.artwork?.grid).toMatch(new RegExp(`^onelaunch-art://art/${gameId}/grid\\.ico\\?v=`));
    expect(g.artworkError).toBe('No cover found online; showing the game’s own icon');
    expect(readdirSync(join(dir, gameId))).toEqual(['grid.ico']);
    expect(sniffIcon(readFileSync(join(dir, gameId, 'grid.ico')))).toBe(true);
    expect(asked).toEqual(['valorant.live']);
    expect(artwork.status()).toMatchObject({ completed: 1, failed: 0 });

    // Within the retry window the stand-in is left alone; the user's own refresh asks online again and keeps it when nothing is found.
    expect(artwork.enqueueMissing()).toBe(0);
    expect(artwork.enqueueMissing({ ignoreAttempts: true })).toBe(1);
    await artwork.idle();
    const again = library.get(gameId)!;
    expect(again.artwork?.grid).toBe(g.artwork?.grid);
    expect(again.artworkError).toBe('Not found on Steam; add a SteamGridDB API key in Settings');
    expect(asked).toEqual(['valorant.live']);
    expect(artwork.status()).toMatchObject({ completed: 1, failed: 1 });
  });

  it('is replaced by a cover once SteamGridDB has one, and never replaces an image the user picked', async () => {
    const { launcherIcon } = withIcon();
    const grids = `${SGDB}/grids/game/7?dimensions=600x900&types=static&nsfw=false&humor=false`;
    const found = {
      ...NOT_ON_STEAM,
      [`${SGDB}/search/autocomplete/VALORANT`]: () => json('{"success":true,"data":[{"id":7,"name":"VALORANT"}]}'),
      [grids]: () => json('{"success":true,"data":[{"url":"https://cdn2.steamgriddb.com/grid/v.jpg"}]}'),
      'https://cdn2.steamgriddb.com/grid/v.jpg': () => image(JPEG),
    };
    let key: string | null = null;
    const { dir, library, artwork, gameId } = setup(found, { games: [riot()], launcherIcon, apiKey: null });
    (artwork as unknown as { deps: { apiKey: () => string | null } }).deps.apiKey = () => key;
    artwork.enqueueMissing();
    await artwork.idle();
    expect(library.get(gameId)!.artwork?.source).toBe('launcher');

    key = 'k';
    expect(artwork.refresh(null, false)).toBe(1);
    await artwork.idle();
    const covered = library.get(gameId)!;
    expect(covered.artwork).toMatchObject({ source: 'steamgriddb' });
    expect(covered.artwork?.grid).toContain('/grid.jpg');
    expect(covered.artworkError).toBeNull();
    expect(readdirSync(join(dir, gameId))).toEqual(['grid.jpg']);
    expect(artwork.enqueueMissing({ ignoreAttempts: true })).toBe(0);

    const manual = join(dir, 'mine.png');
    writeFileSync(manual, PNG);
    artwork.setManual(gameId, 'grid', manual);
    expect(artwork.refresh(null, false)).toBe(0);
    expect(library.get(gameId)!.artwork?.source).toBe('manual');
  });

  it('ignores an icon file that is not an image, a launcher that keeps none, and a lookup that fails', async () => {
    const junk = withIcon(Buffer.from('MZ not an icon at all, just bytes'));
    const a = setup(NOT_ON_STEAM, { games: [riot()], launcherIcon: junk.launcherIcon });
    a.artwork.enqueueMissing();
    await a.artwork.idle();
    expect(a.library.get(a.gameId)!.artwork).toBeNull();
    expect(a.library.get(a.gameId)!.artworkError).toBe('Not found on Steam; add a SteamGridDB API key in Settings');

    const b = setup(NOT_ON_STEAM, { games: [riot()], launcherIcon: async () => null });
    b.artwork.enqueueMissing();
    await b.artwork.idle();
    expect(b.library.get(b.gameId)!.artwork).toBeNull();

    const c = setup(NOT_ON_STEAM, {
      games: [riot()],
      launcherIcon: async () => {
        throw new Error('registry unavailable');
      },
    });
    c.artwork.enqueueMissing();
    await c.artwork.idle();
    expect(c.library.get(c.gameId)!.artwork).toBeNull();
    expect(c.artwork.status()).toMatchObject({ completed: 0, failed: 1 });

    // A game the Steam CDN covers never asks for the icon.
    const { asked, launcherIcon } = withIcon();
    const d = setup({ [`${STEAM_CDN}/library_600x900.jpg`]: () => image(JPEG) }, { launcherIcon });
    d.artwork.enqueueMissing();
    await d.artwork.idle();
    expect(d.library.get(d.gameId)!.artwork?.source).toBe('steamcdn');
    expect(asked).toEqual([]);
  });

  it('stores the icon only once the last checks have passed: an image picked while it was being read wins, and a stop drops it', async () => {
    /** An icon lookup that answers only when released, like a registry read that takes its time. */
    const heldIcon = (): { launcherIcon: (g: Game) => Promise<string | null>; release: () => void; requested: Promise<void> } => {
      const { path } = withIcon();
      let release!: () => void;
      let seen!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const requested = new Promise<void>((r) => (seen = r));
      return {
        launcherIcon: async () => {
          seen();
          await gate;
          return path;
        },
        release,
        requested,
      };
    };

    const picked = heldIcon();
    const a = setup(NOT_ON_STEAM, { games: [riot()], launcherIcon: picked.launcherIcon });
    a.artwork.enqueueMissing();
    await picked.requested;
    const manual = join(a.dir, 'mine.png');
    writeFileSync(manual, PNG);
    a.artwork.setManual(a.gameId, 'grid', manual);
    picked.release();
    await a.artwork.idle();
    expect(a.library.get(a.gameId)!.artwork).toMatchObject({ source: 'manual' });
    expect(a.library.get(a.gameId)!.artworkError).toBeNull();
    expect(readdirSync(join(a.dir, a.gameId))).toEqual(['grid.png']);
    expect(a.artwork.status()).toMatchObject({ completed: 1, failed: 0 });

    const stopped = heldIcon();
    const b = setup(NOT_ON_STEAM, { games: [riot()], launcherIcon: stopped.launcherIcon });
    b.artwork.enqueueMissing();
    await stopped.requested;
    b.artwork.stop();
    stopped.release();
    await b.artwork.idle();
    expect(b.library.get(b.gameId)!.artwork).toBeNull();
    expect(b.library.get(b.gameId)!.artworkError).toBeNull();
    expect(existsSync(join(b.dir, b.gameId))).toBe(false);
  });
});
