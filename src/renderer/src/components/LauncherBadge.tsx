import { LAUNCHER_DISPLAY_NAMES, type LauncherId } from '@shared/models';

/** Literal class names so Tailwind's scanner emits them; never build these dynamically. */
export const launcherDot: Record<LauncherId, string> = {
  steam: 'bg-steam',
  epic: 'bg-epic',
  battlenet: 'bg-battlenet',
  riot: 'bg-riot',
};

export function LauncherDot({ launcher, className = '' }: { launcher: LauncherId; className?: string }) {
  return <span className={`inline-block size-1.5 rounded-full ${launcherDot[launcher]} ${className}`} />;
}

export function LauncherBadge({ launcher }: { launcher: LauncherId }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
      <LauncherDot launcher={launcher} />
      {LAUNCHER_DISPLAY_NAMES[launcher]}
    </span>
  );
}
