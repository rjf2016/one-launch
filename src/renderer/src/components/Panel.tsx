import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** A card: title and a one-line description on the left of the header, the actions centred on them to the right. */
export function Panel({ title, description, actions, children }: PanelProps) {
  return (
    <section className="rounded-panel border border-border bg-surface shadow-panel">
      <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-strong">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

interface RowProps {
  label: string;
  hint?: string;
  /** Why the last change to this row's setting was not saved. */
  error?: string | null;
  children?: ReactNode;
}

/**
 * A labelled row inside a Panel: label and hint on the left, the control or value centred on them to the right.
 * A hint is one line at the 960 px minimum width with the sidebar open; `views.mjs` fails on one that wraps.
 */
export function Row({ label, hint, error, children }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5 first:pt-0 last:pb-0 not-last:border-b not-last:border-border/60">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-text">{label}</div>
        {hint ? <div className="text-xs text-muted">{hint}</div> : null}
        {error ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            Could not save the setting: {error}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 max-w-[60%] shrink-0 items-center justify-end gap-2 text-right text-sm text-muted [&_.font-mono]:break-all">{children}</div>
    </div>
  );
}
