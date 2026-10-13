import { CircleArrowDown, FlaskConical, LayoutGrid, PanelLeftClose, PanelLeftOpen, Settings, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ipc, useIpcQuery } from '../lib/ipc';
import { restartToUpdate, useUpdateStatus } from '../lib/updates';
import { useUiStore, type View } from '../store/ui';

interface NavItem {
  view: View;
  label: string;
  icon: ReactNode;
  shortcut: string;
}

export const NAV_ITEMS: NavItem[] = [
  { view: 'library', label: 'Library', icon: <LayoutGrid />, shortcut: 'Ctrl+1' },
  { view: 'accounts', label: 'Accounts', icon: <Users />, shortcut: 'Ctrl+2' },
  { view: 'settings', label: 'Settings', icon: <Settings />, shortcut: 'Ctrl+3' },
];

const UPDATE_POLL_MS = 60_000;

/**
 * Only the aside's width animates; every child keeps a fixed left edge and its text fades,
 * so the browser lays out one box per frame instead of re-flowing the sidebar's contents.
 */
export function Sidebar() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const settingsRevision = useUiStore((s) => s.settingsRevision);
  const settings = useIpcQuery(() => ipc.invoke('settings:getAll'), [settingsRevision]);
  const info = useIpcQuery(() => ipc.invoke('app:info'));
  const dryRun = settings.data?.settings.dryRun === 'true';
  const update = useUpdateStatus(UPDATE_POLL_MS);
  const switchRunning = useUiStore((s) => s.activeLaunch?.job.state === 'running');
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const fade = `transition-opacity duration-150 motion-reduce:transition-none ${collapsed ? 'pointer-events-none opacity-0' : 'opacity-100'}`;

  return (
    <aside
      data-collapsed={collapsed || undefined}
      className={`flex shrink-0 flex-col overflow-hidden border-r border-border bg-surface transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        collapsed ? 'w-[60px]' : 'w-56'
      }`}
    >
      <nav className="flex flex-col gap-1.5 px-2 pt-5" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const active = item.view === view;
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => setView(item.view)}
              aria-current={active ? 'page' : undefined}
              aria-label={item.label}
              title={`${item.label} (${item.shortcut})`}
              className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] whitespace-nowrap transition-colors duration-150 [&>svg]:size-5 [&>svg]:shrink-0 ${
                active ? 'bg-surface-2 text-text-strong' : 'text-muted hover:bg-surface-2/60 hover:text-text'
              }`}
            >
              {active ? <span className="absolute inset-y-2.5 left-0 w-0.5 rounded-full bg-accent" /> : null}
              {item.icon}
              <span className={fade}>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-1 px-2 pb-3">
        {dryRun ? (
          <button
            type="button"
            onClick={() => setView('settings')}
            aria-label="Preview mode is on"
            title="Preview mode is on: Play shows what a switch would do instead of doing it. Turn it off in Settings, or from the preview itself."
            className={`flex items-start gap-2 rounded-lg border px-[11px] py-2 text-left text-xs transition-colors duration-150 ${
              collapsed ? 'border-transparent text-warning hover:bg-warning/10' : 'border-warning/30 bg-warning/10 text-warning hover:bg-warning/15'
            }`}
          >
            <FlaskConical className="mt-0.5 size-3.5 shrink-0" />
            <span className={`w-[164px] shrink-0 ${fade}`} aria-hidden={collapsed}>
              <span className="font-medium">Preview mode is on</span>
              <span className="block text-[11px] text-warning/80">Play shows what would happen, nothing changes.</span>
            </span>
          </button>
        ) : null}
        {update?.state === 'ready' ? (
          <button
            type="button"
            disabled={restarting || switchRunning}
            onClick={() => {
              setRestartError(null);
              setRestarting(true);
              restartToUpdate()
                .then((restarted) => {
                  if (!restarted) setRestarting(false);
                })
                .catch((err: unknown) => {
                  setRestarting(false);
                  setRestartError(err instanceof Error ? err.message : String(err));
                });
            }}
            aria-label={`Restart to install One Launch ${update.version}`}
            title={
              switchRunning
                ? `One Launch ${update.version} is ready. Restart to install it once the switch has finished.`
                : `One Launch ${update.version} is ready. Restart to install it.`
            }
            className={`flex items-start gap-2 rounded-lg border px-[11px] py-2 text-left text-xs transition-colors duration-150 disabled:opacity-60 ${
              collapsed
                ? 'border-transparent text-accent-hover hover:bg-accent-soft'
                : 'border-accent/30 bg-accent-soft text-text-strong hover:border-accent/50 disabled:hover:border-accent/30'
            }`}
          >
            <CircleArrowDown className="mt-0.5 size-3.5 shrink-0 text-accent-hover" />
            <span className={`w-[164px] shrink-0 ${fade}`} aria-hidden={collapsed}>
              <span className="font-medium">{restarting ? 'Restarting…' : 'Update ready'}</span>
              <span className={`block text-[11px] ${restartError ? 'text-danger' : 'text-muted'}`}>
                {restartError ? `Could not restart: ${restartError}` : `Restart to install ${update.version}`}
              </span>
            </span>
          </button>
        ) : null}
        <div className="flex items-center justify-between gap-2 whitespace-nowrap">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (Ctrl+B)`}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text [&>svg]:size-[18px]"
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
          {info.data ? <span className={`pr-2 text-[11px] text-faint ${fade}`}>v{info.data.version}</span> : null}
        </div>
      </div>
    </aside>
  );
}
