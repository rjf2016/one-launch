import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** A second row (search, filters) that stays pinned with the header. */
  toolbar?: ReactNode;
}

/** Pins to the top of a `Page` while the content scrolls underneath. */
export const stickyHeaderClass = 'sticky top-0 z-10 bg-bg pt-7 pb-5';

export function PageHeader({ title, subtitle, actions, toolbar }: PageHeaderProps) {
  return (
    <div className={stickyHeaderClass}>
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-xl font-semibold tracking-tight text-text-strong">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {toolbar ? <div className="mt-5">{toolbar}</div> : null}
    </div>
  );
}
