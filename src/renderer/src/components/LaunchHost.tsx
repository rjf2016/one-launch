import { Check, KeyRound, Loader2, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { ipc, IpcError } from '../lib/ipc';
import { useUiStore, type ActiveLaunch } from '../store/ui';
import { Button } from './Button';
import { LaunchDialog } from './LaunchDialog';

function errorMessage(err: unknown): string {
  if (err instanceof IpcError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function LaunchBanner({ launch }: { launch: ActiveLaunch }) {
  const openLaunch = useUiStore((s) => s.openLaunch);
  const setActiveLaunch = useUiStore((s) => s.setActiveLaunch);
  const { job } = launch;
  const running = job.state === 'running';
  const what = job.game ? `${job.game.name} as ${job.account.displayName}` : job.account.displayName;
  const text = running
    ? job.attention
      ? `Waiting for you to sign in as ${job.account.displayName}`
      : job.game
        ? `Switching to ${job.account.displayName} and launching ${job.game.name}…`
        : `Switching to ${job.account.displayName}…`
    : job.state === 'done'
      ? job.handOff
        ? `Switched to ${job.account.displayName}. ${job.handOff}`
        : job.game
          ? `Launched ${what}`
          : `Switched to ${what}`
      : job.state === 'needs-sign-in'
        ? `The switch to ${job.account.displayName} is waiting for a sign-in`
        : job.state === 'cancelled'
          ? `The switch to ${job.account.displayName} was stopped`
          : `The switch to ${job.account.displayName} failed`;
  const tone = running
    ? 'border-accent/30 bg-accent-soft text-text'
    : job.state === 'done'
      ? 'border-success/30 bg-success/10 text-success'
      : 'border-warning/30 bg-warning/10 text-warning';
  const Icon = running ? (job.attention ? KeyRound : Loader2) : job.state === 'done' ? Check : XCircle;
  return (
    <div role="status" className={`flex shrink-0 items-center gap-3 border-b px-4 py-1.5 text-xs ${tone}`}>
      <Icon className={`size-3.5 shrink-0 ${running && !job.attention ? 'animate-spin' : ''}`} />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <Button variant="ghost" onClick={() => openLaunch({ game: launch.game, initialAccountId: job.account.id })}>
        Show
      </Button>
      {running ? null : (
        <button
          type="button"
          onClick={() => setActiveLaunch(null)}
          aria-label="Dismiss"
          className="rounded p-1 text-current opacity-70 hover:opacity-100 [&>svg]:size-3.5"
        >
          <X />
        </button>
      )}
    </div>
  );
}

/**
 * Owns the launch dialog and the job it started, above every view: the dialog survives navigation,
 * the job keeps being polled while the dialog is hidden, and the banner brings it back.
 */
export function LaunchHost() {
  const request = useUiStore((s) => s.launchRequest);
  const active = useUiStore((s) => s.activeLaunch);
  const closeLaunch = useUiStore((s) => s.closeLaunch);
  const runningId = active?.job.state === 'running' ? active.job.id : null;
  const launchedId = active?.job.state === 'done' && !request ? active.job.id : null;

  // A finished launch needs no attention: the banner goes away by itself. Failures stay until dismissed.
  useEffect(() => {
    if (!launchedId) return;
    const id = window.setTimeout(() => {
      const current = useUiStore.getState().activeLaunch;
      if (current?.job.id === launchedId) useUiStore.getState().setActiveLaunch(null);
    }, 8000);
    return () => window.clearTimeout(id);
  }, [launchedId]);

  useEffect(() => {
    if (!runningId) return;
    let stopped = false;
    const poll = async (): Promise<void> => {
      const update = (job: ActiveLaunch['job']): void => {
        const current = useUiStore.getState().activeLaunch;
        if (current?.job.id === runningId) useUiStore.getState().setActiveLaunch({ ...current, job });
      };
      try {
        const { job } = await ipc.invoke('launch:status', { jobId: runningId });
        if (!stopped) update(job);
      } catch (err) {
        if (stopped) return;
        const current = useUiStore.getState().activeLaunch;
        if (current?.job.id === runningId) {
          update({ ...current.job, state: 'failed', error: errorMessage(err), finishedAt: new Date().toISOString() });
        }
      }
    };
    const id = window.setInterval(() => void poll(), 150);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [runningId]);

  return (
    <>
      {active && !request ? <LaunchBanner launch={active} /> : null}
      {request ? <LaunchDialog key={request.key} game={request.game} initialAccountId={request.initialAccountId} onClose={closeLaunch} /> : null}
    </>
  );
}
