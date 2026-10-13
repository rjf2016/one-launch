import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface DropdownProps<T extends string> {
  /** null: nothing chosen (a filter that is off). */
  value: T | null;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** When set, choosing the current value again calls this instead: the menu doubles as an off switch. */
  onDeselect?: () => void;
  /** Show the chevron. Off for fixed-label toolbar triggers. */
  caret?: boolean;
  label: string;
  icon?: ReactNode;
  /** Toolbar sizing: matches the small buttons and chips instead of form inputs. */
  dense?: boolean;
  /** Highlight like a pressed filter: the value narrows what is shown. */
  active?: boolean;
  disabled?: boolean;
  className?: string;
  /** Fixed trigger text ("Filter", "Sort by") instead of echoing the current value; the value shows in the tooltip. */
  triggerLabel?: string;
}

/**
 * A select drawn entirely by the app. The native <select> popup is painted by the OS and cannot
 * match the theme, so the menu here is a fixed-position listbox anchored to the trigger.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
  icon,
  onDeselect,
  caret = true,
  dense = false,
  active = false,
  disabled = false,
  className = '',
  triggerLabel,
}: DropdownProps<T>) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});
  const current = value === null ? undefined : options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const below = r.bottom + 6;
    const fitsBelow = below + menuHeight <= window.innerHeight - 8;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 176) - 8)),
      minWidth: r.width,
      ...(fitsBelow ? { top: below } : { bottom: window.innerHeight - r.top + 6 }),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    const onPointer = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  function show(): void {
    setHighlight(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  }

  function choose(index: number): void {
    const opt = options[index];
    setOpen(false);
    triggerRef.current?.focus();
    if (!opt) return;
    if (opt.value === value) {
      if (onDeselect) onDeselect();
      return;
    }
    onChange(opt.value);
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'ArrowDown') setHighlight((h) => Math.min(options.length - 1, h + 1));
    else if (e.key === 'ArrowUp') setHighlight((h) => Math.max(0, h - 1));
    else if (e.key === 'Home') setHighlight(0);
    else if (e.key === 'End') setHighlight(options.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') choose(highlight);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      triggerRef.current?.focus();
    } else return;
    e.preventDefault();
  }

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show();
    }
  }

  const triggerClass = dense
    ? `gap-1.5 py-1.5 pr-2 pl-2.5 text-xs ${active ? 'border-accent bg-accent-soft text-text-strong' : 'border-border bg-surface text-muted hover:border-border-strong hover:text-text'}`
    : `gap-2 py-1.5 px-3 text-sm font-medium ${active ? 'border-accent bg-accent-soft text-text-strong' : 'border-border bg-surface-2 text-text hover:border-border-strong hover:bg-surface-3'}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={current ? `${label}: ${current.label}` : label}
        title={triggerLabel && current ? `${label}: ${current.label}` : label}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onTriggerKey}
        className={`inline-flex items-center rounded-lg border whitespace-nowrap transition-colors duration-150 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
          open ? 'border-border-strong' : ''
        } ${triggerClass} ${className}`}
      >
        {icon ? <span className={`[&>svg]:size-3.5 ${active ? 'text-accent' : 'text-faint'}`}>{icon}</span> : null}
        <span>{triggerLabel ?? current?.label ?? ''}</span>
        {caret ? (
          <ChevronDown className={`ml-0.5 text-faint transition-transform duration-150 ${dense ? 'size-3.5' : 'size-4'} ${open ? 'rotate-180' : ''}`} />
        ) : null}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={id}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-${highlight}`}
          onKeyDown={onMenuKey}
          style={pos}
          className="fixed z-40 min-w-44 rounded-lg border border-border bg-surface-2 p-1 text-left shadow-panel focus:outline-none"
        >
          {options.map((opt, i) => {
            const selected = opt.value === value;
            return (
              <div
                key={opt.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={selected}
                onPointerMove={() => setHighlight(i)}
                onClick={() => choose(i)}
                className={`flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-2.5 text-sm whitespace-nowrap ${
                  i === highlight ? 'bg-surface-3 text-text-strong' : selected ? 'text-text-strong' : 'text-text'
                }`}
              >
                {opt.icon ? <span className="text-faint [&>svg]:size-3.5">{opt.icon}</span> : null}
                <span className="flex-1">{opt.label}</span>
                <Check className={`size-3.5 ${selected ? 'text-accent' : 'invisible'}`} />
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
