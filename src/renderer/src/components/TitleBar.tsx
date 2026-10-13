import { ipc, useIpcQuery } from '../lib/ipc';
import { BrandMark } from './BrandMark';

/**
 * The window's title bar. The whole strip is a drag region; Windows draws the caption buttons
 * on top of its right end (titleBarOverlay in main, one pixel shorter than the strip so the bottom border shows under the buttons).
 */
export function TitleBar() {
  const info = useIpcQuery(() => ipc.invoke('app:info'));
  const fake = info.data?.platformSource === 'fake';
  return (
    <header className="app-drag flex h-9 shrink-0 items-center gap-2 border-b border-border/50 bg-surface pl-3 select-none">
      <BrandMark className="size-4 text-accent" />
      <span className="text-xs font-semibold tracking-tight text-muted">One Launch</span>
      {fake ? (
        <span role="status" className="rounded bg-warning/20 px-1.5 py-px text-[10px] font-semibold tracking-wide text-warning uppercase">
          Fake launchers
        </span>
      ) : null}
    </header>
  );
}
