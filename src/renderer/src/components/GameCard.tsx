import { AlertTriangle, MoreHorizontal, Play } from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { LAUNCHER_DISPLAY_NAMES, type Game } from '@shared/models';
import { formatRelative } from '../lib/time';
import { LauncherDot } from './LauncherBadge';

interface GameCardProps {
  game: Game;
  onOpen: () => void;
  /** Opens the card menu at the given screen position. */
  onMenu: (x: number, y: number) => void;
}

/** Last played by whichever source is newer: the launcher's own record or a One Launch launch. */
export function lastPlayedOf(game: Game): string | null {
  const a = game.lastPlayedAt;
  const b = game.lastLaunch?.launchedAt ?? null;
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Up to two initials for the artless poster: "Counter-Strike 2" → "CS", "Hearthstone" → "H". */
function monogram(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function GameCard({ game, onOpen, onMenu }: GameCardProps) {
  const [loaded, setLoaded] = useState(false);
  const grid = game.artwork?.grid ?? null;
  /** The launcher's own icon stands in for a cover: a square mark on the poster background, with the name kept. */
  const icon = game.artwork?.source === 'launcher';
  const played = lastPlayedOf(game);

  function openMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (e.clientX === 0 && e.clientY === 0) {
      const r = e.currentTarget.getBoundingClientRect();
      onMenu(r.left, r.bottom + 4);
      return;
    }
    onMenu(e.clientX, e.clientY);
  }

  return (
    <div
      className="group relative overflow-hidden rounded-panel border border-border bg-surface text-left transition-colors duration-150 hover:border-border-strong focus-within:border-accent"
      onContextMenu={openMenu}
    >
      <button type="button" onClick={onOpen} className="block w-full text-left focus-visible:outline-none" aria-label={`Play ${game.name}`}>
        <div className="relative flex aspect-[2/3] items-end overflow-hidden bg-gradient-to-b from-surface-2 to-surface-3 p-3">
          {!grid || !loaded ? (
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center text-5xl font-semibold tracking-tight text-text-strong/10 select-none"
            >
              {monogram(game.name)}
            </span>
          ) : null}
          {!grid || !loaded || icon ? <span className="relative line-clamp-3 text-sm font-semibold text-text-strong">{game.name}</span> : null}
          {grid ? (
            <img
              key={grid}
              src={grid}
              alt=""
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setLoaded(false)}
              className={`absolute transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'} ${
                icon ? 'top-[22%] left-1/2 aspect-square w-1/2 -translate-x-1/2 object-contain drop-shadow-lg' : 'inset-0 size-full object-cover'
              }`}
            />
          ) : null}
          {game.needsUpdate ? (
            <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-md border border-warning/40 bg-bg/80 px-1.5 py-0.5 text-[11px] font-medium text-warning backdrop-blur">
              <AlertTriangle className="size-3" /> Update
            </span>
          ) : null}
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-gradient-to-t from-bg/80 to-transparent pt-10 pb-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            <span className="flex size-10 items-center justify-center rounded-full bg-accent text-white shadow [&>svg]:size-5">
              <Play />
            </span>
          </span>
        </div>
      </button>
      <button
        type="button"
        onClick={openMenu}
        aria-label={`More for ${game.name}`}
        className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-md border border-border bg-bg/80 text-muted opacity-0 backdrop-blur transition-opacity duration-150 group-hover:opacity-100 hover:text-text focus-visible:opacity-100 [&>svg]:size-4"
      >
        <MoreHorizontal />
      </button>
      <div className="flex flex-col gap-0.5 p-3">
        <div className="truncate text-sm font-medium text-text-strong" title={game.name}>
          {game.name}
        </div>
        <div className="flex items-center gap-1.5 truncate text-[11px] text-muted">
          <LauncherDot launcher={game.launcher} />
          <span className="truncate">
            {game.lastLaunch ? (game.lastLaunch.accountName ?? 'removed account') : LAUNCHER_DISPLAY_NAMES[game.launcher]}
            {played ? ` · ${formatRelative(played)}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
