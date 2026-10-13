import { useEffect, useRef, useState, type ReactNode } from 'react';

interface HScrollerProps {
  className?: string;
  children: ReactNode;
}

/**
 * A horizontal scroll row that fades whichever edge still has content beyond it, so a row that
 * continues off-screen reads as scrollable rather than clipped. The thin scrollbar stays for mouse users.
 */
export function HScroller({ className = '', children }: HScrollerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [children]);

  const fade = 'pointer-events-none absolute inset-y-0 bottom-3 w-10 transition-opacity duration-150';
  return (
    <div className="relative">
      <div ref={ref} className={`overflow-x-auto ${className}`}>
        {children}
      </div>
      <div aria-hidden className={`${fade} left-0 bg-gradient-to-r from-bg to-transparent ${edges.left ? 'opacity-100' : 'opacity-0'}`} />
      <div aria-hidden className={`${fade} right-0 bg-gradient-to-l from-bg to-transparent ${edges.right ? 'opacity-100' : 'opacity-0'}`} />
    </div>
  );
}
