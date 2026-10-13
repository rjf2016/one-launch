import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-2xl border border-border bg-surface text-muted [&>svg]:size-7">{icon}</div>
      <h3 className="text-base font-semibold text-text-strong">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
