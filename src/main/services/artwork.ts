import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTWORK_KINDS, type ArtworkKind, type ArtworkSource, type ArtworkStatus, type Game } from '@shared/models';
import type { Db } from '../db';
import { PRODUCTS as BATTLENET_PRODUCTS } from '../launchers/battlenet/products';
import { EPIC_STEAM_APP_IDS } from '../launchers/epic/steam-ids';
import { readLauncherBytes } from '../launchers/read-file';
import { artworkFileName, artworkRelPath, sniffIcon, sniffImage, type ArtworkExt } from './artwork-url';
import type { LibraryService } from './library';
import type { Logger } from './logger';

/** The subset of fetch the service uses, so tests can hand in a fake without touching the network. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' | 'error' | 'manual' },
) => Promise<Response>;

export interface ArtworkDeps {
  /** The artwork folder under the app data directory. */
  dir: string;
  fetch: FetchLike;
  /** Reads the SteamGridDB key from the vault at the moment of use. Never cached, never logged. */
  apiKey: () => string | null;
  /** Whether a key is stored, without decrypting it (status is polled every second or two). */
  hasApiKey: () => boolean;
  /** The "Fetch artwork automatically" setting, read at the moment of use. On unless the user turned it off. */
  autoFetch: () => boolean;
  /**
   * The icon file the game's launcher keeps for it (Riot's `<product>.<patchline>.ico`), as a local path,
   * or null. Asked only when no source online had a cover: the icon then stands in for the grid until
   * one is found. A local read, no network.
   */
  launcherIcon?: (game: Game) => Promise<string | null>;
  library: LibraryService;
  log: Logger;
  concurrency?: number;
  timeoutMs?: number;
  /** A failed lookup is not retried automatically until this much time has passed. */
  retryAfterMs?: number;
  maxDownloadBytes?: number;
  maxManualBytes?: number;
}

export class ArtworkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArtworkError';
  }
}

interface ArtworkRow {
  source: string;
  grid_path: string | null;
  hero_path: string | null;
  logo_path: string | null;
  fetched_at: string | null;
}

type Found = Partial<Record<ArtworkKind, { relPath: string; source: ArtworkSource }>>;

/** A validated download held in memory. Nothing is written into the game folder until the whole job is known to still be wanted. */
interface Download {
  bytes: Buffer;
  ext: ArtworkExt;
}
type Downloads = Partial<Record<ArtworkKind, Download & { source: ArtworkSource }>>;

const STEAM_CDN_HOSTS = ['https://cdn.cloudflare.steamstatic.com/steam/apps', 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps'];
const STEAM_CDN_FILES: Readonly<Record<ArtworkKind, string>> = { grid: 'library_600x900.jpg', hero: 'library_hero.jpg', logo: 'logo.png' };
/** Keyless Steam search endpoints; both answer JSON and are used only to map a game name to an appid. */
const STEAM_SEARCH_URLS: readonly ((term: string) => string)[] = [
  (term) => `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`,
  (term) => `https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(term)}`,
];

const SGDB_API = 'https://www.steamgriddb.com/api/v2';
const SGDB_TYPES: Readonly<Record<ArtworkKind, string>> = { grid: 'grids', hero: 'heroes', logo: 'logos' };
const SGDB_FILTER = 'types=static&nsfw=false&humor=false';

/** The only hosts an image is fetched from, first request or redirect. The second Steam CDN host answers with a redirect to shared.steamstatic.com. */
const IMAGE_HOSTS: ReadonlySet<string> = new Set([...STEAM_CDN_HOSTS.map((base) => new URL(base).hostname), 'shared.steamstatic.com', 'cdn2.steamgriddb.com']);
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_IMAGE_REDIRECTS = 3;
const MAX_JSON_BYTES = 1024 * 1024;

function isImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.port === '' && IMAGE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Reads a body up to `maxBytes` and drops the connection past that, so an oversized or endless answer is never buffered whole. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new Error(`too large (${declared} bytes)`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new Error(`too large (over ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function readJson(res: Response): Promise<unknown> {
  return JSON.parse((await readCapped(res, MAX_JSON_BYTES)).toString('utf8')) as unknown;
}

const DAY = 24 * 60 * 60 * 1000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fetches and caches game artwork (spec section 9). Steam's CDN first, with no key, for every game
 * that has a Steam appid: Steam games by their own id, Battle.net products from the product table,
 * and anything else by an exact name match in Steam's public search. SteamGridDB for the rest and
 * for anything the CDN lacks. Every download is checked for content type, size,
 * and magic bytes and written temp-then-rename under artwork/<game_id>/. A miss is recorded in
 * artwork_attempts so the next start does not repeat it.
 *
 * Only game names and IDs leave the machine. The API key travels in the Authorization header and
 * nowhere else; it is read from the vault per request and never logged.
 */
export class ArtworkService {
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly retryAfterMs: number;
  private readonly maxDownloadBytes: number;
  private readonly maxManualBytes: number;
  private readonly pending = new Map<string, boolean>();
  /** Running jobs, with whether each one is a forced re-download. */
  private readonly active = new Map<string, boolean>();
  /** Forced requests that arrived while an unforced job for the same game was running; they run when it ends. */
  private readonly again = new Set<string>();
  /** How many times the user has picked an image per game, so a fetch that was overtaken by a pick can tell. */
  private readonly manualPicks = new Map<string, number>();
  private waiters: (() => void)[] = [];
  private completed = 0;
  private failed = 0;
  private stopped = false;

  private readonly rowStmt;
  private readonly upsertStmt;
  private readonly attemptStmt;
  private readonly recordAttemptStmt;
  private readonly clearAttemptStmt;
  private readonly deleteRowStmt;
  private readonly rowIdsStmt;

  constructor(
    db: Db,
    private readonly deps: ArtworkDeps,
  ) {
    this.concurrency = deps.concurrency ?? 2;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
    this.retryAfterMs = deps.retryAfterMs ?? 7 * DAY;
    this.maxDownloadBytes = deps.maxDownloadBytes ?? 10 * 1024 * 1024;
    this.maxManualBytes = deps.maxManualBytes ?? 20 * 1024 * 1024;
    this.rowStmt = db.prepare<[string], ArtworkRow>('SELECT source, grid_path, hero_path, logo_path, fetched_at FROM artwork WHERE game_id = ?');
    this.upsertStmt = db.prepare<[string, string, string | null, string | null, string | null, string]>(
      `INSERT INTO artwork (game_id, source, grid_path, hero_path, logo_path, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id) DO UPDATE SET source = excluded.source, grid_path = excluded.grid_path, hero_path = excluded.hero_path,
         logo_path = excluded.logo_path, fetched_at = excluded.fetched_at`,
    );
    this.attemptStmt = db.prepare<[string], { attempted_at: string }>('SELECT attempted_at FROM artwork_attempts WHERE game_id = ?');
    this.recordAttemptStmt = db.prepare<[string, string, string]>(
      `INSERT INTO artwork_attempts (game_id, attempted_at, error) VALUES (?, ?, ?)
       ON CONFLICT (game_id) DO UPDATE SET attempted_at = excluded.attempted_at, error = excluded.error`,
    );
    this.clearAttemptStmt = db.prepare<[string]>('DELETE FROM artwork_attempts WHERE game_id = ?');
    this.deleteRowStmt = db.prepare<[string]>('DELETE FROM artwork WHERE game_id = ?');
    this.rowIdsStmt = db.prepare<[], { game_id: string }>('SELECT game_id FROM artwork UNION SELECT game_id FROM artwork_attempts');
  }

  /**
   * Drops the cached images (and rows) of games that are no longer installed or no longer exist,
   * so the cache only ever holds what the library shows. A reinstalled game is fetched again.
   */
  prune(): number {
    const keep = new Set(this.deps.library.list().map((g) => g.id));
    const busy = (id: string): boolean => this.active.has(id) || this.pending.has(id);
    let removed = 0;
    let folders: string[] = [];
    try {
      // The listing says what is a folder, so nothing is stat'ed afterwards: a folder that another prune removed meanwhile cannot throw.
      folders = readdirSync(this.deps.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // no folder yet: only rows can be left over
    }
    const gone = new Set<string>();
    for (const name of folders) {
      if (keep.has(name) || busy(name)) continue;
      rmSync(join(this.deps.dir, name), { recursive: true, force: true });
      gone.add(name);
    }
    // A row can outlive its folder (deleted by hand, or never written), so the tables are swept too.
    for (const { game_id } of this.rowIdsStmt.all()) if (!keep.has(game_id) && !busy(game_id)) gone.add(game_id);
    for (const id of gone) {
      this.deleteRowStmt.run(id);
      this.clearAttemptStmt.run(id);
      removed++;
    }
    if (removed > 0) {
      this.deps.library.bump();
      this.deps.log.info('artwork pruned', { removed });
    }
    return removed;
  }

  status(): ArtworkStatus {
    return {
      queued: this.pending.size,
      running: this.active.size,
      completed: this.completed,
      failed: this.failed,
      hasApiKey: this.deps.hasApiKey(),
      revision: this.deps.library.revision,
      scanned: this.deps.library.scanned,
    };
  }

  /**
   * Queues every installed game without a grid image (a launcher's icon standing in for one counts as
   * missing). Games whose last lookup failed recently are skipped unless `ignoreAttempts` is set (the
   * user asked). Returns how many were queued.
   */
  enqueueMissing(opts: { ignoreAttempts?: boolean } = {}): number {
    const now = Date.now();
    const ids: string[] = [];
    for (const game of this.deps.library.list()) {
      if (game.artwork?.grid && game.artwork.source !== 'launcher' && this.onDisk(this.rowStmt.get(game.id)?.grid_path ?? null)) continue;
      if (!opts.ignoreAttempts) {
        const attempt = this.attemptStmt.get(game.id);
        if (attempt && now - Date.parse(attempt.attempted_at) < this.retryAfterMs) continue;
      }
      ids.push(game.id);
    }
    return this.enqueue(ids, false);
  }

  /** After a library scan, and when the setting is turned on: look up what is missing, unless automatic fetching is off. */
  enqueueAfterScan(): number {
    return this.deps.autoFetch() ? this.enqueueMissing() : 0;
  }

  /**
   * One game, or every installed game when `gameId` is null. `force` re-downloads even when cached.
   * Forcing a single game replaces a manual image; forcing all leaves manual images alone.
   */
  refresh(gameId: string | null, force: boolean): number {
    if (gameId !== null) {
      this.deps.library.require(gameId);
      return this.enqueue([gameId], force);
    }
    if (!force) return this.enqueueMissing({ ignoreAttempts: true });
    const ids = this.deps.library
      .list()
      .filter((g) => g.artwork?.source !== 'manual')
      .map((g) => g.id);
    return this.enqueue(ids, true);
  }

  /** For quit: drops the queue, and a job still in flight finishes without touching the database (it is about to close). */
  stop(): void {
    this.stopped = true;
    this.pending.clear();
  }

  /** Resolves once the queue has drained. */
  idle(): Promise<void> {
    if (this.pending.size === 0 && this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Copies the user's own image into the cache as the game's `kind` and marks the artwork manual. */
  setManual(gameId: string, kind: ArtworkKind, sourcePath: string): Game {
    this.deps.library.require(gameId);
    const size = statSync(sourcePath).size;
    if (size > this.maxManualBytes) throw new ArtworkError('TOO_LARGE', `That image is larger than ${Math.round(this.maxManualBytes / 1024 / 1024)} MB`);
    const bytes = readFileSync(sourcePath);
    const ext = sniffImage(bytes);
    if (!ext) throw new ArtworkError('BAD_IMAGE', 'That file is not a JPEG, PNG, or WebP image');
    this.manualPicks.set(gameId, (this.manualPicks.get(gameId) ?? 0) + 1);
    const relPath = this.store(gameId, kind, ext, (tmp) => copyFileSync(sourcePath, tmp));
    this.commit(gameId, { [kind]: { relPath, source: 'manual' } }, 'manual');
    this.deps.log.info('manual artwork set', { gameId, kind });
    return this.deps.library.require(gameId);
  }

  private enqueue(ids: readonly string[], force: boolean): number {
    if (this.stopped) return 0;
    let queued = 0;
    for (const id of ids) {
      const running = this.active.get(id);
      if (running !== undefined) {
        // The running job already covers the request unless it asks for a re-download that job is not doing; then the game runs again afterwards.
        if (!force || running || this.again.has(id)) continue;
        this.again.add(id);
        queued++;
        continue;
      }
      const prev = this.pending.get(id);
      if (prev === undefined) queued++;
      this.pending.set(id, (prev ?? false) || force);
    }
    this.pump();
    return queued;
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.size > 0) {
      const next = this.pending.entries().next();
      if (next.done) break;
      const [id, force] = next.value;
      this.pending.delete(id);
      this.active.set(id, force);
      void this.process(id, force)
        .catch((err: unknown) => {
          this.deps.log.error('artwork job crashed', { gameId: id, error: err });
          return 'failed' as const;
        })
        .then((outcome) => {
          this.active.delete(id);
          if (outcome === 'failed') this.failed++;
          else this.completed++;
          if (this.again.delete(id) && !this.stopped) this.pending.set(id, true);
          this.pump();
        });
    }
    if (this.active.size === 0 && this.pending.size === 0 && this.waiters.length > 0) {
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
  }

  private onDisk(relPath: string | null): boolean {
    return relPath !== null && existsSync(join(this.deps.dir, relPath));
  }

  private async process(gameId: string, force: boolean): Promise<'done' | 'failed'> {
    const game = this.deps.library.get(gameId);
    if (!game || !game.installed) return 'done';
    const row = this.rowStmt.get(gameId) ?? null;
    if (row?.source === 'manual' && !force) return 'done';
    const picksAtStart = this.manualPicks.get(gameId) ?? 0;
    const have = force ? {} : fromRow(row);
    // A cached file that was deleted from disk is as good as never fetched.
    for (const kind of ARTWORK_KINDS) if (have[kind] && !this.onDisk(have[kind].relPath)) delete have[kind];
    // The launcher's icon only stands in for a cover, so the sources online are asked for one again.
    const standIn = have.grid?.source === 'launcher' ? have.grid : null;
    if (standIn) delete have.grid;
    const missing = ARTWORK_KINDS.filter((k) => !have[k]);
    if (missing.length === 0) return 'done';

    const found: Downloads = {};
    const problems: string[] = [];

    let appId = steamAppIdFor(game);
    if (appId === null && game.launcher !== 'steam') {
      const search = await this.searchSteamAppId(game.name);
      appId = search.appId;
      if (search.error) problems.push(`Steam search: ${search.error}`);
    }
    if (appId !== null) {
      for (const kind of missing) {
        const result = await this.fromSteamCdn(appId, kind);
        if (result.image) found[kind] = { ...result.image, source: 'steamcdn' };
        else if (result.error) problems.push(`Steam CDN ${kind}: ${result.error}`);
      }
    }

    const still = missing.filter((k) => !found[k]);
    if (still.length > 0) {
      const key = this.deps.apiKey();
      if (key) {
        const outcome = await this.fromSteamGridDb(game, appId, still, key);
        Object.assign(found, outcome.found);
        problems.push(...outcome.problems);
      } else if (!found.grid) {
        problems.push(appId !== null ? 'No SteamGridDB API key in Settings' : 'Not found on Steam; add a SteamGridDB API key in Settings');
      }
    }

    // The launcher's icon only stands in for a cover, so it is read when none came back and none is on disk, and
    // before the checks below: nothing is stored after an await, or a stop or a manual pick during it would be lost.
    const icon = found.grid || standIn ? null : await this.launcherIcon(game);

    if (this.stopped) return 'done';
    // The user picked their own image while this was downloading. Theirs is the later word, and storing now would delete it.
    if ((this.manualPicks.get(gameId) ?? 0) !== picksAtStart) {
      this.deps.log.info('artwork fetch dropped: a manual image was set meanwhile', { gameId });
      return 'done';
    }
    const kinds = Object.keys(found) as ArtworkKind[];
    const error = problems.length > 0 ? problems.join('; ') : 'No artwork found';
    if (kinds.length === 0) {
      // A stand-in on disk stays as it is; only the reason and the time of this miss are recorded, for the next retry.
      if (!icon) {
        this.recordAttemptStmt.run(gameId, new Date().toISOString(), error.slice(0, 500));
        this.deps.library.bump();
        this.deps.log.info('artwork not found', { gameId, name: game.name, error, standIn: standIn !== null });
        return 'failed';
      }
      // The icon stands in, with the miss on record so the sources online are asked again later.
      this.commit(gameId, { grid: this.storeIcon(gameId, icon) }, 'launcher', false, 'No cover found online; showing the game’s own icon');
      this.deps.log.info('artwork stand-in cached', { gameId, name: game.name });
      return 'done';
    }
    const stored: Found = {};
    for (const kind of kinds) {
      const image = found[kind]!;
      stored[kind] = { relPath: this.store(gameId, kind, image.ext, (tmp) => writeFileSync(tmp, image.bytes)), source: image.source };
    }
    // Still no cover: the icon keeps standing in (as it is, or freshly read), and the miss stays on record.
    const keepStandIn = stored.grid ? null : (standIn ?? (icon ? this.storeIcon(gameId, icon) : null));
    if (keepStandIn) stored.grid = keepStandIn;
    const source = stored.grid?.source ?? have.grid?.source ?? stored[kinds[0]!]!.source;
    this.commit(gameId, force ? stored : { ...have, ...stored }, source, force, keepStandIn ? error : null);
    this.deps.log.info('artwork cached', { gameId, name: game.name, kinds, source });
    return 'done';
  }

  /** Puts the launcher's own icon in the cache as the game's grid. */
  private storeIcon(gameId: string, icon: Download): NonNullable<Found['grid']> {
    return { relPath: this.store(gameId, 'grid', icon.ext, (tmp) => writeFileSync(tmp, icon.bytes)), source: 'launcher' };
  }

  /** The launcher's icon file for the game, read and checked, or null when there is none or it is not an image. */
  private async launcherIcon(game: Game): Promise<Download | null> {
    if (!this.deps.launcherIcon) return null;
    try {
      const path = await this.deps.launcherIcon(game);
      if (!path) return null;
      const bytes = readLauncherBytes(path);
      const ext: ArtworkExt | null = sniffImage(bytes) ?? (sniffIcon(bytes) ? 'ico' : null);
      if (!ext) {
        this.deps.log.info('launcher icon is not an image', { gameId: game.id, path });
        return null;
      }
      return { bytes, ext };
    } catch (err) {
      this.deps.log.warn('could not read the launcher icon', { gameId: game.id, error: errorText(err) });
      return null;
    }
  }

  private commit(gameId: string, found: Found, source: ArtworkSource, replaceAll = false, attemptError: string | null = null): void {
    const merged = replaceAll ? found : { ...fromRow(this.rowStmt.get(gameId) ?? null), ...found };
    this.upsertStmt.run(gameId, source, merged.grid?.relPath ?? null, merged.hero?.relPath ?? null, merged.logo?.relPath ?? null, new Date().toISOString());
    if (attemptError === null) this.clearAttemptStmt.run(gameId);
    else this.recordAttemptStmt.run(gameId, new Date().toISOString(), attemptError.slice(0, 500));
    this.deps.library.bump();
  }

  /**
   * Maps a game name to a Steam appid through Steam's public search, accepted only when a result's
   * name matches exactly (ignoring case, punctuation, and trademark marks). A wrong guess would put
   * another game's cover on the card, so anything looser is left to SteamGridDB.
   */
  private async searchSteamAppId(name: string): Promise<{ appId: string | null; error: string | null }> {
    const want = normalizeName(name);
    if (!want) return { appId: null, error: null };
    const term = name.replace(/[®™©]/g, '').trim();
    let lastError: string | null = null;
    for (const build of STEAM_SEARCH_URLS) {
      try {
        const res = await this.deps.fetch(build(term), { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
        if (res.status === 404) continue;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await readJson(res);
        const items = Array.isArray(body) ? body : (body as { items?: unknown } | null)?.items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
          if (!o) continue;
          const type = stringField(o, 'type');
          if (type !== null && type !== 'app') continue;
          const id = o['id'] ?? o['appid'];
          const label = stringField(o, 'name');
          if (label && normalizeName(label) === want && (typeof id === 'number' || typeof id === 'string') && /^\d+$/.test(String(id))) {
            return { appId: String(id), error: null };
          }
        }
      } catch (err) {
        lastError = errorText(err);
      }
    }
    return { appId: null, error: lastError };
  }

  private async fromSteamCdn(appId: string, kind: ArtworkKind): Promise<{ image: Download | null; error: string | null }> {
    let lastError: string | null = null;
    for (const host of STEAM_CDN_HOSTS) {
      const url = `${host}/${encodeURIComponent(appId)}/${STEAM_CDN_FILES[kind]}`;
      try {
        return { image: await this.download(url), error: null };
      } catch (err) {
        lastError = errorText(err);
        if (lastError.startsWith('HTTP 404')) continue;
        break;
      }
    }
    return { image: null, error: lastError };
  }

  private async fromSteamGridDb(
    game: Game,
    appId: string | null,
    kinds: readonly ArtworkKind[],
    key: string,
  ): Promise<{ found: Downloads; problems: string[] }> {
    const headers = { Authorization: `Bearer ${key}` };
    const found: Downloads = {};
    const problems: string[] = [];
    try {
      let byGame: string;
      if (appId !== null) {
        byGame = `steam/${encodeURIComponent(appId)}`;
      } else {
        const hits = await this.apiJson(`${SGDB_API}/search/autocomplete/${encodeURIComponent(game.name)}`, headers);
        const id = numberField(firstOf(hits), 'id');
        if (id === null) return { found, problems: [`SteamGridDB: no match for "${game.name}"`] };
        byGame = `game/${id}`;
      }
      for (const kind of kinds) {
        const params = kind === 'grid' ? `dimensions=600x900&${SGDB_FILTER}` : SGDB_FILTER;
        const assets = await this.apiJson(`${SGDB_API}/${SGDB_TYPES[kind]}/${byGame}?${params}`, headers);
        const imageUrl = stringField(firstOf(assets), 'url');
        if (!imageUrl) {
          problems.push(`SteamGridDB: no ${kind}`);
          continue;
        }
        if (!isImageUrl(imageUrl)) {
          problems.push(`SteamGridDB ${kind}: the image is not on an artwork host`);
          continue;
        }
        try {
          found[kind] = { ...(await this.download(imageUrl)), source: 'steamgriddb' };
        } catch (err) {
          problems.push(`SteamGridDB ${kind}: ${errorText(err)}`);
        }
      }
    } catch (err) {
      problems.push(`SteamGridDB: ${errorText(err)}`);
    }
    return { found, problems };
  }

  /** GET a SteamGridDB endpoint and return its `data`. Throws with the API's own message on failure. */
  private async apiJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const res = await this.deps.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    if (res.status === 401 || res.status === 403) throw new ArtworkError('UNAUTHORIZED', 'the API key was rejected');
    if (res.status === 404) return [];
    if (res.status === 429) throw new ArtworkError('RATE_LIMITED', 'rate limited, try again later');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = ((await readJson(res)) ?? {}) as { success?: unknown; data?: unknown; errors?: unknown };
    if (body.success !== true) {
      throw new Error(Array.isArray(body.errors) ? body.errors.map(String).join(', ').slice(0, 200) : 'request failed');
    }
    return body.data;
  }

  /** Downloads an image without credentials and validates it. Redirects are followed by hand, a few at most, and only between the artwork hosts. */
  private async download(url: string): Promise<Download> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    for (let hops = 0, next = url; ; hops++) {
      if (!isImageUrl(next)) throw new Error(hops === 0 ? 'not an artwork host' : 'redirected away from the artwork hosts');
      res = await this.deps.fetch(next, { signal, redirect: 'manual' });
      if (!REDIRECT_STATUSES.has(res.status)) break;
      void res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location || !URL.canParse(location, next)) throw new Error(`HTTP ${res.status}`);
      if (hops >= MAX_IMAGE_REDIRECTS) throw new Error('too many redirects');
      next = new URL(location, next).toString();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) throw new Error(`not an image (${contentType || 'no content type'})`);
    const bytes = await readCapped(res, this.maxDownloadBytes);
    const ext = sniffImage(bytes);
    if (!ext) throw new Error('unrecognised image data');
    return { bytes, ext };
  }

  /** Writes via a temp file in the game's folder, renames into place, and removes stale variants of the same kind. */
  private store(gameId: string, kind: ArtworkKind, ext: ArtworkExt, write: (tmpPath: string) => void): string {
    const dir = join(this.deps.dir, gameId);
    mkdirSync(dir, { recursive: true });
    const finalName = artworkFileName(kind, ext);
    const tmp = join(dir, `${finalName}.${process.pid}.tmp`);
    try {
      write(tmp);
      renameSync(tmp, join(dir, finalName));
    } finally {
      rmSync(tmp, { force: true });
    }
    for (const name of readdirSync(dir)) {
      if (name !== finalName && name.startsWith(`${kind}.`) && !name.endsWith('.tmp')) rmSync(join(dir, name), { force: true });
    }
    return artworkRelPath(gameId, kind, ext);
  }
}

/** The Steam appid a game is known by without any lookup: its own id, or the launcher's known-id table. */
function steamAppIdFor(game: Game): string | null {
  if (game.launcher === 'steam') return game.launcherGameId;
  if (game.launcher === 'battlenet') return BATTLENET_PRODUCTS[game.launcherGameId]?.steamAppId ?? null;
  if (game.launcher === 'epic') return EPIC_STEAM_APP_IDS[game.launcherGameId] ?? null;
  return null;
}

/** Lowercase words only, so "Rocket League®" and "rocket league" compare equal but "Overwatch 2" and "Overwatch" do not. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isSource(value: string): value is ArtworkSource {
  return value === 'steamgriddb' || value === 'steamcdn' || value === 'manual' || value === 'launcher';
}

function fromRow(row: ArtworkRow | null): Found {
  if (!row || !isSource(row.source)) return {};
  const out: Found = {};
  if (row.grid_path) out.grid = { relPath: row.grid_path, source: row.source };
  if (row.hero_path) out.hero = { relPath: row.hero_path, source: row.source };
  if (row.logo_path) out.logo = { relPath: row.logo_path, source: row.source };
  return out;
}

function firstOf(data: unknown): Record<string, unknown> | null {
  const first = Array.isArray(data) ? (data[0] as unknown) : undefined;
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
}

function numberField(obj: Record<string, unknown> | null, key: string): number | null {
  const v = obj?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function stringField(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key];
  return typeof v === 'string' ? v : null;
}
