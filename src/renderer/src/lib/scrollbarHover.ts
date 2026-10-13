const CLASS = 'sb-hover';

function isScroller(el: Element): boolean {
  const cs = getComputedStyle(el);
  return /(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX);
}

function sync(target: Element | null): void {
  const inside = new Set<Element>();
  for (let el = target; el && el !== document.documentElement; el = el.parentElement) {
    if (isScroller(el)) inside.add(el);
  }
  for (const el of document.querySelectorAll(`.${CLASS}`)) if (!inside.has(el)) el.classList.remove(CLASS);
  for (const el of inside) el.classList.add(CLASS);
}

/**
 * Marks the scroll container under the pointer with `.sb-hover`, which index.css uses to show its
 * scrollbar thumb. Chromium does not repaint custom scrollbars when only the host's :hover changes,
 * so a CSS-only rule flickers; toggling a class forces the repaint.
 */
export function installScrollbarHover(): void {
  document.addEventListener('mouseover', (e) => sync(e.target as Element | null), { passive: true });
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget === null) sync(null);
  });
}
