import { AlertTriangle, Check, RefreshCw, Save, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Account, LauncherId, LauncherSession, LauncherSessionState } from '@shared/models';
import { ipc, IpcError, useIpcQuery } from '../lib/ipc';
import { sentence } from '../lib/phases';
import { formatRelative } from '../lib/time';
import { Button } from './Button';
import { Panel, Row } from './Panel';

function errorMessage(err: unknown): string {
  if (err instanceof IpcError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

interface DiskState {
  text: string;
  tone: 'ok' | 'warn' | 'muted';
  hint?: string;
}

/** Who the launcher is signed in as, for the account whose page this is. */
function describeState(state: LauncherSessionState, account: Account, session: LauncherSession | null): DiskState {
  if (!state.remembered) return { text: 'Nobody', tone: 'muted' };
  if (state.linkedAccountId === account.id) {
    const current = session !== null && state.fingerprint === session.fingerprint;
    return { text: current ? 'This account' : 'This account (newer than the saved sign-in; press Save again)', tone: 'ok' };
  }
  if (state.linkedAccountId) return { text: 'Another of your accounts', tone: 'muted' };
  return { text: 'An account not yet linked in One Launch', tone: 'muted', hint: 'If that is this account, press Save sign-in.' };
}

/** One line: what the panel holds and when it fills itself. The hand-over and the create form say what to tick; not here. */
const DESCRIPTION = 'Saved the first time you play on this account, and put back whenever you switch to it.';

const COPY: Partial<Record<LauncherId, { launcherName: string }>> = {
  epic: { launcherName: 'Epic Games Launcher' },
  battlenet: { launcherName: 'Battle.net' },
  riot: { launcherName: 'Riot Client' },
};

/** Launchers that sign in from a remembered session One Launch can save, so the account page shows this panel. */
export function hasSessionPanel(launcher: LauncherId): boolean {
  return launcher in COPY;
}

/**
 * Launchers without a native account list (Epic, Battle.net, Riot) sign in from a remembered-session
 * blob. The first Play on the account saves it by itself; this panel shows the copy One Launch keeps for
 * the account (never the blob itself), who the launcher is signed in as right now, and lets the user save
 * the sign-in ahead of time or forget the copy.
 */
export function SessionPanel({ account, onAccountChanged }: { account: Account; onAccountChanged: (a: Account) => void }) {
  const copy = COPY[account.launcher] ?? { launcherName: account.launcher };
  const query = useIpcQuery(() => ipc.invoke('sessions:get', { accountId: account.id }), [account.id, account.updatedAt]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const session = query.data?.session ?? null;
  const state = query.data?.state ?? null;

  async function capture(): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await ipc.invoke('sessions:capture', { accountId: account.id });
      onAccountChanged(result.account);
      setNote('Sign-in saved');
      query.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function forget(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await ipc.invoke('sessions:forget', { accountId: account.id });
      setConfirmForget(false);
      setNote('Saved sign-in removed');
      query.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const disk = state ? describeState(state, account, session) : null;
  const nothingToSave = state !== null && !state.remembered;
  const signedInHint = [state?.launcherRunning ? `${copy.launcherName} is running.` : null, disk?.hint ?? null].filter((h) => h !== null).join(' ');
  const firstLoad = query.data === null && query.error === null;
  // A blank line holds the hint's place until the session loads, so the panel does not jump when the hint arrives.
  const savedHint = session
    ? session.verifiedAt
      ? `Last used for a switch ${formatRelative(session.verifiedAt)}.`
      : 'Not used for a switch yet.'
    : firstLoad && account.hasSession
      ? ' '
      : null;

  return (
    <Panel
      title="Saved sign-in"
      description={DESCRIPTION}
      actions={
        <>
          <Button icon={<RefreshCw className={query.loading ? 'animate-spin' : ''} />} disabled={query.loading || busy} onClick={query.reload}>
            Re-check
          </Button>
          <Button
            variant="primary"
            icon={<Save />}
            disabled={busy || !state?.remembered}
            {...(nothingToSave ? { title: `Nothing to save: ${copy.launcherName} holds no sign-in right now.` } : {})}
            onClick={() => void capture()}
          >
            {busy ? 'Saving…' : session ? 'Save again' : 'Save sign-in'}
          </Button>
        </>
      }
    >
      <Row label="Saved sign-in" {...(savedHint ? { hint: savedHint } : {})}>
        {session ? (
          <span className={`inline-flex items-center gap-1.5 ${session.staleReason ? 'text-warning' : 'text-success'}`}>
            {session.staleReason ? <AlertTriangle className="size-4" /> : <ShieldCheck className="size-4" />}
            {session.staleReason ? 'Saved, but needs a fresh sign-in' : `Saved ${formatRelative(session.capturedAt)}`}
          </span>
        ) : firstLoad && account.hasSession ? (
          'Checking…'
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <ShieldOff className="size-4" /> Not saved yet
          </span>
        )}
      </Row>
      {session?.staleReason ? (
        <Row label="Why" hint={`Sign in to ${copy.launcherName} once by hand; the next switch saves the fresh sign-in on its own.`}>
          <span className="text-xs text-warning">{session.staleReason}</span>
        </Row>
      ) : null}
      <Row label={`${copy.launcherName} is signed in as`} {...(signedInHint ? { hint: signedInHint } : {})}>
        {query.error || query.data?.stateError ? (
          <span className="text-danger">{query.error ?? query.data?.stateError}</span>
        ) : disk ? (
          <span className={disk.tone === 'ok' ? 'text-success' : disk.tone === 'warn' ? 'text-warning' : 'text-muted'}>{disk.text}</span>
        ) : (
          'Checking…'
        )}
      </Row>
      {account.launcherUid ? (
        <Row label={`${copy.launcherName} account`} hint="Recorded when the launcher reported this account’s sign-in. The full id is under Advanced.">
          <span className="text-muted">Linked to …{account.launcherUid.slice(-4)}</span>
        </Row>
      ) : null}
      {state?.lastSignIn && !state.lastSignIn.ok ? (
        <Row label="Last sign-in">
          <span className="text-xs text-warning">{state.lastSignIn.reason ? sentence(state.lastSignIn.reason) : 'Failed'}</span>
        </Row>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        {session ? (
          confirmForget ? (
            <>
              <Button variant="danger" icon={<Trash2 />} disabled={busy} onClick={() => void forget()}>
                Yes, forget it
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmForget(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" icon={<Trash2 />} disabled={busy} onClick={() => setConfirmForget(true)}>
              Forget saved sign-in
            </Button>
          )
        ) : null}
        {note ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <Check className="size-3.5" /> {note}
          </span>
        ) : null}
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
    </Panel>
  );
}
