import type { ReactNode } from 'react';
import type { HealthStatus } from '@shared/models';

type Tone = HealthStatus | 'info';

const tones: Record<Tone, string> = {
  ok: 'border-success/30 bg-success/10 text-success',
  warn: 'border-warning/30 bg-warning/10 text-warning',
  fail: 'border-danger/30 bg-danger/10 text-danger',
  absent: 'border-border bg-surface-2 text-muted',
  info: 'border-border bg-surface-2 text-muted',
};

/** Small status chip: "Healthy", "Running", "Needs attention". */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function healthLabel(status: HealthStatus): string {
  return status === 'ok' ? 'Healthy' : status === 'warn' ? 'Warnings' : status === 'absent' ? 'Not installed' : 'Problems';
}
