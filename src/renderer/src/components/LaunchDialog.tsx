import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CircleDashed,
  CircleStop,
  Copy,
  EyeOff,
  FlaskConical,
  Info,
  KeyRound,
  Loader2,
  Play,
  Power,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  LAUNCHER_CLIENT_NAMES,
  LAUNCHER_DISPLAY_NAMES,
  type Account,
  type Game,
  type JobStep,
  type LaunchAttention,
  type LaunchJob,
  type LaunchPreflight,
  type LauncherId,
} from '@shared/models';
import { useFocusTrap, useFocusWhenReady } from '../lib/useFocusTrap';
import { ipc, IpcError, useIpcQuery } from '../lib/ipc';
import { groupSteps, jobAnnouncement, phaseLabel, planPhases, sentence, stoppedNote, type PhaseNames } from '../lib/phases';
import { formatRelative } from '../lib/time';
import { useUiStore } from '../store/ui';
import { sortAccounts } from '../views/AccountsView';
import { Button } from './Button';
import { LauncherBadge } from './LauncherBadge';
import { StatusPill } from './StatusPill';
import { SwitchPlanView } from './SwitchPlanView';

interface LaunchDialogProps {
  /** The game to launch after the switch, or null for a plain account switch. */
  game: Game | null;
  /** Preselect this account (Recent strip, account page). Falls back to the most recently used one. */
  initialAccountId?: string | null;
  onClose: () => void;
}

type Stage =
  | { kind: 'pick' }
  | { kind: 'checking' }
  | { kind: 'confirm'; preflight: LaunchPreflight }
  | { kind: 'dryRun'; preflight: LaunchPreflight }
  | { kind: 'blocked'; preflight: LaunchPreflight }
  | { kind: 'running'; job: LaunchJob }
  | { kind: 'finished'; job: LaunchJob }
  | { kind: 'error'; message: string };

function errorMessage(err: unknown): string {
  if (err instanceof IpcError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The launcher wants to update the game first: Battle.net and the Riot Client will not start it until then, Steam updates it on the way. */
function updateNote(game: Game, clientName: string): string {
  const client =
    game.launcher === 'battlenet' ? ['Battle.net', 'the Battle.net window'] : game.launcher === 'riot' ? ['The Riot Client', 'the Riot Client window'] : null;
  if (!client) return `${sentence(clientName)} updates ${game.name} before it starts, so the launch may take a while.`;
  return `${client[0]} wants to update ${game.name} first. The switch still runs, but the game only starts once you update it in ${client[1]}.`;
}

function StepIcon({ status }: { status: JobStep['status'] }) {
  const cls = 'size-4 shrink-0';
  if (status === 'done') return <Check className={`${cls} text-success`} />;
  if (status === 'running') return <Loader2 className={`${cls} animate-spin text-accent`} />;
  if (status === 'failed') return <XCircle className={`${cls} text-danger`} />;
  if (status === 'skipped') return <CircleDashed className={`${cls} text-faint`} />;
  return <CircleDashed className={`${cls} text-faint`} />;
}

/** What the switch will not need to do. Shown with a plan, never a reason to stop the user. */
function PlanNotes({ notes }: { notes: readonly string[] }) {
  return (
    <>
      {notes.map((n) => (
        <p key={n} className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5 text-xs text-muted">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>{n}</span>
        </p>
      ))}
    </>
  );
}

/** Every adapter step with its technical detail line; shown behind "Show details". */
function JobProgress({ job }: { job: LaunchJob }) {
  return (
    <ol className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2/40 px-3 py-2">
      {job.steps.map((s, i) => (
        <li
          key={`${i}-${s.title}`}
          className={`flex items-start gap-2.5 text-xs ${s.status === 'pending' || s.status === 'skipped' ? 'text-muted' : 'text-text'}`}
        >
          <span className="mt-px">
            <StepIcon status={s.status} />
          </span>
          <div className="min-w-0">
            <div>
              {s.title}
              {s.status === 'running' ? '…' : ''}
              {s.status === 'skipped' ? <span className="ml-2 text-[11px] text-faint">skipped</span> : null}
            </div>
            {s.detail && s.status !== 'skipped' ? <div className="truncate font-mono text-[11px] text-faint select-text">{s.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The one place that says the running launcher will be closed and started again; the preflight's plan leaves its own warning out. */
function CloseBox({ preflight, clientName, accountName }: { preflight: LaunchPreflight; clientName: string; accountName: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
      <Power className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">{preflight.closeMessage ?? `${sentence(clientName)} is running. Switching closes it.`}</p>
        <p className="mt-0.5 text-xs">
          {sentence(clientName)} is then started again as {accountName}.
        </p>
      </div>
    </div>
  );
}

/** The switch as five plain phases. */
function PhaseProgress({ job, names }: { job: LaunchJob; names: PhaseNames }) {
  const phases = groupSteps(job.steps, job.state === 'running');
  return (
    <ol className="flex flex-col gap-2">
      {phases.map((p) => (
        <li key={p.id} className={`flex items-start gap-2.5 text-sm ${p.status === 'pending' || p.status === 'skipped' ? 'text-muted' : 'text-text'}`}>
          <span className="mt-0.5">
            <StepIcon status={p.status} />
          </span>
          <div className="min-w-0">
            <div>
              {phaseLabel(p.id, names)}
              {p.status === 'running' ? '…' : ''}
              {p.status === 'skipped' ? <span className="ml-2 text-[11px] text-faint">not needed</span> : null}
            </div>
            {p.current && p.status !== 'done' && !(p.status === 'running' && job.attention) ? (
              <div className="text-xs text-muted">{p.current.title}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function copyNote(field: 'login' | 'password', clearAfterMs: number, historyExcluded: boolean): string {
  const what = field === 'login' ? 'Login' : 'Password';
  const history = field === 'password' && !historyExcluded ? ' · Windows clipboard history may keep it' : '';
  return `${what} copied · clipboard clears in ${Math.round(clearAfterMs / 1000)}s while One Launch is open${history}`;
}

/** A hand-over step with whatever the adapter quoted (the launcher's checkbox or button) set off, so the one thing to tick stands out. */
function emphasizeQuoted(text: string): ReactNode[] {
  return text.split(/(“[^”]+”|"[^"]+")/).map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-medium text-text-strong">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

/** The switch is parked on the launcher's sign-in form and needs the user there. Calm, explicit, no failure. */
function AttentionPanel({
  attention,
  accountId,
  launcherName,
  stopping,
  onCancel,
}: {
  attention: LaunchAttention;
  accountId: string;
  launcherName: string;
  stopping: boolean;
  onCancel: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);

  async function copy(field: 'login' | 'password'): Promise<void> {
    try {
      const { clearAfterMs, historyExcluded } = await ipc.invoke('accounts:copy', { id: accountId, field });
      setNote(copyNote(field, clearAfterMs, historyExcluded));
    } catch (err) {
      setNote(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-3 text-sm text-text">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="font-medium text-text-strong">{attention.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{attention.message}</p>
          {attention.steps && attention.steps.length > 0 ? (
            <ol aria-label="What to do" className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-xs leading-relaxed text-text marker:text-muted">
              {attention.steps.map((step, i) => (
                <li key={i}>{emphasizeQuoted(step)}</li>
              ))}
            </ol>
          ) : null}
          {attention.reason ? (
            <p className="mt-1 font-mono text-[11px] text-faint">
              {launcherName}: {attention.reason}
            </p>
          ) : null}
        </div>
      </div>
      <div className="ml-6 flex flex-wrap items-center gap-2">
        <Button icon={<Copy />} onClick={() => void copy('login')}>
          Copy login
        </Button>
        {attention.canCopyPassword ? (
          <Button icon={<Copy />} onClick={() => void copy('password')}>
            Copy password
          </Button>
        ) : null}
        <Button variant="ghost" disabled={stopping} onClick={onCancel}>
          {stopping ? 'Stopping…' : 'Stop waiting'}
        </Button>
        {note ? <span className="text-xs text-faint">{note}</span> : null}
      </div>
    </div>
  );
}

function AccountPicker({ accounts, selected, onSelect }: { accounts: Account[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
      {accounts.map((a) => {
        const active = a.id === selected;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect(a.id)}
            aria-pressed={active}
            className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${active ? 'bg-accent-soft' : 'hover:bg-surface-2/60'}`}
          >
            <span className={`flex size-4 items-center justify-center rounded-full border ${active ? 'border-accent bg-accent' : 'border-border-strong'}`}>
              {active ? <Check className="size-3 text-white" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-text-strong">{a.displayName}</span>
                {a.tags.map((t) => (
                  <span key={t} className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-muted">
                    {t}
                  </span>
                ))}
              </div>
              <div className="truncate text-xs text-muted">{a.login}</div>
            </div>
            <span className="shrink-0 text-xs text-faint">{a.lastUsedAt ? `Used ${formatRelative(a.lastUsedAt)}` : 'Never used'}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Launch flow (spec section 10): pick an account → preflight → confirm closing the launcher if needed →
 * step-by-step progress → launched, or failed with the rollback state. The job itself lives in the
 * store (see LaunchHost), so the dialog can be hidden and reopened while it runs.
 */
export function LaunchDialog({ game, initialAccountId = null, onClose }: LaunchDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef);
  const accounts = useIpcQuery(() => ipc.invoke('accounts:list'));
  const setView = useUiStore((s) => s.setView);
  const newAccount = useUiStore((s) => s.newAccount);
  const importAccounts = useUiStore((s) => s.importAccounts);
  const settingsChanged = useUiStore((s) => s.settingsChanged);
  const active = useUiStore((s) => s.activeLaunch);
  const setActiveLaunch = useUiStore((s) => s.setActiveLaunch);
  const all = accounts.data?.accounts ?? [];
  const launcher: LauncherId | null = game?.launcher ?? all.find((a) => a.id === initialAccountId)?.launcher ?? null;
  const launcherName = launcher ? LAUNCHER_DISPLAY_NAMES[launcher] : 'the launcher';
  const clientName = launcher ? LAUNCHER_CLIENT_NAMES[launcher] : 'the launcher';
  const canImport = launcher === 'steam' || launcher === 'battlenet';
  const candidates = sortAccounts(launcher ? all.filter((a) => a.launcher === launcher) : all);
  const [selected, setSelected] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [submitting, setSubmitting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [attachedId, setAttachedId] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const mounted = useRef(true);

  const busy = stage.kind === 'checking' || stage.kind === 'running' || submitting;
  const stopping = stage.kind === 'running' && stopRequested === stage.job.id;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Follow the job the app already has: a running one always, a finished one when it was for this game.
  useEffect(() => {
    const current = useUiStore.getState().activeLaunch;
    if (!current) return;
    if (current.job.state === 'running' || (current.game?.id ?? null) === (game?.id ?? null)) setAttachedId(current.job.id);
    else setActiveLaunch(null);
  }, [game, setActiveLaunch]);

  useEffect(() => {
    if (!attachedId || !active || active.job.id !== attachedId) return;
    setStage(active.job.state === 'running' ? { kind: 'running', job: active.job } : { kind: 'finished', job: active.job });
  }, [active, attachedId]);

  useEffect(() => {
    if (selected === null && candidates.length > 0) {
      const preferred = initialAccountId ? candidates.find((a) => a.id === initialAccountId) : undefined;
      const recent = preferred ?? [...candidates].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0]!;
      setSelected(recent.id);
    }
  }, [candidates, selected, initialAccountId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  useEffect(() => {
    if (stage.kind !== 'pick') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.shiftKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      void check();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const account = candidates.find((a) => a.id === selected) ?? null;
  const empty = stage.kind === 'pick' && !accounts.loading && !accounts.error && candidates.length === 0;
  useFocusWhenReady(account !== null && stage.kind === 'pick', dialogRef, closeRef, primaryRef);
  const names: PhaseNames = { launcher: clientName, account: account?.displayName ?? '', game: game?.name ?? null };
  const jobNames = (job: LaunchJob): PhaseNames => ({ launcher: clientName, account: job.account.displayName, game: job.game?.name ?? null });

  async function check(): Promise<void> {
    if (!account) return;
    setStage({ kind: 'checking' });
    try {
      const { preflight } = await ipc.invoke('launch:preflight', { accountId: account.id, gameId: game?.id ?? null });
      if (!mounted.current) return;
      if (preflight.blocked) setStage({ kind: 'blocked', preflight });
      else if (preflight.dryRun) setStage({ kind: 'dryRun', preflight });
      else if (preflight.needsConfirmation || preflight.plan.warnings.length > 0) setStage({ kind: 'confirm', preflight });
      else await start(false);
    } catch (err) {
      if (mounted.current) setStage({ kind: 'error', message: errorMessage(err) });
    }
  }

  async function start(confirmClose: boolean): Promise<void> {
    if (!account || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const { job } = await ipc.invoke('launch:start', { accountId: account.id, gameId: game?.id ?? null, confirmClose });
      setActiveLaunch({ job, game });
      if (!mounted.current) return;
      setAttachedId(job.id);
      setStage({ kind: 'running', job });
    } catch (err) {
      if (!mounted.current) return;
      // The launcher started between the preflight and the start: show the confirmation instead of a dead end.
      if (err instanceof IpcError && err.code === 'CONFIRM_REQUIRED') {
        try {
          const { preflight } = await ipc.invoke('launch:preflight', { accountId: account.id, gameId: game?.id ?? null });
          if (mounted.current) setStage({ kind: 'confirm', preflight });
        } catch (again) {
          if (mounted.current) setStage({ kind: 'error', message: errorMessage(again) });
        }
        return;
      }
      setStage({ kind: 'error', message: errorMessage(err) });
    } finally {
      submittingRef.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  /** Turns preview mode off and runs the switch that was just previewed. */
  async function switchNow(): Promise<void> {
    try {
      await ipc.invoke('settings:set', { key: 'dryRun', value: 'false' });
      settingsChanged();
    } catch (err) {
      if (mounted.current) setStage({ kind: 'error', message: errorMessage(err) });
      return;
    }
    await check();
  }

  async function cancel(jobId: string): Promise<void> {
    setStopRequested(jobId);
    try {
      await ipc.invoke('launch:cancel', { jobId });
    } catch (err) {
      if (!mounted.current) return;
      setStopRequested(null);
      setNote(errorMessage(err));
    }
  }

  function finish(): void {
    setActiveLaunch(null);
    onClose();
  }

  function tryAgain(): void {
    setActiveLaunch(null);
    setAttachedId(null);
    setNote(null);
    setStage({ kind: 'pick' });
  }

  /** Sends the user off to add or import an account for this launcher; the game comes along so the form or the import can bring them back to Play. */
  function goToAccounts(): void {
    onClose();
    if (launcher === 'steam' || launcher === 'battlenet') importAccounts(launcher, game);
    else if (launcher) newAccount(launcher, game);
    else setView('accounts');
  }

  const title = game ? game.name : 'Switch account';
  const actionLabel = game ? 'Play' : 'Switch';
  const actionIcon = game ? <Play /> : <ArrowRightLeft />;

  return (
    <div className="fixed inset-x-0 top-9 bottom-0 z-30 flex items-center justify-center bg-bg/70 p-6" onClick={busy ? undefined : onClose} role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-title"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h2 id="launch-title" className="truncate text-base font-semibold text-text-strong">
                {title}
              </h2>
              {launcher ? (
                <span title={game?.launcherGameId ? `${launcherName} id: ${game.launcherGameId}` : undefined}>
                  <LauncherBadge launcher={launcher} />
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {account
                ? game
                  ? `Play as ${account.displayName}`
                  : `Switch ${launcherName} to ${account.displayName}`
                : empty
                  ? 'Add an account first'
                  : 'Pick the account to use'}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded p-1 text-muted hover:text-text disabled:opacity-40 [&>svg]:size-4"
          >
            <X />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {accounts.error ? <p className="text-sm text-danger">Could not load accounts: {accounts.error}</p> : null}

          {(stage.kind === 'pick' || stage.kind === 'checking') && game?.needsUpdate && !empty ? (
            <p className="mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{updateNote(game, clientName)}</span>
            </p>
          ) : null}

          {stage.kind === 'pick' || stage.kind === 'checking' ? (
            empty ? (
              <p className="text-sm text-muted">
                {launcher ? `No ${launcherName} accounts yet.` : 'No accounts yet.'}
                {launcher === 'steam'
                  ? ' Import the ones Steam remembers, or add one by hand on the Accounts page.'
                  : launcher === 'battlenet'
                    ? ' Import the logins Battle.net has saved, or add one by hand on the Accounts page.'
                    : launcher
                      ? ''
                      : ' Add one on the Accounts page.'}
              </p>
            ) : candidates.length > 0 ? (
              <AccountPicker accounts={candidates} selected={selected} onSelect={setSelected} />
            ) : null
          ) : null}

          {stage.kind === 'confirm' ? (
            <div className="flex flex-col gap-3">
              {stage.preflight.needsConfirmation ? (
                <CloseBox preflight={stage.preflight} clientName={clientName} accountName={account?.displayName ?? ''} />
              ) : null}
              {stage.preflight.plan.warnings.map((w) => (
                <p key={w} className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5 text-xs text-text">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span>{w}</span>
                </p>
              ))}
              <PlanNotes notes={stage.preflight.plan.notes} />
              <details className="text-xs text-muted">
                <summary className="cursor-pointer select-none">Details</summary>
                <div className="mt-2">
                  <SwitchPlanView plan={stage.preflight.plan} />
                </div>
              </details>
            </div>
          ) : null}

          {stage.kind === 'dryRun' ? (
            <div className="flex flex-col gap-3">
              <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5 text-sm text-text">
                <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>Preview mode is on, so nothing happened. A real switch would do this:</span>
              </p>
              <ol className="flex flex-col gap-1.5 pl-1 text-sm text-text">
                {planPhases(stage.preflight.plan, game !== null).map((id, i) => (
                  <li key={id} className="flex items-center gap-2.5">
                    <span className="w-4 text-right text-xs text-faint">{i + 1}.</span>
                    {phaseLabel(id, names)}
                  </li>
                ))}
              </ol>
              {stage.preflight.needsConfirmation ? (
                <CloseBox preflight={stage.preflight} clientName={clientName} accountName={account?.displayName ?? ''} />
              ) : null}
              {stage.preflight.plan.warnings.map((w) => (
                <p key={w} className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5 text-xs text-text">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span>{w}</span>
                </p>
              ))}
              <PlanNotes notes={stage.preflight.plan.notes} />
              <details className="text-xs text-muted">
                <summary className="cursor-pointer select-none">Details</summary>
                <div className="mt-2">
                  <SwitchPlanView plan={stage.preflight.plan} />
                </div>
              </details>
            </div>
          ) : null}

          {stage.kind === 'blocked' ? (
            <div className="flex flex-col gap-3">
              <p className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <span>{stage.preflight.blocked}</span>
              </p>
              <details className="text-xs text-muted">
                <summary className="cursor-pointer select-none">Details</summary>
                <div className="mt-2">
                  <SwitchPlanView plan={stage.preflight.plan} />
                </div>
              </details>
            </div>
          ) : null}

          {stage.kind === 'running' || stage.kind === 'finished' ? (
            <div className="flex flex-col gap-4">
              {stage.kind === 'finished' ? (
                stage.job.state === 'done' ? (
                  <div className="flex flex-col gap-3">
                    <StatusPill tone="ok">
                      <Check className="size-3" /> {stage.job.game && !stage.job.handOff ? 'Launched as' : 'Switched to'} {stage.job.account.displayName}
                    </StatusPill>
                    {stage.job.handOff ? (
                      <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm text-text-strong">
                        <Play className="mt-0.5 size-4 shrink-0 text-accent" />
                        <span>{stage.job.handOff}</span>
                      </p>
                    ) : null}
                  </div>
                ) : stage.job.state === 'needs-sign-in' || stage.job.state === 'cancelled' ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
                    <p className="flex items-start gap-2">
                      <KeyRound className="mt-0.5 size-4 shrink-0" />
                      <span>{stage.job.error}</span>
                    </p>
                    <p className="ml-6 text-xs empty:hidden">{stoppedNote(stage.job, clientName, actionLabel)}</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
                    <p className="flex items-start gap-2">
                      <XCircle className="mt-0.5 size-4 shrink-0" />
                      <span>{stage.job.error ?? 'The switch failed.'}</span>
                    </p>
                    <p className="ml-6 text-xs">
                      {stage.job.restored === true
                        ? `${sentence(clientName)} was put back the way it was and left closed. Start it to check which account it signs in as.`
                        : stage.job.restored === false
                          ? `${sentence(clientName)} could not be put back automatically. Open Settings › Backups and restore the latest snapshot.`
                          : stage.job.switched
                            ? `${sentence(clientName)} is signed in as ${stage.job.account.displayName}; only the game launch failed. Press Play again to retry the launch.`
                            : 'Nothing had been changed yet.'}
                    </p>
                  </div>
                )
              ) : null}
              {stage.kind === 'running' && stage.job.attention ? (
                <AttentionPanel
                  attention={stage.job.attention}
                  accountId={stage.job.account.id}
                  launcherName={launcherName}
                  stopping={stopping}
                  onCancel={() => void cancel(stage.job.id)}
                />
              ) : null}
              <PhaseProgress job={stage.job} names={jobNames(stage.job)} />
              <button type="button" onClick={() => setShowDetails((d) => !d)} className="self-start text-xs text-faint hover:text-muted">
                {showDetails ? 'Hide details' : 'Show details'}
              </button>
              {showDetails ? <JobProgress job={stage.job} /> : null}
            </div>
          ) : null}

          <p role="status" className="sr-only">
            {stage.kind === 'running' || stage.kind === 'finished'
              ? jobAnnouncement(stage.job, jobNames(stage.job))
              : stage.kind === 'checking'
                ? `Checking ${clientName}…`
                : ''}
          </p>

          {stage.kind === 'error' ? (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>{stage.message}</span>
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <div className="text-xs text-muted">
            {note ?? (stage.kind === 'running' ? (stage.job.attention ? '' : 'Working…') : stage.kind === 'checking' ? `Checking ${clientName}…` : '')}
          </div>
          <div className="flex items-center gap-2">
            {empty ? (
              <Button variant="primary" icon={<KeyRound />} autoFocus onClick={goToAccounts}>
                {launcher ? (canImport ? `Import ${launcherName} accounts` : `Add ${launcherName} account`) : 'Go to Accounts'}
              </Button>
            ) : stage.kind === 'pick' || stage.kind === 'checking' ? (
              <>
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button ref={primaryRef} variant="primary" icon={actionIcon} disabled={!account || busy} autoFocus onClick={() => void check()}>
                  {stage.kind === 'checking' ? 'Checking…' : actionLabel}
                </Button>
              </>
            ) : null}
            {stage.kind === 'confirm' ? (
              <>
                <Button variant="ghost" disabled={submitting} onClick={() => setStage({ kind: 'pick' })}>
                  Back
                </Button>
                {stage.preflight.needsConfirmation ? (
                  <Button variant="danger" icon={<Power />} disabled={submitting} onClick={() => void start(true)}>
                    {submitting ? 'Starting…' : `Close ${clientName} and continue`}
                  </Button>
                ) : (
                  <Button variant="primary" icon={actionIcon} disabled={submitting} onClick={() => void start(false)}>
                    {submitting ? 'Starting…' : 'Continue'}
                  </Button>
                )}
              </>
            ) : null}
            {stage.kind === 'dryRun' ? (
              <>
                <Button variant="ghost" onClick={() => setStage({ kind: 'pick' })}>
                  Back
                </Button>
                <Button variant="primary" icon={actionIcon} onClick={() => void switchNow()}>
                  Turn preview off and {game ? 'play' : 'switch'} now
                </Button>
              </>
            ) : null}
            {stage.kind === 'blocked' ? (
              <Button autoFocus onClick={() => setStage({ kind: 'pick' })}>
                Back
              </Button>
            ) : null}
            {stage.kind === 'running' ? (
              <>
                {stage.job.attention ? null : (
                  <Button
                    variant="ghost"
                    icon={<CircleStop />}
                    disabled={stopping}
                    onClick={() => void cancel(stage.job.id)}
                    title={`Stop the switch. Until ${clientName} is started again, anything already changed is put back; after that, ${clientName} finishes signing in on its own.`}
                  >
                    {stopping ? 'Stopping…' : 'Stop'}
                  </Button>
                )}
                <Button variant="ghost" icon={<EyeOff />} onClick={onClose} title="Keep the switch running and come back to it from the banner">
                  Hide
                </Button>
              </>
            ) : null}
            {stage.kind === 'finished' ? (
              <>
                {stage.job.state !== 'done' ? (
                  <Button icon={<RotateCcw />} onClick={tryAgain}>
                    Try again
                  </Button>
                ) : null}
                <Button variant="primary" autoFocus onClick={finish}>
                  Done
                </Button>
              </>
            ) : null}
            {stage.kind === 'error' ? <Button onClick={() => setStage({ kind: 'pick' })}>Back</Button> : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
