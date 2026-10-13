# Artwork

`src/main/services/artwork.ts` (`ArtworkService`) is one of the two pieces of code that talk to the network; the other is the updater (`src/main/updates/engine.ts`, see `architecture.md` › Updates). The global `fetch` is injected into it from `src/main/index.ts` and called nowhere else; the protocol handler's `net.fetch` only reads local `file://` URLs, and the renderer's CSP has `connect-src 'none'`. Only game names and Steam/SteamGridDB ids leave the machine, never account data. Keep it that way.

## Sources, in order (per game, `process`)

1. Steam appid without a lookup (`steamAppIdFor`): Steam games use their own id; Battle.net uses `steamAppId` in `launchers/battlenet/products.ts`; Epic uses `EPIC_STEAM_APP_IDS` in `launchers/epic/steam-ids.ts`, only for games delisted from the Steam store (search cannot find them).
2. Otherwise, for non-Steam games: Steam store search, then Steam community search. A result is accepted only on an exact normalised name match (case, punctuation, trademark marks ignored) with a numeric id (a loose match puts the wrong cover on the card).
3. With an appid: Steam CDN for each missing kind (`library_600x900.jpg`, `library_hero.jpg`, `logo.png`), trying the second CDN host on a 404. No key needed.
4. Whatever is still missing: SteamGridDB, only when a key is stored, by Steam appid or else by name autocomplete. The key is read from the vault per job and sent only as `Authorization: Bearer`; never logged. 401/403 → `UNAUTHORIZED`, 429 → `RATE_LIMITED`, recorded as the game's error. An image URL it names is fetched only when it is on `cdn2.steamgriddb.com`.
5. Still no grid: the launcher's own icon for the game (`deps.launcherIcon`, `LauncherService.gameIcon`, the adapter's optional `gameIcon`; only Riot has one, `adapters/riot.md` › Artwork) is read from disk (`readLauncherBytes`, sniffed as an image or a Windows icon), stored as the grid with `source = 'launcher'`, and shown as a mark on the poster background with the name kept (`GameCard`). It is a stand-in: the miss stays on record (`artwork_attempts`, "No cover found online; showing the game’s own icon"), `enqueueMissing` still counts the game as missing, and the next lookup (after the retry window, a refresh, or a key added) asks online again and replaces it when a cover turns up. A manual image wins over it like over anything else. No network.

All requests are `GET` with a 15 s timeout. Downloads must be `ok`, `content-type: image/*`, at most 10 MiB (declared and actual), and sniff as JPEG, PNG, or WebP by magic bytes (`sniffImage`); `.ico` is accepted only from a launcher's icon (`sniffIcon`).

Limits on what a server can make the app do:

- Lookups (Steam search, SteamGridDB) are sent with `redirect: 'error'`, so the key never follows a redirect, and their JSON is read up to 1 MiB.
- Images come only from `IMAGE_HOSTS`, over https on the default port: the two Steam CDN hosts, `shared.steamstatic.com` (the second CDN host redirects there), and `cdn2.steamgriddb.com`. Redirects are followed by hand, at most three, each checked against the same list, so no answer can send a request to another site, the LAN, or loopback.
- Every body is read through `readCapped`, which drops the connection at the limit instead of buffering first.

## Queue and caching

- Concurrency 2. `enqueueMissing` queues installed games without a grid image on disk (a launcher's icon standing in counts as none), skipping games whose last miss is under 7 days old. A miss is stored in `artwork_attempts` (at most 500 chars).
- Entry points: `enqueueAfterScan` (after every library scan, only when auto-fetch is on), `refresh(gameId | null, force)` from the card menu and Settings (runs whatever the setting says, since the user asked). Forced single-game refresh replaces a manual image; forced refresh-all leaves manual images alone. A forced request arriving while an unforced job for that game runs is queued to run after it.
- A job holds its downloads, and the launcher's icon, in memory and writes nothing until after its last await. It then drops everything if the service was stopped (quit) or the user picked a manual image meanwhile (`manualPicks`), since the pick is the later instruction.
- `store` writes `<kind>.<ext>.<pid>.tmp`, renames it into `artwork\<game uuid>\<kind>.<ext>`, and deletes other extensions of the same kind. The DB holds the relative path in `artwork.grid_path` / `hero_path` / `logo_path`.
- `prune()` runs after every scan: removes folders and `artwork` / `artwork_attempts` rows for games that are not installed, unless queued or running.
- Manual override (`artwork:setManual`): main's native picker, at most 20 MiB, sniffed, stored with `source = 'manual'`. No network.
- Every commit or recorded miss bumps the library `revision`; the renderer polls `artwork:status` and reloads the library when it moves.

## The `onelaunch-art:` scheme

Registered as privileged before `ready`, handled in `index.ts`. `LibraryService` gives the renderer `onelaunch-art://art/<uuid>/<kind>.<ext>?v=<fetchedAt>`. `resolveArtworkPath` (`artwork-url.ts`) accepts only host `art`, exactly two path segments, a UUID, and `(grid|hero|logo).(jpg|png|webp|ico)`, and checks the resolved path stays inside the artwork folder; anything else is a 404. Chromium renders an `.ico` in an `<img>` from its largest frame. Responses carry `cache-control: max-age=31536000, immutable`, which is safe because `?v=` changes on every commit.

## Default: on, no consent gate

- `artwork.autoFetch` is read as `settings.getBool('artwork.autoFetch', true)`: unset means on, so the first scan after install fetches covers. Deliberate: names and store ids are not sensitive enough to hold covers back. Do not add a consent question or a main-side refusal.
- Off (Settings › Artwork): nothing is fetched after scans; manual refreshes still run. `settings:set` turning it from `false` to `true` starts the lookup immediately.
- Deleting the SteamGridDB key stops all SteamGridDB traffic; Steam needs no key.

## Setup guide

The setup guide (renderer, `SetupGuideSteps.tsx`) opens on a new install and carries the artwork notice on its launchers step, under the installed-game count. It is a notice, not a question: it says covers are downloaded from Steam's store and image servers (and SteamGridDB with a key), that only game names and store ids are sent, and where to turn it off; with auto-fetch off it says downloads are off instead. Leaving the guide writes only `firstRun.dismissed`.
