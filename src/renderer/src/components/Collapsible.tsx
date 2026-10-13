import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

interface CollapsibleProps {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** A section that stays folded until asked for: the place for controls most people never need. */
export function Collapsible({ title, hint, defaultOpen = false, children }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-sm transition-colors duration-150 hover:text-text-strong [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-faint"
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        <span className="font-medium text-text">{title}</span>
        {hint ? <span className="truncate text-xs text-faint">{hint}</span> : null}
      </button>
      {open ? <div className="mt-2 flex flex-col gap-4">{children}</div> : null}
    </section>
  );
}
