import { useEffect } from 'react';
import { ConfirmDialog } from './components/ConfirmDialog';
import { LaunchHost } from './components/LaunchHost';
import { RecoveryHost } from './components/RecoveryDialog';
import { SetupGuideHost } from './components/SetupGuide';
import { NAV_ITEMS, Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { WhatsNewHost } from './components/WhatsNewDialog';
import { isBack, isShortcut } from './lib/shortcuts';
import { SIDEBAR_NARROW_QUERY, useUiStore } from './store/ui';
import { AccountDetailView } from './views/AccountDetailView';
import { AccountsView } from './views/AccountsView';
import { LibraryView } from './views/LibraryView';
import { SettingsView } from './views/SettingsView';

function CurrentView() {
  const view = useUiStore((s) => s.view);
  const accountRoute = useUiStore((s) => s.accountRoute);
  if (view === 'library') return <LibraryView />;
  if (view === 'settings') return <SettingsView />;
  return accountRoute.kind === 'list' ? <AccountsView /> : <AccountDetailView />;
}

export function App() {
  const setView = useUiStore((s) => s.setView);
  const backToAccounts = useUiStore((s) => s.backToAccounts);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarNarrow = useUiStore((s) => s.setSidebarNarrow);

  useEffect(() => {
    // Back leaves an account's page for the Accounts list; nowhere else has anywhere to go back to.
    const back = (): boolean => {
      const { view, accountRoute } = useUiStore.getState();
      if (view !== 'accounts' || accountRoute.kind === 'list') return false;
      backToAccounts();
      return true;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (isShortcut(e, 'b', { inFields: false })) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (isBack(e)) {
        if (back()) e.preventDefault();
        return;
      }
      const item = NAV_ITEMS.find((_, i) => isShortcut(e, String(i + 1), { inFields: false }));
      if (!item) return;
      e.preventDefault();
      setView(item.view);
    };
    const onMouseUp = (e: MouseEvent): void => {
      if (isBack(e)) back();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [backToAccounts, setView, toggleSidebar]);

  useEffect(() => {
    const mq = window.matchMedia(SIDEBAR_NARROW_QUERY);
    const onChange = (): void => setSidebarNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setSidebarNarrow]);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <ConfirmDialog />
      <TitleBar />
      <RecoveryHost />
      <SetupGuideHost />
      <WhatsNewHost />
      <LaunchHost />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-hidden">
          <CurrentView />
        </main>
      </div>
    </div>
  );
}
