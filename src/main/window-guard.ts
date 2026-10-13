import type { Rectangle } from 'electron';

/**
 * Whether `url` is our own renderer page: the packaged index.html (plus its hash or query) and never
 * any other file:// URL; in development, the dev server's origin and nothing that merely starts with it.
 */
export function isTrustedRendererUrl(url: string | undefined, opts: { rendererFileUrl: string; devUrl: string | null }): boolean {
  if (!url) return false;
  if (opts.devUrl) {
    try {
      return new URL(url).origin === new URL(opts.devUrl).origin;
    } catch {
      return false;
    }
  }
  return url === opts.rendererFileUrl || url.startsWith(`${opts.rendererFileUrl}#`) || url.startsWith(`${opts.rendererFileUrl}?`);
}

export const MIN_WINDOW = { width: 960, height: 600 } as const;

/**
 * What a close request on the main window (the caption button, Alt+F4, or app.quit) does. A quit that is already
 * under way always closes; otherwise the tray keeps the app, when it is on, and a running switch is asked about.
 */
export function closeRequestAction(state: { quitting: boolean; closeToTray: boolean; switchBusy: boolean }): 'close' | 'hide' | 'ask' {
  if (state.quitting) return 'close';
  if (state.closeToTray) return 'hide';
  return state.switchBusy ? 'ask' : 'close';
}

/** The stored window placement (the `window.bounds` setting), when it still lands on one of the connected displays' work areas. */
export function placementFrom(raw: string | null, workAreas: readonly Rectangle[]): { bounds: Rectangle | null; maximized: boolean } {
  if (!raw) return { bounds: null, maximized: false };
  try {
    const v = JSON.parse(raw) as Partial<Rectangle & { maximized: boolean }>;
    const bounds = [v.x, v.y, v.width, v.height].every((n) => typeof n === 'number' && Number.isFinite(n))
      ? { x: v.x as number, y: v.y as number, width: Math.max(MIN_WINDOW.width, v.width as number), height: Math.max(MIN_WINDOW.height, v.height as number) }
      : null;
    // Enough of the title bar has to be on a screen to grab it: 64 px sideways, and the top edge inside the work area.
    const onScreen =
      bounds !== null &&
      workAreas.some((a) => bounds.x < a.x + a.width - 64 && bounds.x + bounds.width > a.x + 64 && bounds.y >= a.y - 8 && bounds.y < a.y + a.height - 64);
    return { bounds: onScreen ? bounds : null, maximized: v.maximized === true };
  } catch {
    return { bounds: null, maximized: false };
  }
}
