import { useEffect } from 'react';
import type { UpdateStatus } from '@shared/models';
import { useUiStore } from '../store/ui';
import { ipc } from './ipc';

const BUSY_POLL_MS = 1000;

export function isUpdateBusy(status: UpdateStatus | null): boolean {
  return status?.state === 'checking' || status?.state === 'downloading';
}

/** The updater's state from main, polled every second while it checks or downloads and every `idleMs` otherwise (never, when null). */
export function useUpdateStatus(idleMs: number | null): UpdateStatus | null {
  const status = useUiStore((s) => s.updateStatus);
  const setStatus = useUiStore((s) => s.setUpdateStatus);
  const busy = isUpdateBusy(status);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const next = await ipc.invoke('updates:status');
        if (!cancelled) setStatus(next);
      } catch {
        // the next poll tries again
      }
    };
    void load();
    const delay = busy ? BUSY_POLL_MS : idleMs;
    const timer = delay === null ? undefined : window.setInterval(() => void load(), delay);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busy, idleMs, setStatus]);
  return status;
}

/** Quits into the verified installer, after the current view has had its say about unsaved edits. False when the user stayed. */
export async function restartToUpdate(): Promise<boolean> {
  const guard = useUiStore.getState().leaveGuard;
  if (guard && !(await guard())) return false;
  await ipc.invoke('updates:install');
  return true;
}
