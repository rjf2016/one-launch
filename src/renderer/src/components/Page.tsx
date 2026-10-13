import type { ReactNode } from 'react';

interface PageProps {
  /** Forms and rows read best in a capped, centred column; the Library grid uses the full width. */
  narrow?: boolean;
  children: ReactNode;
}

/**
 * The scrolling surface of a view. The whole pane scrolls (wheel anywhere, gutters included) and the
 * scrollbar sits at the window edge; `PageHeader` stays pinned at the top while content passes under it.
 */
export function Page({ narrow = false, children }: PageProps) {
  return (
    <div className="h-full overflow-y-auto px-8">
      <div className={`mx-auto w-full ${narrow ? 'max-w-[65rem]' : ''}`}>{children}</div>
    </div>
  );
}
