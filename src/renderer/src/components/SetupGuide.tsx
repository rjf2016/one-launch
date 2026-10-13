import { ArrowLeft, ArrowRight, LayoutGrid, UserPlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LAUNCHER_DISPLAY_NAMES, type LauncherId } from '@shared/models';
import { ipc, useIpcQuery } from '../lib/ipc';
import { useFocusTrap } from '../lib/useFocusTrap';
import { flashClassOf, useFlash } from '../lib/useFlash';
import { useUiStore, type SetupGuideSource } from '../store/ui';
import { Button } from './Button';
import {
  AccountsStep,
  entryKey,
  errorMessage,
  IMPORT_LAUNCHERS,
  LaunchersStep,
  PlayStep,
  ReadyStep,
  uidOf,
  WelcomeStep,
  type Remembered,
} from './SetupGuideSteps';

export const SETUP_STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'launchers', label: 'Your launchers' },
  { id: 'play', label: 'How Play works' },
  { id: 'accounts', label: 'Your accounts' },
  { id: 'ready', label: 'Ready' },
] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number]['id'];

type Exit = 'library' | 'accounts' | LauncherId | null;

interface Action {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}

/** Installed games counted from the library once the first scan has finished, then again whenever the library changes (a Locate starts a rescan). */
function useGameCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    let revision: number | null = null;
    const tick = async (): Promise<void> => {
      try {
        const { status } = await ipc.invoke('artwork:status');
        if (stopped) return;
        if (status.scanned && status.revision !== revision) {
          revision = status.revision;
          const { games } = await ipc.invoke('library:list');
          if (stopped) return;
          setCount(games.length);
        }
      } catch {
        // asked again on the next tick
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);
  return count;
}

function StepDots({ index }: { index: number }) {
  return (
    <div className="flex items-center gap-3">
      <ol aria-label="Setup steps" className="flex items-center gap-1.5">
        {SETUP_STEPS.map((s, i) => (
          <li
            key={s.id}
            aria-current={i === index ? 'step' : undefined}
            className={`h-1.5 rounded-full transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none ${
              i === index ? 'w-7 bg-accent' : i < index ? 'w-2.5 bg-accent/50' : 'w-2.5 bg-border-strong'
            }`}
          >
            <span className="sr-only">{s.label}</span>
          </li>
        ))}
      </ol>
      <span className="text-xs text-faint tabular-nums">
        {index + 1} of {SETUP_STEPS.length}
      </span>
    </div>
  );
}

/**
 * The five-step welcome on a new install: what One Launch is, the launchers it found, how Play works, importing or
 * adding accounts, and a summary. Every step can be skipped; leaving by any route writes `firstRun.dismissed`.
 */
export function SetupGuide({ source }: { source: SetupGuideSource }) {
  const closeSetupGuide = useUiStore((s) => s.closeSetupGuide);
  const setView = useUiStore((s) => s.setView);
  const newAccount = useUiStore((s) => s.newAccount);
  const settingsChanged = useUiStore((s) => s.settingsChanged);
  const setLauncherStatus = useUiStore((s) => s.setLauncherStatus);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef);

  const [step, setStep] = useState<SetupStepId>('welcome');
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [byHand, setByHand] = useState<LauncherId | null>(null);
  const [closing, setClosing] = useState(false);
  const [flash, setFlash] = useFlash();

  const settings = useIpcQuery(() => ipc.invoke('settings:getAll'));
  const status = useIpcQuery(() => ipc.invoke('launchers:status'));
  const launchers = status.data?.launchers ?? null;
  const games = useGameCount();
  const accounts = useIpcQuery(async () => (step === 'ready' ? (await ipc.invoke('accounts:list')).accounts.length : null), [step]);

  useEffect(() => {
    if (launchers) setLauncherStatus(launchers);
  }, [launchers, setLauncherStatus]);

  const [remembered, setRemembered] = useState<Remembered>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [importedKeys, setImportedKeys] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const imported = useRef<ReadonlySet<string>>(importedKeys);
  imported.current = importedKeys;

  // Each installed launcher that keeps a list is read once the status is in (and again after a Locate); its importable entries start selected.
  useEffect(() => {
    if (!launchers) return;
    let stopped = false;
    for (const launcher of IMPORT_LAUNCHERS) {
      if (!launchers.some((l) => l.launcher === launcher && l.install !== null)) continue;
      setRemembered((r) => ({ ...r, [launcher]: { loading: true, error: null, entries: r[launcher]?.entries ?? [] } }));
      ipc
        .invoke('launchers:rememberedAccounts', { launcher })
        .then(({ accounts }) => {
          if (stopped) return;
          setRemembered((r) => ({ ...r, [launcher]: { loading: false, error: null, entries: accounts } }));
          setSelected((s) => {
            const next = new Set([...s].filter((k) => !k.startsWith(`${launcher}:`)));
            for (const e of accounts) {
              const key = entryKey(launcher, e);
              if (e.linkedAccountId === null && !imported.current.has(key)) next.add(key);
            }
            return next;
          });
        })
        .catch((err: unknown) => {
          if (!stopped) setRemembered((r) => ({ ...r, [launcher]: { loading: false, error: errorMessage(err), entries: [] } }));
        });
    }
    return () => {
      stopped = true;
    };
  }, [launchers]);

  function toggle(key: string): void {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runImport(): Promise<void> {
    setImporting(true);
    let total = 0;
    try {
      for (const launcher of IMPORT_LAUNCHERS) {
        const list = remembered[launcher];
        if (!list) continue;
        const chosen = list.entries.filter((e) => selected.has(entryKey(launcher, e)));
        if (chosen.length === 0) continue;
        const result = await ipc.invoke('launchers:importAccounts', { launcher, launcherUids: chosen.map(uidOf) });
        total += result.accounts.length;
        const keys = chosen.map((e) => entryKey(launcher, e));
        setImportedKeys((k) => new Set([...k, ...keys]));
        setSelected((s) => new Set([...s].filter((k) => !keys.includes(k))));
      }
      setFlash(total === 0 ? 'Nothing new to import' : `Imported ${total} account${total === 1 ? '' : 's'}`, 'success', 4000);
    } catch (err) {
      setFlash(`Could not import: ${errorMessage(err)}`, 'error');
    } finally {
      setImporting(false);
    }
  }

  /** Remembers that the guide was seen, then closes it and goes where the user chose. A save that fails still closes it: the guide simply comes back next start. */
  const finish = useCallback(
    async (exit: Exit): Promise<void> => {
      setClosing(true);
      try {
        await ipc.invoke('settings:set', { key: 'firstRun.dismissed', value: 'true' });
        settingsChanged();
      } catch {
        // nothing to show: the guide returns on the next start, which is the truthful outcome
      }
      closeSetupGuide();
      if (exit === 'library' || exit === 'accounts') setView(exit);
      else if (exit) newAccount(exit);
    },
    [closeSetupGuide, newAccount, settingsChanged, setView],
  );

  const index = SETUP_STEPS.findIndex((s) => s.id === step);
  const busy = importing || closing;

  function go(next: SetupStepId): void {
    setDirection(SETUP_STEPS.findIndex((s) => s.id === next) > index ? 'forward' : 'back');
    setStep(next);
  }
  const previous = SETUP_STEPS[index - 1];
  const following = SETUP_STEPS[index + 1];

  useEffect(() => {
    if (busy) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      void finish(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, finish]);

  // Each step opens with the focus on its primary action, so Enter walks through the guide.
  useEffect(() => {
    const primary = primaryRef.current;
    if (primary && !primary.disabled) primary.focus();
    else bodyRef.current?.focus();
  }, [step]);

  const launchersFound = launchers ? launchers.filter((l) => l.install !== null).length : null;
  const previewMode = settings.data?.settings.dryRun === 'true';
  const artworkOn = settings.data?.settings['artwork.autoFetch'] !== 'false';

  let primary: Action;
  let secondary: Action | null = { label: 'Skip', onClick: () => void finish(null) };
  if (step === 'ready') {
    if (byHand) {
      primary = { label: `Add a ${LAUNCHER_DISPLAY_NAMES[byHand]} account`, icon: <UserPlus />, onClick: () => void finish(byHand) };
      secondary = { label: 'Open Library', onClick: () => void finish('library') };
    } else {
      primary = { label: 'Open Library', icon: <LayoutGrid />, onClick: () => void finish('library') };
      secondary = accounts.data === 0 ? { label: 'Go to Accounts', onClick: () => void finish('accounts') } : null;
    }
  } else {
    primary = { label: step === 'welcome' ? 'Get started' : 'Continue', icon: <ArrowRight />, onClick: () => go(following!.id) };
  }

  return (
    <div className="fixed inset-x-0 top-9 bottom-0 z-40 flex items-center justify-center bg-bg/80 p-6 backdrop-blur-sm" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
        data-source={source}
        className="guide-card relative flex h-[580px] max-h-full w-full max-w-[52rem] flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-panel"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-60 bg-[radial-gradient(70%_100%_at_50%_0%,var(--color-accent-soft),transparent)]"
        />
        <span role="status" className="sr-only">
          Step {index + 1} of {SETUP_STEPS.length}: {SETUP_STEPS[index]!.label}
        </span>

        <header className="relative flex items-center justify-between gap-4 px-8 pt-4">
          <StepDots index={index} />
          <button
            type="button"
            onClick={() => void finish(null)}
            disabled={busy}
            aria-label="Skip setup"
            title="Skip setup (Esc)"
            className="-mr-2 rounded-md p-1.5 text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text disabled:opacity-50 [&>svg]:size-4"
          >
            <X />
          </button>
        </header>

        <div
          key={step}
          ref={bodyRef}
          tabIndex={-1}
          className={`relative min-h-0 flex-1 overflow-y-auto px-8 py-5 focus:outline-none ${direction === 'forward' ? 'guide-fwd' : 'guide-back'}`}
        >
          {step === 'welcome' ? (
            <WelcomeStep />
          ) : step === 'launchers' ? (
            <LaunchersStep launchers={launchers} error={status.error} games={games} artworkOn={artworkOn} onLocated={status.reload} />
          ) : step === 'play' ? (
            <PlayStep previewMode={previewMode} />
          ) : step === 'accounts' ? (
            <AccountsStep
              launchers={launchers}
              remembered={remembered}
              selected={selected}
              importedKeys={importedKeys}
              importing={importing}
              byHand={byHand}
              onToggle={toggle}
              onImport={() => void runImport()}
              onByHand={setByHand}
            />
          ) : (
            <ReadyStep launchersFound={launchersFound} games={games} accounts={accounts.data} byHand={byHand} />
          )}
        </div>

        <footer className="relative flex items-center justify-between gap-3 border-t border-border px-8 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            {previous ? (
              <Button variant="ghost" icon={<ArrowLeft />} disabled={busy} onClick={() => go(previous.id)}>
                Back
              </Button>
            ) : (
              <span className="text-xs text-faint">Takes about a minute.</span>
            )}
            <span role="status" className={`truncate ${flashClassOf(flash)}`}>
              {flash?.text}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {secondary ? (
              <Button variant="ghost" disabled={busy} onClick={secondary.onClick}>
                {secondary.label}
              </Button>
            ) : null}
            <Button ref={primaryRef} variant="primary" icon={primary.icon} disabled={busy} onClick={primary.onClick}>
              {primary.label}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Opens the guide once, at startup, for a data folder nobody has set up yet: the dismissal is unset and no account exists. Settings can open it again later. */
export function SetupGuideHost() {
  const source = useUiStore((s) => s.setupGuide);
  const openSetupGuide = useUiStore((s) => s.openSetupGuide);

  useEffect(() => {
    let cancelled = false;
    Promise.all([ipc.invoke('settings:getAll'), ipc.invoke('accounts:list')])
      .then(([{ settings }, { accounts }]) => {
        if (!cancelled && settings['firstRun.dismissed'] !== 'true' && accounts.length === 0) openSetupGuide('first-run');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [openSetupGuide]);

  return source ? <SetupGuide key={source} source={source} /> : null;
}
