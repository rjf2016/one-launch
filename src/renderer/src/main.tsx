import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ipc } from './lib/ipc';
import { installScrollbarHover } from './lib/scrollbarHover';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
installScrollbarHover();

// Errors outside React's render tree (event handlers, timers, promises) go to onelaunch.log through main.
function report(source: 'window' | 'promise', reason: unknown): void {
  const err = reason instanceof Error ? reason : null;
  void ipc.invoke('app:reportError', { source, message: err?.message ?? String(reason), stack: err?.stack ?? null }).catch(() => undefined);
}
window.addEventListener('error', (e) => report('window', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => report('promise', e.reason));

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
