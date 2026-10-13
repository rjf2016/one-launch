import { ArrowLeft, ArrowRightLeft, Check, Copy, Eye, EyeOff, KeyRound, ListChecks, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  ACCOUNT_LIMITS,
  LAUNCHER_DISPLAY_NAMES,
  normalizeTags,
  type Account,
  type AccountCreateInput,
  type AccountPatch,
  type LauncherId,
  type SwitchPlan,
} from '@shared/models';
import { Button } from '../components/Button';
import { Collapsible } from '../components/Collapsible';
import { hasSessionPanel, SessionPanel } from '../components/SessionPanel';
import { Field, TextArea, TextInput } from '../components/Field';
import { LauncherBadge } from '../components/LauncherBadge';
import { Page } from '../components/Page';
import { stickyHeaderClass } from '../components/PageHeader';
import { Panel, Row } from '../components/Panel';
import { SwitchPlanView } from '../components/SwitchPlanView';
import { TagInput } from '../components/TagInput';
import { ipc, IpcError, useIpcQuery } from '../lib/ipc';
import { isShortcut } from '../lib/shortcuts';
import { formatDateTime, formatRelative } from '../lib/time';
import { flashClassOf, useFlash } from '../lib/useFlash';
import { useUiStore } from '../store/ui';

// ---------------------------------------------------------------------------
// Draft state shared by the create and edit forms.
// ---------------------------------------------------------------------------

interface Draft {
  displayName: string;
  login: string;
  launcherUid: string;
  tags: string[];
  notes: string;
}

const emptyDraft: Draft = { displayName: '', login: '', launcherUid: '', tags: [], notes: '' };

function draftFrom(a: Account): Draft {
  return { displayName: a.displayName, login: a.login, launcherUid: a.launcherUid ?? '', tags: a.tags, notes: a.notes };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.displayName === b.displayName &&
    a.login === b.login &&
    a.launcherUid === b.launcherUid &&
    a.notes === b.notes &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => t === b.tags[i])
  );
}

function validate(d: Draft): Partial<Record<keyof Draft, string>> {
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (!d.displayName.trim()) errors.displayName = 'Display name is required.';
  if (!d.login.trim()) errors.login = 'Login is required.';
  if (d.notes.length > ACCOUNT_LIMITS.notes) errors.notes = `Notes must be at most ${ACCOUNT_LIMITS.notes} characters.`;
  return errors;
}

function errorMessage(err: unknown): string {
  if (err instanceof IpcError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Shared form body.
// ---------------------------------------------------------------------------

interface AccountFormProps {
  draft: Draft;
  errors: Partial<Record<keyof Draft, string>>;
  launcher: LauncherId;
  disabled: boolean;
  /** Put the cursor in the first field (new accounts only; an existing account opens for reading). */
  autoFocus?: boolean;
  onChange: (patch: Partial<Draft>) => void;
}

const EXAMPLES: Readonly<Record<LauncherId, { name: string; notes: string }>> = {
  steam: { name: 'CS2 alt', notes: 'Prime · owns Rust and CS2 · Family Sharing on' },
  epic: { name: 'Fortnite main', notes: 'Chapter 1 skins · free games claimed every week' },
  battlenet: { name: 'OW Smurf #12', notes: 'Gold 3 · bought 2024-03 · has the OW1 skins' },
  riot: { name: 'VALORANT alt', notes: 'Plat 2 · EU West · has the Reaver bundle' },
};

function AccountForm({ draft, errors, launcher, disabled, autoFocus = false, onChange }: AccountFormProps) {
  const example = EXAMPLES[launcher];
  const loginHint =
    launcher === 'steam'
      ? 'Your Steam account name, not your profile name.'
      : launcher === 'epic'
        ? 'The email you sign in to Epic Games with.'
        : launcher === 'riot'
          ? 'The username you sign in to the Riot Client with.'
          : 'The email you sign in to Battle.net with.';
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Display name" hint="How this account is shown in One Launch." error={errors.displayName}>
          <TextInput
            value={draft.displayName}
            maxLength={ACCOUNT_LIMITS.displayName}
            disabled={disabled}
            placeholder={example.name}
            onChange={(e) => onChange({ displayName: e.target.value })}
            autoFocus={autoFocus}
          />
        </Field>
        <Field label="Login" hint={loginHint} error={errors.login}>
          <TextInput
            value={draft.login}
            maxLength={ACCOUNT_LIMITS.login}
            disabled={disabled}
            placeholder={launcher === 'steam' ? 'account name' : launcher === 'riot' ? 'username' : 'you@example.com'}
            autoComplete="off"
            onChange={(e) => onChange({ login: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Tags" hint="Press Enter to add one. Rank, role, region, anything.">
        <TagInput value={draft.tags} disabled={disabled} onChange={(tags) => onChange({ tags })} />
      </Field>
      <Field label="Notes" hint="Anything you want to remember about this account." error={errors.notes}>
        <TextArea
          value={draft.notes}
          maxLength={ACCOUNT_LIMITS.notes}
          disabled={disabled}
          placeholder={example.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
        />
      </Field>
    </div>
  );
}

/** The launcher's own id for the account. Rarely needed by hand, so it lives under Advanced. */
function LauncherIdField({ draft, launcher, disabled, onChange }: Pick<AccountFormProps, 'draft' | 'launcher' | 'disabled' | 'onChange'>) {
  return (
    <Field
      label={launcher === 'steam' ? 'SteamID64' : launcher === 'epic' ? 'Epic account id' : launcher === 'riot' ? 'Riot account id' : 'Battle.net account id'}
      hint={
        launcher === 'steam'
          ? 'Filled in when you import the account from Steam. Only needed if Steam’s remembered name and this account disagree.'
          : 'Filled in by itself the first time One Launch sees this account signed in. You normally never type it.'
      }
    >
      <TextInput
        value={draft.launcherUid}
        maxLength={ACCOUNT_LIMITS.launcherUid}
        disabled={disabled}
        placeholder={
          launcher === 'steam'
            ? '7656119…'
            : launcher === 'epic'
              ? '32 hex characters'
              : launcher === 'riot'
                ? '36 characters, with dashes'
                : '8 hex characters'
        }
        className="font-mono"
        onChange={(e) => onChange({ launcherUid: e.target.value })}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Password controls (edit mode only).
// ---------------------------------------------------------------------------

function PasswordPanel({ account, onChanged, flash }: { account: Account; onChanged: (a: Account) => void; flash: (t: string, ms?: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  function reset(): void {
    setEditing(false);
    setValue('');
    setShow(false);
    setError(null);
  }

  async function save(): Promise<void> {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const { account: next } = await ipc.invoke('accounts:setPassword', { id: account.id, password: value });
      onChanged(next);
      reset();
      flash(account.hasSecret ? 'Password updated' : 'Password stored');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      const { account: next } = await ipc.invoke('accounts:clearPassword', { id: account.id });
      onChanged(next);
      setConfirmRemove(false);
      flash('Password removed');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(field: 'login' | 'password'): Promise<void> {
    try {
      const { clearAfterMs, historyExcluded } = await ipc.invoke('accounts:copy', { id: account.id, field });
      flash(
        `${field === 'login' ? 'Login' : 'Password'} copied · clipboard clears in ${Math.round(clearAfterMs / 1000)}s while One Launch is open${
          field === 'password' && !historyExcluded ? ' · Windows clipboard history may keep it' : ''
        }`,
        4000,
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Panel
      title="Password"
      description="Optional. Switching does not need it; it is only there so you can copy it when a launcher asks you to sign in. Stored encrypted on this PC."
      actions={
        <>
          <Button icon={<Copy />} onClick={() => void copy('login')}>
            Copy login
          </Button>
          <Button icon={<Copy />} disabled={!account.hasSecret} onClick={() => void copy('password')}>
            Copy password
          </Button>
        </>
      }
    >
      <Row label="Status">
        {account.hasSecret ? (
          <span className="inline-flex items-center gap-1.5 text-success">
            <ShieldCheck className="size-4" /> Stored · encrypted
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <KeyRound className="size-4" /> Not stored
          </span>
        )}
      </Row>

      {editing ? (
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-surface-2/50 p-4">
          <Field label={account.hasSecret ? 'New password' : 'Password'} error={error}>
            <div className="relative">
              <TextInput
                type={show ? 'text' : 'password'}
                value={value}
                maxLength={ACCOUNT_LIMITS.password}
                autoComplete="new-password"
                autoFocus
                disabled={busy}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                  if (e.key === 'Escape') reset();
                }}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-text [&>svg]:size-4"
              >
                {show ? <EyeOff /> : <Eye />}
              </button>
            </div>
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="primary" icon={<Check />} disabled={!value || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : account.hasSecret ? 'Update password' : 'Store password'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <Button icon={<KeyRound />} onClick={() => setEditing(true)}>
            {account.hasSecret ? 'Update password' : 'Store password'}
          </Button>
          {account.hasSecret ? (
            confirmRemove ? (
              <>
                <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                  Confirm remove
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
            )
          ) : null}
          {error ? <span className="text-xs text-danger">{error}</span> : null}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Switch plan (dry run), for every launcher with an adapter.
// ---------------------------------------------------------------------------

function SwitchPlanPanel({ account }: { account: Account }) {
  const [plan, setPlan] = useState<SwitchPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A plan describes the account as it is now; drop it when the account changes underneath it.
  useEffect(() => {
    setPlan(null);
  }, [account.updatedAt]);

  async function preview(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { plan: next } = await ipc.invoke('launchers:switchPlan', { accountId: account.id });
      setPlan(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Switch preview"
      description={`Exactly what switching ${LAUNCHER_DISPLAY_NAMES[account.launcher]} to this account would change. Previewing changes nothing.`}
      actions={
        <Button icon={<ListChecks />} disabled={busy} onClick={() => void preview()}>
          {busy ? `Checking ${LAUNCHER_DISPLAY_NAMES[account.launcher]}…` : plan ? 'Refresh' : 'Preview'}
        </Button>
      }
    >
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {plan ? <SwitchPlanView plan={plan} /> : !error ? <p className="text-sm text-muted">Press Preview to see the steps.</p> : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

function CreateAccount({ launcher }: { launcher: LauncherId }) {
  const back = useUiStore((s) => s.backToAccounts);
  const openAccount = useUiStore((s) => s.openAccount);
  const setLeaveGuard = useUiStore((s) => s.setLeaveGuard);
  const ask = useUiStore((s) => s.ask);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const errors = useMemo(() => (touched ? validate(draft) : {}), [draft, touched]);
  const dirty = !sameDraft(draft, emptyDraft) || password !== '';

  useEffect(() => {
    setLeaveGuard(dirty ? () => ask({ title: 'Leave without creating this account?', message: 'What you typed will be lost.' }) : null);
    return () => setLeaveGuard(null);
  }, [dirty, setLeaveGuard, ask]);

  async function create(): Promise<void> {
    setTouched(true);
    if (Object.keys(validate(draft)).length > 0) return;
    setBusy(true);
    setError(null);
    setLeaveGuard(null);
    const input: AccountCreateInput = {
      launcher,
      displayName: draft.displayName,
      login: draft.login,
      launcherUid: draft.launcherUid || null,
      tags: normalizeTags(draft.tags),
      notes: draft.notes,
      password: password || null,
    };
    try {
      const { account } = await ipc.invoke('accounts:create', input);
      setPassword('');
      openAccount(account.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      setLeaveGuard(() => ask({ title: 'Leave without creating this account?', message: 'What you typed will be lost.' }));
    }
  }

  return (
    <Page narrow>
      <header className={`${stickyHeaderClass} flex items-end justify-between gap-4`}>
        <div>
          <button type="button" onClick={back} className="mb-1 inline-flex items-center gap-1 rounded text-xs text-muted hover:text-text [&>svg]:size-3.5">
            <ArrowLeft /> Accounts
          </button>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-text-strong">New {LAUNCHER_DISPLAY_NAMES[launcher]} account</h1>
            <LauncherBadge launcher={launcher} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {error ? <span className="text-xs text-danger">{error}</span> : null}
          <Button variant="ghost" onClick={back} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Check />} onClick={() => void create()} disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-4 pb-6">
        <Panel title="Details">
          <AccountForm draft={draft} errors={errors} launcher={launcher} disabled={busy} autoFocus onChange={(p) => setDraft((d) => ({ ...d, ...p }))} />
        </Panel>
        <Panel
          title="Password"
          description="Optional. Switching does not need it; it is only there so you can copy it when a launcher asks you to sign in. Stored encrypted on this PC."
        >
          <Field label="Password">
            <div className="relative">
              <TextInput
                type={show ? 'text' : 'password'}
                value={password}
                maxLength={ACCOUNT_LIMITS.password}
                autoComplete="new-password"
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-text [&>svg]:size-4"
              >
                {show ? <EyeOff /> : <Eye />}
              </button>
            </div>
          </Field>
        </Panel>
        <Collapsible title="Advanced" hint="Launcher account id">
          <Panel title="Launcher account id">
            <LauncherIdField draft={draft} launcher={launcher} disabled={busy} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} />
          </Panel>
        </Collapsible>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Edit.
// ---------------------------------------------------------------------------

function EditAccount({ id }: { id: string }) {
  const back = useUiStore((s) => s.backToAccounts);
  const setLeaveGuard = useUiStore((s) => s.setLeaveGuard);
  const ask = useUiStore((s) => s.ask);
  const openLaunch = useUiStore((s) => s.openLaunch);
  const query = useIpcQuery(() => ipc.invoke('accounts:get', { id }), [id]);
  const [account, setAccount] = useState<Account | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [flash, setFlash] = useFlash();

  useEffect(() => {
    if (query.data) {
      setAccount(query.data.account);
      setDraft(draftFrom(query.data.account));
    }
  }, [query.data]);

  const baseline = useMemo(() => (account ? draftFrom(account) : emptyDraft), [account]);
  const dirty = account !== null && !sameDraft(draft, baseline);

  useEffect(() => {
    setLeaveGuard(dirty ? () => ask({ title: 'Leave without saving?', message: 'Your changes to this account will be lost.' }) : null);
    return () => setLeaveGuard(null);
  }, [dirty, setLeaveGuard, ask]);

  /** A capture or a switch recorded the launcher's account id; show it without losing unsaved edits to other fields. */
  function onLinked(next: Account): void {
    setAccount(next);
    setDraft((d) => ({ ...d, launcherUid: next.launcherUid ?? d.launcherUid }));
  }
  const errors = useMemo(() => (dirty ? validate(draft) : {}), [draft, dirty]);

  async function save(): Promise<void> {
    if (!account || !dirty || busy || Object.keys(validate(draft)).length > 0) return;
    setBusy(true);
    setError(null);
    const patch: AccountPatch = {};
    if (draft.displayName !== baseline.displayName) patch.displayName = draft.displayName;
    if (draft.login !== baseline.login) patch.login = draft.login;
    if (draft.launcherUid !== baseline.launcherUid) patch.launcherUid = draft.launcherUid || null;
    if (draft.notes !== baseline.notes) patch.notes = draft.notes;
    if (draft.tags.length !== baseline.tags.length || draft.tags.some((t, i) => t !== baseline.tags[i])) patch.tags = draft.tags;
    try {
      const { account: next } = await ipc.invoke('accounts:update', { id: account.id, patch });
      setAccount(next);
      setDraft(draftFrom(next));
      setFlash('Saved', 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!account) return;
    setBusy(true);
    try {
      await ipc.invoke('accounts:delete', { id: account.id });
      setLeaveGuard(null);
      back();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isShortcut(e, 's')) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (query.error) {
    return (
      <Page narrow>
        <button
          type="button"
          onClick={back}
          className="mt-7 mb-4 inline-flex items-center gap-1 self-start rounded text-xs text-muted hover:text-text [&>svg]:size-3.5"
        >
          <ArrowLeft /> Accounts
        </button>
        <p className="text-sm text-danger">Could not load this account: {query.error}</p>
      </Page>
    );
  }
  if (!account) return null;

  return (
    <Page narrow>
      <header className={`${stickyHeaderClass} flex items-end justify-between gap-4`}>
        <div className="min-w-0">
          <button type="button" onClick={back} className="mb-1 inline-flex items-center gap-1 rounded text-xs text-muted hover:text-text [&>svg]:size-3.5">
            <ArrowLeft /> Accounts
          </button>
          <div className="flex items-center gap-3">
            <h1 className="truncate text-xl font-semibold tracking-tight text-text-strong">{account.displayName}</h1>
            <LauncherBadge launcher={account.launcher} />
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {account.lastUsedAt ? `Last used ${formatRelative(account.lastUsedAt)}` : 'Never used from One Launch'} · Added {formatDateTime(account.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span role="status" className={flashClassOf(flash)}>
            {flash?.text}
          </span>
          {error ? <span className="text-xs text-danger">{error}</span> : null}
          {dirty ? (
            <Button variant="ghost" disabled={busy} onClick={() => setDraft(baseline)}>
              Discard
            </Button>
          ) : (
            <Button
              icon={<ArrowRightLeft />}
              disabled={busy}
              title={`Switch ${LAUNCHER_DISPLAY_NAMES[account.launcher]} to this account without launching a game`}
              onClick={() => openLaunch({ game: null, initialAccountId: account.id })}
            >
              Switch to this account
            </Button>
          )}
          <Button
            variant="primary"
            icon={<Check />}
            disabled={!dirty || busy || Object.keys(errors).length > 0}
            title={dirty ? 'Save changes (Ctrl+S)' : 'No unsaved changes'}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-4 pb-6">
        <Panel title="Details">
          <AccountForm draft={draft} errors={errors} launcher={account.launcher} disabled={busy} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} />
        </Panel>

        <PasswordPanel account={account} onChanged={setAccount} flash={(t, ms) => setFlash(t, 'success', ms)} />

        {hasSessionPanel(account.launcher) ? <SessionPanel account={account} onAccountChanged={onLinked} /> : null}

        <Collapsible title="Advanced" hint="Launcher account id and the switch preview">
          <Panel title="Launcher account id">
            <LauncherIdField draft={draft} launcher={account.launcher} disabled={busy} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} />
          </Panel>
          <SwitchPlanPanel account={account} />
        </Collapsible>

        <Panel
          title="Danger zone"
          description="Deleting removes the account, its password, and its saved sign-in from One Launch only. Nothing changes in the launcher."
        >
          <div className="flex items-center gap-2">
            {confirmDelete ? (
              <>
                <Button variant="danger" icon={<Trash2 />} disabled={busy} onClick={() => void remove()}>
                  Yes, delete “{account.displayName}”
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirmDelete(true)}>
                Delete account
              </Button>
            )}
          </div>
        </Panel>
      </div>
    </Page>
  );
}

export function AccountDetailView() {
  const route = useUiStore((s) => s.accountRoute);
  if (route.kind === 'new') return <CreateAccount launcher={route.launcher} />;
  if (route.kind === 'detail') return <EditAccount key={route.id} id={route.id} />;
  return null;
}
