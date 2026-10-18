import { create } from 'zustand';
import type { Game, LaunchJob, LauncherId, LauncherStatus, UpdateStatus } from '@shared/models';
import type { WhatsNewRelease } from '@shared/whats-new';

export type View = 'library' | 'accounts' | 'settings';

/** Below this window width the sidebar collapses to icons unless the user has expanded it. */
export const SIDEBAR_NARROW_QUERY = '(max-width: 1099px)';

const SIDEBAR_KEY = 'sidebar';
type SidebarChoice = 'expanded' | 'collapsed';

function readSidebarChoice(): SidebarChoice | null {
  try {
    const v = window.localStorage.getItem(SIDEBAR_KEY);
    return v === 'expanded' || v === 'collapsed' ? v : null;
  } catch {
    return null;
  }
}

function writeSidebarChoice(choice: SidebarChoice | null): void {
  try {
    if (choice) window.localStorage.setItem(SIDEBAR_KEY, choice);
    else window.localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    // per-viewer convenience only
  }
}

/** Sub-navigation inside the Accounts view. */
export type AccountRoute = { kind: 'list' } | { kind: 'new'; launcher: LauncherId } | { kind: 'detail'; id: string };

/** A yes/no question shown by ConfirmDialog; `resolve` answers the `ask()` that opened it. */
export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (ok: boolean) => void;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** What the launch dialog was opened for. A null game is a plain account switch. */
export interface LaunchRequest {
  game: Game | null;
  initialAccountId: string | null;
}

/** The switch-and-launch job the app is following. It outlives the dialog, so navigating away never loses it. */
export interface ActiveLaunch {
  job: LaunchJob;
  game: Game | null;
}

/** Why the setup guide is open: a new install opened it by itself, or the user asked for it from Settings. */
export type SetupGuideSource = 'first-run' | 'settings';

export type SettingsTab = 'general' | 'launchers' | 'artwork' | 'backups' | 'advanced';

/** The release the What's New card shows, and the running version it records as seen when it closes. */
export interface WhatsNewRequest {
  release: WhatsNewRelease;
  version: string;
}

interface UiState {
  view: View;
  accountRoute: AccountRoute;
  /** The Settings tab in view, kept for the session: the sidebar and Ctrl+3 leave it alone, `openSettings` picks one. */
  settingsTab: SettingsTab;
  /** Bumped whenever a setting changes, so views that mirror a setting (the sidebar's Preview mode card, the Library's welcome panel) re-read it. */
  settingsRevision: number;
  /** Set by a view with unsaved edits; navigation asks it before leaving and stays put when it resolves false. */
  leaveGuard: (() => Promise<boolean>) | null;
  /** The question ConfirmDialog is showing, if any. */
  confirm: ConfirmRequest | null;
  /** Icons-only sidebar. Follows the window width until the user toggles it. */
  sidebarCollapsed: boolean;
  sidebarNarrow: boolean;
  /** The launch dialog is open for this request. Hosted at the app level, so it survives view changes. `key` remounts the dialog per request. */
  launchRequest: (LaunchRequest & { key: number }) | null;
  /** The running or not-yet-dismissed job, kept in the store so the banner can show it and the dialog can re-attach. */
  activeLaunch: ActiveLaunch | null;
  /** The last launcher status Settings received, shown at once on the next visit while a fresh one loads. */
  launcherStatus: LauncherStatus[] | null;
  setLauncherStatus: (status: LauncherStatus[]) => void;
  updateStatus: UpdateStatus | null;
  setUpdateStatus: (status: UpdateStatus) => void;
  /** The setup guide is open for this reason, or closed. Hosted at the app level, above every view. */
  setupGuide: SetupGuideSource | null;
  openSetupGuide: (source: SetupGuideSource) => void;
  closeSetupGuide: () => void;
  /** The What's New card is open for this release, or closed. Hosted at the app level, above every view. */
  whatsNew: WhatsNewRequest | null;
  openWhatsNew: (request: WhatsNewRequest) => void;
  closeWhatsNew: () => void;
  openLaunch: (request: LaunchRequest) => void;
  closeLaunch: () => void;
  setActiveLaunch: (launch: ActiveLaunch | null) => void;
  toggleSidebar: () => void;
  setSidebarNarrow: (narrow: boolean) => void;
  setView: (view: View) => void;
  openAccount: (id: string) => void;
  newAccount: (launcher: LauncherId) => void;
  backToAccounts: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  /** Opens Settings on a tab from anywhere: the sidebar's Preview mode card, the Library's artwork-key link. */
  openSettings: (tab: SettingsTab) => void;
  settingsChanged: () => void;
  setLeaveGuard: (guard: (() => Promise<boolean>) | null) => void;
  /** Shows the app's own confirm dialog and resolves with the answer. A second question while one is open is answered no. */
  ask: (opts: ConfirmOptions) => Promise<boolean>;
  answerConfirm: (ok: boolean) => void;
}

export const useUiStore = create<UiState>((set, get) => {
  const mayLeave = (): Promise<boolean> => get().leaveGuard?.() ?? Promise.resolve(true);
  const narrow = typeof window !== 'undefined' && window.matchMedia(SIDEBAR_NARROW_QUERY).matches;
  const choice = readSidebarChoice();
  const navigate = (next: Partial<UiState>): void => {
    void mayLeave().then((ok) => {
      if (ok) set({ ...next, leaveGuard: null });
    });
  };
  return {
    view: 'library',
    accountRoute: { kind: 'list' },
    settingsTab: 'general',
    settingsRevision: 0,
    leaveGuard: null,
    confirm: null,
    sidebarNarrow: narrow,
    sidebarCollapsed: choice ? choice === 'collapsed' : narrow,
    launchRequest: null,
    activeLaunch: null,
    launcherStatus: null,
    setLauncherStatus: (status) => set({ launcherStatus: status }),
    updateStatus: null,
    setUpdateStatus: (status) => {
      if (JSON.stringify(status) !== JSON.stringify(get().updateStatus)) set({ updateStatus: status });
    },
    setupGuide: null,
    openSetupGuide: (source) => set({ setupGuide: source }),
    closeSetupGuide: () => set({ setupGuide: null }),
    whatsNew: null,
    openWhatsNew: (request) => set({ whatsNew: request }),
    closeWhatsNew: () => set({ whatsNew: null }),
    openLaunch: (request) => set({ launchRequest: { ...request, key: Date.now() } }),
    closeLaunch: () => set({ launchRequest: null }),
    setActiveLaunch: (launch) => set({ activeLaunch: launch }),
    toggleSidebar: () => {
      const collapsed = !get().sidebarCollapsed;
      // A choice that matches what the width would pick anyway is no choice at all.
      writeSidebarChoice(collapsed === get().sidebarNarrow ? null : collapsed ? 'collapsed' : 'expanded');
      set({ sidebarCollapsed: collapsed });
    },
    // Crossing the breakpoint returns the sidebar to automatic: collapsed when narrow, open when wide.
    setSidebarNarrow: (next) => {
      if (next === get().sidebarNarrow) return;
      writeSidebarChoice(null);
      set({ sidebarNarrow: next, sidebarCollapsed: next });
    },
    // Selecting Accounts in the sidebar always lands on the list, even from a detail page.
    setView: (view) => {
      if (view === get().view && (view !== 'accounts' || get().accountRoute.kind === 'list')) return;
      navigate(view === 'accounts' ? { view, accountRoute: { kind: 'list' } } : { view });
    },
    openAccount: (id) => navigate({ view: 'accounts', accountRoute: { kind: 'detail', id } }),
    newAccount: (launcher) => navigate({ view: 'accounts', accountRoute: { kind: 'new', launcher } }),
    backToAccounts: () => navigate({ view: 'accounts', accountRoute: { kind: 'list' } }),
    setSettingsTab: (tab) => set({ settingsTab: tab }),
    // Not through setView, which returns early while Settings is already in view.
    openSettings: (tab) => navigate({ view: 'settings', settingsTab: tab }),
    settingsChanged: () => set((s) => ({ settingsRevision: s.settingsRevision + 1 })),
    setLeaveGuard: (guard) => set({ leaveGuard: guard }),
    ask: (opts) => {
      if (get().confirm) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        set({
          confirm: {
            title: opts.title,
            message: opts.message,
            confirmLabel: opts.confirmLabel ?? 'Leave',
            cancelLabel: opts.cancelLabel ?? 'Stay',
            resolve,
          },
        });
      });
    },
    answerConfirm: (ok) => {
      const pending = get().confirm;
      set({ confirm: null });
      pending?.resolve(ok);
    },
  };
});
