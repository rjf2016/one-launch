import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcChannel, IpcClient } from '@shared/ipc-contract';
import { pendingStartup } from './startup';

/** A failed IPC call. `code` is stable and safe to branch on; `message` is for display. */
export class IpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

const invoke = async (channel: string, req?: unknown): Promise<unknown> => {
  // The preload bridge is typed; this shim only exists to unwrap the envelope generically.
  const bridge = window.oneLaunch as unknown as { invoke(c: string, r?: unknown): Promise<unknown> };
  // During the startup window a call for an answer already on its way joins it instead of asking main twice.
  const envelope = (await (pendingStartup(channel as IpcChannel, req) ?? bridge.invoke(channel, req))) as Awaited<ReturnType<typeof window.oneLaunch.invoke>>;
  if (envelope.ok) return envelope.data;
  throw new IpcError(envelope.error.code, envelope.error.message);
};

/** Typed access to the main process. The only way the renderer reaches privileged code. */
export const ipc: IpcClient = { invoke: invoke as IpcClient['invoke'] };

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Minimal async query hook. Re-runs when `deps` change; ignores stale results. A new run drops the last run's error, so it never
 * sits next to data it does not describe. `seed` is read once at mount: a startup answer that is already in (lib/startup.ts) becomes
 * the first render's data and the first fetch is skipped; reloads and dep changes always fetch.
 */
export function useIpcQuery<T>(fetcher: () => Promise<T>, deps: readonly unknown[] = [], seed?: () => T | undefined): QueryState<T> {
  const [data, setData] = useState<T | null>(() => seed?.() ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(data === null);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const seeded = useRef(data !== null);

  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    fetcher()
      .then((result) => {
        if (latest.current !== id) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (latest.current !== id) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (latest.current === id) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
