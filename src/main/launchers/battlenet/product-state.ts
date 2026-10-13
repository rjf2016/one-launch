/**
 * What the client's log says about its products (docs/adapters/battlenet.md, "Library" and "Launch"):
 * whether a product needs an update before it can run, whether a launch command made it start, and
 * whether its game is running already. Built on the events client-log.ts parses.
 */

import type { LogEvent } from './client-log';

export interface ProductState {
  /** `UpToDate`, `Update`, or another operation the client is on. */
  operation: string | null;
  status: string | null;
  /** The product's own playable flag; absent on the cached state of some products. */
  playable: boolean | null;
}

/** The client's last reported install state per product codename. The cached state at start is followed by a refreshed one when the CDN says otherwise. */
export function productStates(events: readonly LogEvent[]): Map<string, ProductState> {
  const out = new Map<string, ProductState>();
  for (const e of events) if (e.kind === 'product-state') out.set(e.codename, { operation: e.operation, status: e.status, playable: e.playable });
  return out;
}

/** The client wants to update the product before it runs: its Play button reads Update, and --exec for it does nothing. */
export function productNeedsUpdate(state: ProductState | undefined): boolean {
  return state?.operation?.toLowerCase() === 'update';
}

/** The client started the product's game process; builds before 2.52.12 only acknowledged the launch request for its program code. */
export function gameStarted(events: readonly LogEvent[], codename: string, programCode: string): boolean {
  return events.some(
    (e) =>
      ((e.kind === 'game-launching' || e.kind === 'game-running') && e.codename.toLowerCase() === codename.toLowerCase()) ||
      (e.kind === 'launch-request' && e.code.toLowerCase() === programCode.toLowerCase()),
  );
}

/** The client's last word on the game's process, whoever started it: seen launching or running, and its end not logged since. */
export function gameRunning(events: readonly LogEvent[], codename: string): boolean {
  const code = codename.toLowerCase();
  let running = false;
  for (const e of events) {
    if (e.kind !== 'game-launching' && e.kind !== 'game-running' && e.kind !== 'game-exited') continue;
    if (e.codename.toLowerCase() === code) running = e.kind !== 'game-exited';
  }
  return running;
}
