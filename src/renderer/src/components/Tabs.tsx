import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface Tab<T extends string> {
  id: T;
  label: string;
}

interface TabListProps<T extends string> {
  label: string;
  tabs: readonly Tab<T>[];
  value: T;
  onChange: (tab: T) => void;
  /** Prefix for the tab and panel ids that tie a `TabList` to its `TabPanel`. */
  idBase: string;
}

/**
 * A row of tabs over a `TabPanel`. The arrows, Home and End move the focus and select at once (roving tabindex).
 * A tab's name is its text alone, so the drive scripts can click one by label.
 */
export function TabList<T extends string>({ label, tabs, value, onChange, idBase }: TabListProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function go(index: number): void {
    const at = (index + tabs.length) % tabs.length;
    const tab = tabs[at];
    if (!tab) return;
    onChange(tab.id);
    refs.current[at]?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'ArrowLeft') go(index - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(tabs.length - 1);
    else return;
    e.preventDefault();
  }

  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
      {tabs.map((tab, i) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors duration-150 ${
              selected ? 'border-accent text-text-strong' : 'border-transparent text-muted hover:text-text'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

interface TabPanelProps {
  idBase: string;
  id: string;
  children: ReactNode;
}

export function TabPanel({ idBase, id, children }: TabPanelProps) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`}>
      {children}
    </div>
  );
}
