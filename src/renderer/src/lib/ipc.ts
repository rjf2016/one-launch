import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcClient } from '@shared/ipc-contract';

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
  const envelope = (await bridge.invoke(channel, req)) as Awaited<ReturnType<typeof window.oneLaunch.invoke>>;
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

/** Minimal async query hook. Re-runs when `deps` change; ignores stale results. A new run drops the last run's error, so it never sits next to data it does not describe. */
export function useIpcQuery<T>(fetcher: () => Promise<T>, deps: readonly unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
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
