import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, description, actions, children }: PanelProps) {
  return (
    <section className="rounded-panel border border-border bg-surface shadow-panel">
      <header className={`flex ${description ? 'items-start' : 'items-center'} justify-between gap-4 border-b border-border px-5 py-4`}>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-strong">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

interface RowProps {
  label: string;
  hint?: string;
  /** Where the right-hand side sits: on the label's line (values, toggles) or centred on label plus hint (tall controls). */
  align?: 'label' | 'center';
  children?: ReactNode;
}

/** A labelled row inside a Panel: label on the left, control or value on the right. */
export function Row({ label, hint, align = 'label', children }: RowProps) {
  return (
    <div className={`flex ${align === 'label' ? 'items-start' : 'items-center'} justify-between gap-6 py-2.5 not-last:border-b not-last:border-border/60`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-text">{label}</div>
        {hint ? <div className="text-xs text-muted">{hint}</div> : null}
      </div>
      <div
        className={`flex min-w-0 max-w-[60%] shrink-0 items-center justify-end gap-2 text-right text-sm text-muted [&_.font-mono]:break-all ${align === 'label' ? 'min-h-5' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
