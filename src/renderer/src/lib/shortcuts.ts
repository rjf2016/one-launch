/** A modal dialog is up, so the page behind it must not answer a shortcut. */
export function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

function inField(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  return target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

/**
 * True when `e` is the plain Ctrl chord for `key` (a lower-case letter or a digit) and no modal dialog
 * is open. Shortcuts that must not fire from a text field pass `inFields: false`.
 */
export function isShortcut(e: KeyboardEvent, key: string, { inFields = true }: { inFields?: boolean } = {}): boolean {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== key) return false;
  if (!inFields && inField(e)) return false;
  return !modalOpen();
}
