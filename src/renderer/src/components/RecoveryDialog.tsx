import { AlertTriangle, Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LAUNCHER_DISPLAY_NAMES, type SwitchRecovery } from '@shared/models';
import { ipc, IpcError } from '../lib/ipc';
import { recoveryCopy } from '../lib/recovery';
import { peekStartup } from '../lib/startup';
import { formatRelative } from '../lib/time';
import { useFocusTrap } from '../lib/useFocusTrap';
import { Button } from './Button';

function errorMessage(err: unknown): string {
  if (err instanceof IpcError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

type Stage = { kind: 'ask' } | { kind: 'restoring' } | { kind: 'restored' } | { kind: 'error'; message: string };

function RecoveryDialog({ recovery, onDone }: { recovery: SwitchRecovery; onDone: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'ask' });
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  const launcherName = LAUNCHER_DISPLAY_NAMES[recovery.launcher];
  const copy = recoveryCopy(recovery, launcherName);
  const busy = stage.kind === 'restoring';

  async function restore(): Promise<void> {
    setStage({ kind: 'restoring' });
    try {
      await ipc.invoke('recovery:restore');
      setStage({ kind: 'restored' });
    } catch (err) {
      setStage({ kind: 'error', message: errorMessage(err) });
    }
  }

  async function keep(): Promise<void> {
    try {
      await ipc.invoke('recovery:dismiss');
    } finally {
      onDone();
    }
  }

  return (
    <div className="fixed inset-x-0 top-9 bottom-0 z-50 flex items-center justify-center bg-bg/70 p-6" role="presentation">
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
        className="w-full max-w-lg rounded-panel border border-border bg-surface shadow-panel"
      >
        <div className="flex items-start gap-3 px-5 py-4">
          {stage.kind === 'restored' ? (
            <Check className="mt-0.5 size-5 shrink-0 text-success" />
          ) : (
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
          )}
          <div className="min-w-0">
            <h2 id="recovery-title" className="text-sm font-semibold text-text-strong">
              {stage.kind === 'restored' ? `${launcherName} was put back the way it was` : copy.title}
            </h2>
            {stage.kind === 'restored' ? (
              <p className="mt-1 text-sm text-muted">Start {launcherName} to check which account it signs in as.</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-muted">{copy.body}</p>
                <p className="mt-2 text-xs text-faint">
                  Started {formatRelative(recovery.startedAt)}. Snapshot <span className="font-mono">{recovery.backupId}</span>
                  {recovery.snapshotAvailable ? `. ${launcherName} has to be closed for a restore.` : '.'}
                </p>
              </>
            )}
            {stage.kind === 'error' ? <p className="mt-2 text-sm text-danger">{stage.message}</p> : null}
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          {stage.kind === 'restored' ? (
            <Button variant="primary" autoFocus onClick={onDone}>
              Done
            </Button>
          ) : recovery.snapshotAvailable ? (
            <>
              <Button
                variant={copy.recommend === 'keep' ? 'primary' : 'ghost'}
                autoFocus={copy.recommend === 'keep'}
                disabled={busy}
                onClick={() => void keep()}
              >
                Keep as is
              </Button>
              <Button
                variant={copy.recommend === 'restore' ? 'primary' : 'ghost'}
                autoFocus={copy.recommend === 'restore'}
                disabled={busy}
                onClick={() => void restore()}
              >
                {busy ? 'Restoring…' : stage.kind === 'error' ? 'Try the restore again' : 'Restore snapshot'}
              </Button>
            </>
          ) : (
            <Button variant="primary" autoFocus onClick={() => void keep()}>
              OK
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

/** Asks main once, at startup, whether the last run ended during a switch, and puts the question in front of everything else. */
export function RecoveryHost() {
  const [seed] = useState(() => peekStartup('recovery:get'));
  const [recovery, setRecovery] = useState<SwitchRecovery | null>(seed ? seed.recovery : null);

  useEffect(() => {
    if (seed) return;
    let cancelled = false;
    ipc
      .invoke('recovery:get')
      .then((r) => {
        if (!cancelled) setRecovery(r.recovery);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [seed]);

  return recovery ? <RecoveryDialog recovery={recovery} onDone={() => setRecovery(null)} /> : null;
}
