import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../lib/useFocusTrap';
import { useUiStore } from '../store/ui';
import { Button } from './Button';

/** The app's own yes/no question, used by the leave guard instead of the browser's confirm(). */
export function ConfirmDialog() {
  const confirm = useUiStore((s) => s.confirm);
  const answer = useUiStore((s) => s.answerConfirm);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, confirm !== null);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        answer(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, answer]);

  if (!confirm) return null;
  return (
    <div className="fixed inset-x-0 top-9 bottom-0 z-50 flex items-center justify-center bg-bg/70 p-6" onClick={() => answer(false)} role="presentation">
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-md rounded-panel border border-border bg-surface shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 py-4">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0">
            <h2 id="confirm-title" className="text-sm font-semibold text-text-strong">
              {confirm.title}
            </h2>
            <p className="mt-1 text-sm text-muted">{confirm.message}</p>
          </div>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" autoFocus onClick={() => answer(false)}>
            {confirm.cancelLabel}
          </Button>
          <Button variant="danger" onClick={() => answer(true)}>
            {confirm.confirmLabel}
          </Button>
        </footer>
      </div>
    </div>
  );
}
