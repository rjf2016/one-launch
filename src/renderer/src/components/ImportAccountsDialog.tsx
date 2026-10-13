import { Check, Download, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LAUNCHER_DISPLAY_NAMES, type Account, type LauncherId, type RememberedAccount } from '@shared/models';
import { useFocusTrap, useFocusWhenReady } from '../lib/useFocusTrap';
import { ipc, IpcError, useIpcQuery } from '../lib/ipc';
import { formatRelative } from '../lib/time';
import { Button } from './Button';
import { StatusPill } from './StatusPill';

interface ImportAccountsDialogProps {
  /** Which launcher's remembered list to read: Steam (loginusers.vdf) or Battle.net (saved account names). */
  launcher: Extract<LauncherId, 'steam' | 'battlenet'>;
  onClose: () => void;
  /** Called after a successful import with the accounts created or linked. */
  onImported: (accounts: Account[]) => void;
}

/** What identifies an entry: the launcher's account id, or the login for launchers that record none. */
function keyOf(entry: RememberedAccount): string {
  return entry.launcherUid || entry.login;
}

function RememberedRow({ entry, checked, onToggle }: { entry: RememberedAccount; checked: boolean; onToggle: () => void }) {
  const linked = entry.linkedAccountId !== null;
  return (
    <label
      className={`flex items-center gap-3 px-4 py-2.5 not-last:border-b not-last:border-border/60 ${
        linked ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-surface-2/60'
      }`}
    >
      <input type="checkbox" className="size-4 accent-accent" checked={checked} disabled={linked} onChange={onToggle} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text-strong">{entry.personaName || entry.login}</span>
          {entry.mostRecent ? <StatusPill tone="ok">Signed in</StatusPill> : null}
          {linked ? <StatusPill tone="info">Already in One Launch</StatusPill> : null}
          {!entry.rememberPassword ? (
            <StatusPill tone="warn">Remember me off</StatusPill>
          ) : entry.sessionMayBeExpired ? (
            <StatusPill tone="warn">Session may have expired</StatusPill>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
          <span className="truncate">{entry.login}</span>
          {entry.launcherUid ? (
            <>
              <span className="text-faint">·</span>
              <span className="font-mono text-faint">{entry.launcherUid}</span>
            </>
          ) : null}
          {entry.lastLoginAt ? (
            <>
              <span className="text-faint">·</span>
              <span className="text-faint">last sign-in {formatRelative(entry.lastLoginAt)}</span>
            </>
          ) : null}
        </div>
      </div>
    </label>
  );
}

const COPY = {
  steam: {
    title: 'Import Steam accounts',
    subtitle: 'Accounts Steam remembers on this PC. Only names and SteamIDs are imported.',
    reading: 'Reading loginusers.vdf…',
    empty: 'Steam has not remembered any account on this PC yet.',
  },
  battlenet: {
    title: 'Import Battle.net accounts',
    subtitle:
      "Logins in the client's saved-accounts list (Battle.net.config). Only the logins are imported; the account id is learned at the first confirmed sign-in.",
    reading: 'Reading Battle.net.config…',
    empty: 'Battle.net has no saved account names on this PC yet.',
  },
} as const;

/**
 * Imports the accounts a launcher remembers (Steam: loginusers.vdf; Battle.net: SavedAccountNames)
 * as One Launch accounts. Names and IDs only; passwords are added by the user later, on the account page.
 */
export function ImportAccountsDialog({ launcher, onClose, onImported }: ImportAccountsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef);
  const copy = COPY[launcher];
  const remembered = useIpcQuery(() => ipc.invoke('launchers:rememberedAccounts', { launcher }));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entries = remembered.data?.accounts ?? [];
  const importable = entries.filter((e) => e.linkedAccountId === null);
  useFocusWhenReady(!remembered.loading && (importable.length === 0 || selected.size > 0), dialogRef, closeRef, selected.size > 0 ? primaryRef : cancelRef);

  useEffect(() => {
    setSelected(new Set(importable.map(keyOf)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remembered.data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggle(uid: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  async function runImport(): Promise<void> {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await ipc.invoke('launchers:importAccounts', {
        launcher,
        launcherUids: [...selected],
      });
      onImported(result.accounts);
    } catch (err) {
      setError(err instanceof IpcError ? err.message : err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-x-0 top-9 bottom-0 z-30 flex items-center justify-center bg-bg/70 p-6" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 id="import-title" className="text-sm font-semibold text-text-strong">
              {copy.title}
            </h2>
            <p className="mt-0.5 text-xs text-muted">{copy.subtitle}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted hover:text-text [&>svg]:size-4">
            <X />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {remembered.error ? (
            <p className="px-5 py-6 text-sm text-danger">
              Could not read {LAUNCHER_DISPLAY_NAMES[launcher]}'s remembered accounts: {remembered.error}
            </p>
          ) : remembered.loading ? (
            <p className="px-5 py-6 text-sm text-muted">{copy.reading}</p>
          ) : entries.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">{copy.empty}</p>
          ) : (
            entries.map((e) => <RememberedRow key={keyOf(e)} entry={e} checked={selected.has(keyOf(e))} onToggle={() => toggle(keyOf(e))} />)
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <div className="text-xs text-muted">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : importable.length === 0 && entries.length > 0 ? (
              'Everything here is already in One Launch.'
            ) : (
              `${selected.size} selected`
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button ref={cancelRef} variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              ref={primaryRef}
              variant="primary"
              icon={busy ? <Check /> : <Download />}
              disabled={busy || selected.size === 0}
              onClick={() => void runImport()}
            >
              {busy ? 'Importing…' : `Import ${selected.size || ''}`.trim()}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
