import type { JobStep, JobStepStatus, LaunchJob, SwitchPlan } from '@shared/models';

/** A user-level phase of a switch. The adapters report a dozen technical steps; the dialog shows these five. */
export type PhaseId = 'close' | 'switch' | 'start' | 'signin' | 'launch';

const PHASE_OF: Record<string, PhaseId> = {
  close: 'close',
  capture: 'switch',
  backup: 'switch',
  file: 'switch',
  registry: 'switch',
  'registry-user': 'switch',
  'registry-remember': 'switch',
  start: 'start',
  wait: 'start',
  verify: 'signin',
  login: 'signin',
  manual: 'signin',
  recapture: 'signin',
  launch: 'launch',
};

const ORDER: readonly PhaseId[] = ['close', 'switch', 'start', 'signin', 'launch'];

export function phaseOf(stepId: string): PhaseId {
  return PHASE_OF[stepId] ?? 'switch';
}

export interface PhaseNames {
  launcher: string;
  account: string;
  game: string | null;
}

export function phaseLabel(id: PhaseId, names: PhaseNames): string {
  switch (id) {
    case 'close':
      return `Close ${names.launcher}`;
    case 'switch':
      return `Switch to ${names.account}`;
    case 'start':
      return `Start ${names.launcher}`;
    case 'signin':
      return 'Sign in';
    case 'launch':
      return names.game ? `Launch ${names.game}` : 'Launch';
  }
}

export interface Phase {
  id: PhaseId;
  status: JobStepStatus;
  /** The step that explains the phase's state: the running one, or the one that failed. */
  current: JobStep | null;
}

/**
 * Groups a job's steps into phases. A phase is done when its last real step is done even if an
 * earlier one failed (a hand-over after a failed automatic sign-in), running while any step runs
 * or between steps, and failed when the job stopped while it was underway.
 */
export function groupSteps(steps: readonly JobStep[], jobRunning: boolean): Phase[] {
  const out: Phase[] = [];
  for (const id of ORDER) {
    const members = steps.filter((s) => phaseOf(s.id) === id);
    if (members.length === 0) continue;
    const live = members.filter((s) => s.status !== 'skipped');
    const running = live.find((s) => s.status === 'running') ?? null;
    const last = live[live.length - 1] ?? null;
    const failed = [...live].reverse().find((s) => s.status === 'failed') ?? null;
    let status: JobStepStatus;
    if (running) status = 'running';
    else if (!last) status = 'skipped';
    else if (last.status === 'done' && live.every((s) => s.status === 'done' || s.status === 'failed')) status = 'done';
    else if (last.status === 'failed') status = 'failed';
    else if (live.some((s) => s.status === 'done' || s.status === 'failed')) status = 'running';
    else status = 'pending';
    if (status === 'running' && !jobRunning) status = 'failed';
    out.push({ id, status, current: running ?? (status === 'failed' ? (failed ?? last) : null) });
  }
  return out;
}

/** Starts a sentence with a name that reads mid-sentence, such as "the Riot Client". */
export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The line under a stopped or timed-out job's own sentence: what state the launcher was left in.
 * Null when the adapter's sentence already says everything (stopped before or while the launcher started).
 * `launcherName` is the program's name as it reads mid-sentence (LAUNCHER_CLIENT_NAMES).
 */
export function stoppedNote(
  job: Pick<LaunchJob, 'state' | 'switched' | 'restored' | 'steps' | 'account' | 'game'>,
  launcherName: string,
  actionLabel: string,
): string | null {
  if (job.switched) return `${sentence(launcherName)} is signed in as ${job.account.displayName}. Press ${actionLabel} again to launch the game.`;
  if (job.restored === true) return `${sentence(launcherName)} was put back the way it was and left closed.`;
  if (job.restored === false) return `${sentence(launcherName)} could not be put back automatically. Open Settings › Backups and restore the latest snapshot.`;
  const handedOver = job.steps.some((s) => s.id === 'manual' && s.status !== 'pending' && s.status !== 'skipped');
  if (job.state === 'cancelled' && !handedOver) return null;
  return `Nothing was rolled back. Once ${launcherName} is signed in, press ${actionLabel} again${job.game ? ' to launch the game' : ''}.`;
}

/**
 * One sentence for a screen reader, changing only when the job moves on: the phase underway, the
 * sign-in it is waiting for, or how it ended. The visible list repaints on every poll, so it is not the live region.
 */
export function jobAnnouncement(
  job: Pick<LaunchJob, 'state' | 'steps' | 'attention' | 'error' | 'account' | 'game'> & { handOff?: string | null },
  names: PhaseNames,
): string {
  if (job.state === 'running') {
    if (job.attention) return job.attention.title;
    const active = groupSteps(job.steps, true).find((p) => p.status === 'running');
    return active ? `${phaseLabel(active.id, names)}…` : 'Working…';
  }
  if (job.state === 'done') {
    if (job.handOff) return `Switched to ${job.account.displayName}. ${job.handOff}`;
    return `${job.game ? 'Launched as' : 'Switched to'} ${job.account.displayName}`;
  }
  return job.error ?? 'The switch failed.';
}

/** The phases a plan would run, in order, for the preview list. */
export function planPhases(plan: SwitchPlan, withLaunch: boolean): PhaseId[] {
  const seen = new Set<PhaseId>();
  for (const s of plan.steps) if (!s.skipped) seen.add(phaseOf(s.id));
  if (withLaunch) seen.add('launch');
  return ORDER.filter((id) => seen.has(id));
}
