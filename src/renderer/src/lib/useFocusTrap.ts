import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab and Shift+Tab inside `ref` while `active`, and puts focus on its first control when it
 * opens unless something inside already has it (React's `autoFocus` runs first). Focus returns to
 * where it was when the trap is released.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!root.contains(document.activeElement)) (focusables()[0] ?? root).focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [ref, active]);
}

/**
 * Moves the focus to `target` the first time `ready` is true, unless the user has already put it on
 * a control other than `close`. For dialogs whose primary action is disabled until data arrives:
 * `autoFocus` cannot focus a disabled control, so the trap settled on the Close button.
 */
export function useFocusWhenReady(
  ready: boolean,
  root: RefObject<HTMLElement | null>,
  close: RefObject<HTMLElement | null>,
  target: RefObject<HTMLElement | null>,
): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready) return;
    done.current = true;
    const current = document.activeElement;
    if (root.current?.contains(current) && current !== close.current) return;
    target.current?.focus();
  }, [ready, root, close, target]);
}
