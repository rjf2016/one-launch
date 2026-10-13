import { useEffect } from 'react';
import { ConfirmDialog } from './components/ConfirmDialog';
import { LaunchHost } from './components/LaunchHost';
import { RecoveryHost } from './components/RecoveryDialog';
import { SetupGuideHost } from './components/SetupGuide';
import { NAV_ITEMS, Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { isShortcut } from './lib/shortcuts';
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
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarNarrow = useUiStore((s) => s.setSidebarNarrow);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isShortcut(e, 'b', { inFields: false })) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      const item = NAV_ITEMS.find((_, i) => isShortcut(e, String(i + 1), { inFields: false }));
      if (!item) return;
      e.preventDefault();
      setView(item.view);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, toggleSidebar]);

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
