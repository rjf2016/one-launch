import { ChevronRight, Download, KeyRound, Plus, StickyNote, UserRound } from 'lucide-react';
import { useState } from 'react';
import { LAUNCHER_DISPLAY_NAMES, LAUNCHER_IDS, type Account } from '@shared/models';
import { EmptyState } from '../components/EmptyState';
import { ImportAccountsDialog } from '../components/ImportAccountsDialog';
import { LauncherDot } from '../components/LauncherBadge';
import { MenuButton, type MenuItem } from '../components/MenuButton';
import { Page } from '../components/Page';
import { PageHeader } from '../components/PageHeader';
import { ipc, useIpcQuery } from '../lib/ipc';
import { formatRelative } from '../lib/time';
import { flashClassOf, useFlash } from '../lib/useFlash';
import { useUiStore } from '../store/ui';

/** Accounts used from One Launch first (most recent on top), then the rest by name. */
export function sortAccounts(list: Account[]): Account[] {
  return [...list].sort((a, b) => {
    if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
    if (a.lastUsedAt) return -1;
    if (b.lastUsedAt) return 1;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  });
}

/** An account One Launch can switch to without asking the user to sign in again. */
function isReady(account: Account): boolean {
  return account.hasSession || account.lastUsedAt !== null;
}

function AccountRow({ account, onOpen }: { account: Account; onOpen: () => void }) {
  const ready = isReady(account);
  const notePreview =
    account.notes
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-2/60 focus-visible:bg-surface-2/60"
    >
      <div
        className={`flex size-9 shrink-0 items-center justify-center rounded-lg border [&>svg]:size-4 ${
          ready ? 'border-accent/30 bg-accent-soft text-accent' : 'border-border bg-surface-2 text-faint'
        }`}
        title={ready ? 'Ready: switches without asking you to sign in' : 'The first switch will ask you to sign in once'}
      >
        {ready ? <KeyRound /> : <UserRound />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text-strong">{account.displayName}</span>
          {account.tags.map((t) => (
            <span key={t} className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-muted">
              {t}
            </span>
          ))}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
          <span className="truncate">{account.login}</span>
          {notePreview ? (
            <>
              <span className="text-faint">·</span>
              <span className="inline-flex min-w-0 items-center gap-1 truncate text-faint [&>svg]:size-3">
                <StickyNote />
                <span className="truncate">{notePreview}</span>
              </span>
            </>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 text-right text-xs text-faint">
        <div className={account.lastUsedAt ? 'text-muted' : ''}>
          {account.lastUsedAt ? `Used ${formatRelative(account.lastUsedAt)}` : ready ? 'Sign-in saved' : 'Not used yet'}
        </div>
        {account.hasSecret ? (
          <div className="text-[11px]" title="A password is stored for the Copy button">
            Password stored
          </div>
        ) : null}
      </div>
      <ChevronRight className="size-4 shrink-0 text-faint transition-colors group-hover:text-muted" />
    </button>
  );
}

export function AccountsView() {
  const accounts = useIpcQuery(() => ipc.invoke('accounts:list'));
  const openAccount = useUiStore((s) => s.openAccount);
  const newAccount = useUiStore((s) => s.newAccount);
  const list = accounts.data?.accounts ?? [];
  const [importing, setImporting] = useState<'steam' | 'battlenet' | null>(null);
  const [flash, setFlash] = useFlash();

  const importItems: MenuItem[] = [
    {
      id: 'steam',
      label: 'From Steam',
      hint: 'Logins Steam has saved',
      icon: <LauncherDot launcher="steam" />,
      onSelect: () => setImporting('steam'),
    },
    {
      id: 'battlenet',
      label: 'From Battle.net',
      hint: 'Logins Battle.net has saved',
      icon: <LauncherDot launcher="battlenet" />,
      onSelect: () => setImporting('battlenet'),
    },
    {
      id: 'epic',
      label: 'Epic Games: add by hand',
      hint: 'Epic keeps no account list',
      icon: <LauncherDot launcher="epic" />,
      onSelect: () => newAccount('epic'),
    },
    {
      id: 'riot',
      label: 'Riot Games: add by hand',
      hint: 'The Riot Client keeps no account list',
      icon: <LauncherDot launcher="riot" />,
      onSelect: () => newAccount('riot'),
    },
  ];
  const addItems: MenuItem[] = LAUNCHER_IDS.map((id) => ({
    id,
    label: LAUNCHER_DISPLAY_NAMES[id],
    icon: <LauncherDot launcher={id} />,
    onSelect: () => newAccount(id),
  }));

  function onImported(imported: Account[]): void {
    const from = importing === 'battlenet' ? 'Battle.net' : 'Steam';
    setImporting(null);
    if (imported.length === 0) setFlash('Nothing new to import');
    else setFlash(`Imported ${imported.length} account${imported.length === 1 ? '' : 's'} from ${from}`, 'success', 4000);
    accounts.reload();
  }

  return (
    <Page narrow>
      <PageHeader
        title="Accounts"
        subtitle="The accounts you switch between, grouped by launcher."
        actions={
          <>
            <span role="status" className={flashClassOf(flash)}>
              {flash?.text}
            </span>
            <MenuButton icon={<Download />} label="Import" items={importItems} />
            <MenuButton variant="primary" icon={<Plus />} label="Add account" items={addItems} />
          </>
        }
      />
      {importing ? <ImportAccountsDialog launcher={importing} onClose={() => setImporting(null)} onImported={onImported} /> : null}

      {accounts.error ? (
        <p className="text-sm text-danger">Could not load accounts: {accounts.error}</p>
      ) : accounts.loading && list.length === 0 ? null : list.length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title="No accounts yet"
          description="Add the accounts you use on each launcher, or import the ones Steam and Battle.net already know. Passwords are optional and stay on this PC."
          action={
            <div className="flex items-center gap-2">
              <MenuButton variant="primary" icon={<Download />} label="Import accounts" items={importItems} align="left" />
              <MenuButton icon={<Plus />} label="Add account" items={addItems} align="left" />
            </div>
          }
        />
      ) : (
        <div className="flex flex-col gap-6 pb-6">
          {LAUNCHER_IDS.map((launcher) => {
            const group = sortAccounts(list.filter((a) => a.launcher === launcher));
            if (group.length === 0) return null;
            return (
              <section key={launcher}>
                <div className="mb-2 flex items-center gap-2">
                  <LauncherDot launcher={launcher} />
                  <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{LAUNCHER_DISPLAY_NAMES[launcher]}</h2>
                  <span className="text-xs text-faint">{group.length}</span>
                </div>
                <div className="divide-y divide-border overflow-hidden rounded-panel border border-border bg-surface">
                  {group.map((a) => (
                    <AccountRow key={a.id} account={a} onOpen={() => openAccount(a.id)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </Page>
  );
}
