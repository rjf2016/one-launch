import { ArrowDownUp, Clock, Filter, Gamepad2, ImagePlus, Images, RefreshCw, Search, SearchX, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LAUNCHER_DISPLAY_NAMES, LAUNCHER_IDS, type ArtworkSource, type ArtworkStatus, type Game, type LauncherId, type RecentLaunch } from '@shared/models';
import { Button } from '../components/Button';
import { CardMenu } from '../components/CardMenu';
import { EmptyState } from '../components/EmptyState';
import { Dropdown } from '../components/Dropdown';
import { GameCard, lastPlayedOf } from '../components/GameCard';
import { HScroller } from '../components/HScroller';
import { LauncherDot } from '../components/LauncherBadge';
import { Page } from '../components/Page';
import { PageHeader } from '../components/PageHeader';
import { ipc, useIpcQuery } from '../lib/ipc';
import { isShortcut } from '../lib/shortcuts';
import { formatRelative } from '../lib/time';
import { flashClassOf, useFlash } from '../lib/useFlash';
import { useUiStore } from '../store/ui';

type Sort = 'lastPlayed' | 'name';

const SORT_KEY = 'library.sort';

const ARTWORK_SOURCE_NAMES: Readonly<Record<ArtworkSource, string>> = {
  steamcdn: 'Steam',
  steamgriddb: 'SteamGridDB',
  manual: 'your image',
  launcher: "the game's own icon",
};

function readSort(): Sort {
  try {
    return window.localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'lastPlayed';
  } catch {
    return 'lastPlayed';
  }
}

interface Menu {
  game: Game;
  x: number;
  y: number;
}

export function LibraryView() {
  const games = useIpcQuery(() => ipc.invoke('library:list'));
  const recent = useIpcQuery(() => ipc.invoke('launch:recent', { limit: 8 }));
  const setView = useUiStore((s) => s.setView);
  const openLaunch = useUiStore((s) => s.openLaunch);
  const activeState = useUiStore((s) => s.activeLaunch?.job.state ?? null);
  const launcherStatus = useUiStore((s) => s.launcherStatus);
  const setLauncherStatus = useUiStore((s) => s.setLauncherStatus);
  const [scanning, setScanning] = useState(false);
  const [scannedNone, setScannedNone] = useState<boolean | null>(null);
  const [notice, setNotice] = useFlash();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LauncherId | null>(null);
  const [sort, setSort] = useState<Sort>(readSort);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [status, setStatus] = useState<ArtworkStatus | null>(null);
  const revision = useRef<number | null>(null);
  const lastActiveState = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const list = useMemo(() => games.data?.games ?? [], [games.data]);
  const libraryEmpty = !games.loading && games.error === null && list.length === 0;
  // Main's startup scan runs after the first paint; until it has finished an empty list says nothing.
  const scanned = status?.scanned ?? false;
  const hasGamesRef = useRef(false);
  useEffect(() => {
    hasGamesRef.current = list.length > 0;
  });
  const noLaunchers = scannedNone ?? (launcherStatus !== null && launcherStatus.every((l) => l.install === null));

  // The empty library says which launchers were found; the setup guide and Settings keep the same rows fresh.
  const needLauncherStatus = libraryEmpty && launcherStatus === null;
  useEffect(() => {
    if (!needLauncherStatus) return;
    let stopped = false;
    ipc
      .invoke('launchers:status')
      .then(({ launchers }) => {
        if (!stopped) setLauncherStatus(launchers);
      })
      .catch(() => {
        // the empty state keeps saying it is scanning; Settings › Launchers shows the error
      });
    return () => {
      stopped = true;
    };
  }, [needLauncherStatus, setLauncherStatus]);

  // A job that ran while this view was mounted or hidden changes the Recent strip and last-launch captions.
  useEffect(() => {
    if (lastActiveState.current === 'running' && activeState !== 'running') {
      games.reload();
      recent.reload();
    }
    lastActiveState.current = activeState;
  });

  async function rescan(): Promise<void> {
    setScanning(true);
    try {
      const { scanned } = await ipc.invoke('library:rescan');
      games.reload();
      const added = scanned.reduce((n, s) => n + s.added, 0);
      const removed = scanned.reduce((n, s) => n + s.removed, 0);
      const failed = scanned.filter((s) => s.error !== null);
      const none = scanned.length > 0 && scanned.every((s) => !s.installed);
      setScannedNone(none);
      if (failed.length > 0) {
        setNotice(failed.map((s) => `${LAUNCHER_DISPLAY_NAMES[s.launcher]}: ${s.error}`).join(' · '), 'error');
      } else if (none) {
        setNotice('No launchers found. Install Steam, Epic Games, Battle.net, or Riot Games, then rescan.', 'error');
      } else {
        setNotice(added || removed ? `${added} added, ${removed} removed` : 'Library is up to date', 'success');
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isShortcut(e, 'f')) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Background work (startup scan, artwork downloads, launches) shows up by polling the revision.
  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    const tick = async (): Promise<void> => {
      try {
        const { status } = await ipc.invoke('artwork:status');
        if (stopped) return;
        setStatus(status);
        if (revision.current !== null && revision.current !== status.revision) {
          games.reload();
          recent.reload();
        }
        revision.current = status.revision;
        // Until games are on screen the first scan is most likely still running (or the list has not loaded yet), so look again soon.
        timer = window.setTimeout(() => void tick(), status.queued + status.running > 0 ? 500 : hasGamesRef.current ? 4000 : 1000);
      } catch {
        if (!stopped) timer = window.setTimeout(() => void tick(), 3000);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  function changeSort(next: Sort): void {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_KEY, next);
    } catch {
      // per-viewer convenience only
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = list.filter((g) => (filter === null || g.launcher === filter) && (q === '' || g.name.toLowerCase().includes(q)));
    const byName = (a: Game, b: Game): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (sort === 'name') return filtered.sort(byName);
    return filtered.sort((a, b) => {
      const pa = lastPlayedOf(a);
      const pb = lastPlayedOf(b);
      if (pa && pb) return pb.localeCompare(pa) || byName(a, b);
      if (pa) return -1;
      if (pb) return 1;
      return byName(a, b);
    });
  }, [list, query, filter, sort]);

  async function refreshArtwork(game: Game): Promise<void> {
    setMenu(null);
    try {
      await ipc.invoke('artwork:refresh', { gameId: game.id, force: true });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  async function chooseImage(game: Game): Promise<void> {
    setMenu(null);
    try {
      const { game: updated } = await ipc.invoke('artwork:setManual', {
        gameId: game.id,
        kind: 'grid',
      });
      if (updated) games.reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  function openRecent(entry: RecentLaunch): void {
    const game = list.find((g) => g.id === entry.gameId);
    if (game) openLaunch({ game, initialAccountId: entry.accountId });
  }

  const artworkBusy = status ? status.queued + status.running : 0;
  const needKey = status !== null && !status.hasApiKey && artworkBusy === 0 && list.some((g) => !g.artwork && g.artworkError?.includes('SteamGridDB'));
  const recentList = recent.data?.recent ?? [];

  return (
    <Page>
      <PageHeader
        title="Library"
        subtitle="Installed games across your launchers. Pick a game, pick an account, play."
        actions={
          <>
            <span role="status" className={flashClassOf(notice)}>
              {notice?.text}
            </span>
            {artworkBusy > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                <Images className="size-3.5 animate-pulse" /> Fetching artwork ({artworkBusy})
              </span>
            ) : null}
            {needKey ? (
              <button
                type="button"
                onClick={() => setView('settings')}
                title="Games that are not on Steam get artwork from SteamGridDB, which needs a free API key. Add one in Settings."
                className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs whitespace-nowrap text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
              >
                <Images className="size-3.5" /> Artwork needs a SteamGridDB key
              </button>
            ) : null}
            <Button icon={<RefreshCw className={scanning ? 'animate-spin' : ''} />} disabled={scanning} onClick={() => void rescan()}>
              {scanning ? 'Scanning…' : 'Rescan'}
            </Button>
          </>
        }
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <label className="relative min-w-64 flex-1 basis-64 max-w-md">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
              <input
                ref={searchRef}
                type="text"
                placeholder="Search games (Ctrl+F)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) {
                    e.preventDefault();
                    setQuery('');
                  }
                }}
                disabled={list.length === 0}
                aria-label="Search games"
                className="w-full rounded-lg border border-border bg-surface py-1.5 pr-9 pl-9 text-sm text-text placeholder:text-faint transition-colors duration-150 hover:border-border-strong focus:border-accent focus:outline-none disabled:opacity-60 disabled:hover:border-border"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-faint hover:bg-surface-2 hover:text-text [&>svg]:size-3.5"
                >
                  <X />
                </button>
              ) : null}
            </label>
            <Dropdown
              className="shrink-0"
              caret={false}
              active={filter !== null}
              icon={<Filter />}
              label="Filter"
              triggerLabel="Filter"
              value={filter}
              disabled={list.length === 0}
              onChange={setFilter}
              onDeselect={() => setFilter(null)}
              options={LAUNCHER_IDS.map((id) => ({
                value: id,
                label: `${LAUNCHER_DISPLAY_NAMES[id]} (${list.filter((g) => g.launcher === id).length})`,
                icon: <LauncherDot launcher={id} />,
              }))}
            />
            <Dropdown
              className="shrink-0"
              caret={false}
              icon={<ArrowDownUp />}
              label="Sort"
              triggerLabel="Sort"
              value={sort}
              disabled={list.length === 0}
              onChange={changeSort}
              options={[
                { value: 'lastPlayed', label: 'Last played' },
                { value: 'name', label: 'Name' },
              ]}
            />
          </div>
        }
      />

      {menu ? (
        <CardMenu
          key={`${menu.game.id}:${menu.x}:${menu.y}`}
          x={menu.x}
          y={menu.y}
          title={menu.game.name}
          subtitle={menu.game.artwork ? `Artwork: ${ARTWORK_SOURCE_NAMES[menu.game.artwork.source]}` : (menu.game.artworkError ?? 'No artwork yet')}
          items={[
            { id: 'refresh', label: 'Refresh artwork', icon: <RefreshCw />, onSelect: () => void refreshArtwork(menu.game) },
            { id: 'choose', label: 'Choose portrait image…', icon: <ImagePlus />, onSelect: () => void chooseImage(menu.game) },
          ]}
          onClose={closeMenu}
        />
      ) : null}

      {games.error ? (
        <p className="text-sm text-danger">Could not load the library: {games.error}</p>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Gamepad2 />}
          title={scanning || games.loading || !scanned ? 'Scanning your launchers…' : noLaunchers ? 'No launchers found' : 'No games found'}
          description={
            noLaunchers
              ? 'One Launch looks for Steam, Epic Games Launcher, Battle.net, and the Riot Client. Install one of them, then rescan.'
              : 'Installed Steam, Epic, Battle.net, and Riot games appear here after a scan.'
          }
          action={
            <Button variant="primary" icon={<RefreshCw />} disabled={scanning || !scanned} onClick={() => void rescan()}>
              Scan now
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-5 pb-6">
          {recentList.length > 0 && query === '' && filter === null ? (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
                <Clock className="size-3.5" /> Recent
              </h2>
              <HScroller className="flex gap-2 pb-1">
                {recentList.map((r) => {
                  const game = list.find((g) => g.id === r.gameId);
                  if (!game) return null;
                  const grid = game.artwork?.grid;
                  return (
                    <button
                      key={`${r.gameId}:${r.accountId}`}
                      type="button"
                      onClick={() => openRecent(r)}
                      title={`Play ${r.gameName} as ${r.accountName}`}
                      className="flex w-60 shrink-0 items-center gap-3 rounded-lg border border-border bg-surface py-1.5 pr-3 pl-1.5 text-left transition-colors duration-150 hover:border-border-strong focus-visible:border-accent focus-visible:outline-none"
                    >
                      <span className="flex h-12 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-3">
                        {grid ? <img src={grid} alt="" draggable={false} className="size-full object-cover" /> : <LauncherDot launcher={r.launcher} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-text-strong">{r.gameName}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {r.accountName} · {formatRelative(r.launchedAt)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </HScroller>
            </section>
          ) : null}

          {visible.length === 0 ? (
            <EmptyState
              icon={<SearchX />}
              title={query.trim() ? `No games match “${query.trim()}”` : `No ${filter ? LAUNCHER_DISPLAY_NAMES[filter] : ''} games installed`}
              description={
                filter
                  ? `Only ${LAUNCHER_DISPLAY_NAMES[filter]} games are shown. Clear the filter to search every launcher.`
                  : 'Try a shorter name, or rescan if the game was installed after the last scan.'
              }
              action={
                <Button
                  icon={<X />}
                  onClick={() => {
                    setQuery('');
                    setFilter(null);
                  }}
                >
                  Clear search and filters
                </Button>
              }
            />
          ) : (
            // auto-rows-max: with overflow-hidden cards, auto rows would be squeezed to fit the scroll container instead of growing.
            <div className="grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(160px,1fr))] content-start gap-4 2xl:grid-cols-[repeat(auto-fill,minmax(190px,1fr))] 2xl:gap-5">
              {visible.map((g) => (
                <GameCard key={g.id} game={g} onOpen={() => openLaunch({ game: g, initialAccountId: null })} onMenu={(x, y) => setMenu({ game: g, x, y })} />
              ))}
            </div>
          )}
        </div>
      )}
    </Page>
  );
}
