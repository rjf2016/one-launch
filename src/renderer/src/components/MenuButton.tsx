import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Small grey text under the label, e.g. why an item is unavailable. */
  hint?: string;
  disabled?: boolean;
  onSelect?: () => void;
}

interface MenuButtonProps {
  label: ReactNode;
  icon?: ReactNode;
  items: MenuItem[];
  variant?: 'primary' | 'secondary';
  /** Which edge of the trigger the menu lines up with. */
  align?: 'left' | 'right';
  className?: string;
}

/** A button that opens a small action menu (one click per item), positioned like the app's dropdowns. */
export function MenuButton({ label, icon, items, variant = 'secondary', align = 'right', className = '' }: MenuButtonProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [pos, setPos] = useState<CSSProperties>({});
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current;
    const w = menu?.offsetWidth ?? 200;
    const h = menu?.offsetHeight ?? 0;
    const below = r.bottom + 6;
    const left = align === 'right' ? r.right - w : r.left;
    setPos({
      left: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
      ...(below + h <= window.innerHeight - 8 ? { top: below } : { bottom: window.innerHeight - r.top + 6 }),
    });
  }, [open, align]);

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

  function pick(index: number): void {
    const item = items[index];
    if (!item || item.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    item.onSelect?.();
  }

  function move(delta: number): void {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(highlight);
    const next = at === -1 ? (delta > 0 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
    setHighlight(enabled[next]!);
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home') setHighlight(enabled[0] ?? -1);
    else if (e.key === 'End') setHighlight(enabled[enabled.length - 1] ?? -1);
    else if (e.key === 'Enter' || e.key === ' ') pick(highlight);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      triggerRef.current?.focus();
    } else return;
    e.preventDefault();
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant={variant}
        icon={icon}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className={className}
        onClick={() => {
          setHighlight(-1);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight(enabled[0] ?? -1);
            setOpen(true);
          }
        }}
      >
        {label}
        <ChevronDown
          className={`-mr-0.5 size-3.5 transition-transform duration-150 ${variant === 'primary' ? 'text-white/70' : 'text-faint'} ${open ? 'rotate-180' : ''}`}
        />
      </Button>
      {open ? (
        <div
          ref={menuRef}
          id={id}
          role="menu"
          tabIndex={-1}
          onKeyDown={onMenuKey}
          style={pos}
          className="fixed z-40 min-w-48 rounded-lg border border-border bg-surface-2 p-1 text-left shadow-panel focus:outline-none"
        >
          {items.map((item, i) => (
            <div
              key={item.id}
              role="menuitem"
              aria-disabled={item.disabled || undefined}
              onPointerMove={() => !item.disabled && setHighlight(i)}
              onClick={() => pick(i)}
              className={`flex items-center gap-2.5 rounded-md py-1.5 pr-3 pl-2.5 text-sm whitespace-nowrap ${
                item.disabled ? 'cursor-default text-faint' : i === highlight ? 'cursor-pointer bg-surface-3 text-text-strong' : 'cursor-pointer text-text'
              }`}
            >
              {item.icon ? <span className={`[&>svg]:size-4 ${item.disabled ? 'opacity-50' : ''}`}>{item.icon}</span> : null}
              <span className="min-w-0">
                <span className="block">{item.label}</span>
                {item.hint ? <span className="block text-[11px] text-faint">{item.hint}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
