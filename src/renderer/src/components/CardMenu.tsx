import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

export interface CardMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
}

interface CardMenuProps {
  x: number;
  y: number;
  title: string;
  subtitle: string;
  items: CardMenuItem[];
  onClose: () => void;
}

/**
 * The menu of a library card, opened by right-click, the card's "More" button, or the keyboard's
 * menu key. Focus moves into it and goes back to whatever opened it, so it works without a mouse.
 */
export function CardMenu({ x, y, title, subtitle, items, onClose }: CardMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [pos, setPos] = useState<CSSProperties>({ left: x, top: y });

  // Runs before the first paint, so the unclamped position is never seen; hiding the menu until then would make its items unfocusable.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    openerRef.current = document.activeElement;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const onPointer = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  function closeToOpener(): void {
    const opener = openerRef.current;
    onClose();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    const focusable = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = focusable.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') focusable[(at + 1) % focusable.length]?.focus();
    else if (e.key === 'ArrowUp') focusable[(at - 1 + focusable.length) % focusable.length]?.focus();
    else if (e.key === 'Home') focusable[0]?.focus();
    else if (e.key === 'End') focusable[focusable.length - 1]?.focus();
    else if (e.key === 'Escape' || e.key === 'Tab') closeToOpener();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`More for ${title}`}
      onKeyDown={onKey}
      style={pos}
      className="fixed z-40 min-w-52 overflow-hidden rounded-lg border border-border bg-surface-2 py-1 text-sm shadow-panel"
    >
      <div className="border-b border-border/60 px-3 py-1.5">
        <div className="truncate text-xs font-medium text-text-strong">{title}</div>
        <div className="truncate text-[11px] text-faint">{subtitle}</div>
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text hover:bg-surface-3 focus:bg-surface-3 focus:outline-none [&>svg]:size-4 [&>svg]:text-muted"
          onClick={() => {
            closeToOpener();
            item.onSelect();
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
