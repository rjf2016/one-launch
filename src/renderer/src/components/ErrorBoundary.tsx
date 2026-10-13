import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ipc } from '../lib/ipc';

interface State {
  error: Error | null;
}

/**
 * Last line of defence for the renderer: a render exception used to blank the window with nothing
 * in the log. This reports it to main (which writes onelaunch.log) and shows a way out.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    void ipc
      .invoke('app:reportError', { source: 'render', message: error.message, stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}` })
      .catch(() => undefined);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg p-8 text-center text-text">
        <h1 className="text-lg font-semibold text-text-strong">Something went wrong in the interface</h1>
        <p className="max-w-md text-sm text-muted">
          The details are in the log. Reloading brings the interface back; nothing you stored is affected, and any switch that was running continues on its own.
        </p>
        <p className="max-w-lg font-mono text-xs text-faint select-text">{this.state.error.message}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => void ipc.invoke('app:openPath', { target: 'logs' }).catch(() => undefined)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2"
          >
            Open logs
          </button>
        </div>
      </div>
    );
  }
}
