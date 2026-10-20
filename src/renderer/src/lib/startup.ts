import {
  STARTUP_REQUESTS,
  type IpcChannel,
  type IpcEnvelope,
  type IpcRequest,
  type IpcResponse,
  type OneLaunchApi,
  type StartupChannel,
} from '@shared/ipc-contract';

/** A one-time User Timing mark for the startup-timing scenario; a no-op where the API is missing. StrictMode's doubled effects would otherwise mark twice. */
export function markOnce(name: string): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  if (performance.getEntriesByName(name).length > 0) return;
  performance.mark(name);
}

interface Entry {
  req: unknown;
  promise: Promise<IpcEnvelope<unknown>>;
  result: IpcEnvelope<unknown> | null;
}

/** The startup window's answers; null before the prefetch, in tests without one, and once App's first effect has closed it. */
let entries: Map<string, Entry> | null = null;

const sameReq = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const failed = (err: unknown): IpcEnvelope<unknown> => ({
  ok: false,
  error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
});

type Bridge = Pick<OneLaunchApi, 'invoke'> & Partial<Pick<OneLaunchApi, 'startup'>>;

/**
 * Opens the startup window: the preload's answers when the bridge has them (requests sent at document start), else the
 * same requests sent now. Resolves once every answer is in, or after `capMs`, so a slow main never holds back the first paint.
 */
export function prefetchStartup(bridge: Bridge | undefined, capMs: number): Promise<void> {
  if (!bridge) return Promise.resolve();
  const raw = bridge.invoke as unknown as (channel: string, req?: unknown) => Promise<IpcEnvelope<unknown>>;
  const early = bridge.startup as unknown as ((channel: string) => Promise<IpcEnvelope<unknown>>) | undefined;
  const map = new Map<string, Entry>();
  const settled: Promise<void>[] = [];
  for (const [channel, req] of Object.entries(STARTUP_REQUESTS)) {
    const answer = early ? early(channel) : raw(channel, req);
    const entry: Entry = { req, promise: answer.catch(failed), result: null };
    settled.push(
      entry.promise.then((r) => {
        entry.result = r;
      }),
    );
    map.set(channel, entry);
  }
  entries = map;
  const all = Promise.all(settled).then(() => undefined);
  const cap = new Promise<void>((resolve) => setTimeout(resolve, capMs));
  return Promise.race([all, cap]).then(() => markOnce('startup:prefetched'));
}

/** A startup answer that has arrived, while the window is open. A failure or another request is undefined, and the caller fetches as usual. */
export function peekStartup<K extends StartupChannel>(channel: K, req?: IpcRequest<K>): IpcResponse<K> | undefined {
  const e = entries?.get(channel);
  if (!e || !e.result || !e.result.ok || !sameReq(e.req, req)) return undefined;
  return e.result.data as IpcResponse<K>;
}

/** The startup call for the channel, in flight or settled, so an invoke during the window joins it instead of asking main again. */
export function pendingStartup(channel: IpcChannel, req: unknown): Promise<IpcEnvelope<unknown>> | undefined {
  const e = entries?.get(channel);
  return e && sameReq(e.req, req) ? e.promise : undefined;
}

/** Ends the window: from here on every mount asks main for fresh data. App calls it from its first effect. */
export function closeStartup(): void {
  entries = null;
}
