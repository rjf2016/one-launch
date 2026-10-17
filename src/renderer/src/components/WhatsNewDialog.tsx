import { X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { groupWhatsNew, pickWhatsNew, type WhatsNewRelease, type WhatsNewTone } from '@shared/whats-new';
import { WHATS_NEW } from '@shared/whats-new-releases';
import { ipc } from '../lib/ipc';
import { useFocusTrap } from '../lib/useFocusTrap';
import { whatsNewImageUrl } from '../lib/whatsNewImages';
import { useUiStore } from '../store/ui';

/** How long the Library gets to paint before the card rises over it. */
const OPEN_DELAY_MS = 400;

const TONE: Record<WhatsNewTone, { text: string; line: string }> = {
  accent: { text: 'text-accent', line: 'bg-accent/40' },
  success: { text: 'text-success', line: 'bg-success/40' },
  warning: { text: 'text-warning', line: 'bg-warning/40' },
  danger: { text: 'text-danger', line: 'bg-danger/40' },
  steam: { text: 'text-steam', line: 'bg-steam/40' },
  epic: { text: 'text-epic', line: 'bg-epic/40' },
  battlenet: { text: 'text-battlenet', line: 'bg-battlenet/40' },
  riot: { text: 'text-riot', line: 'bg-riot/40' },
};

/** `YYYY-MM-DD` as the user's long date, built from the parts so the day never shifts with the time zone. */
export function formatReleaseDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** The card: the title and the release's date stay at the top while the image, the intro and the list of changes scroll under them. */
export function WhatsNewDialog({ release, version }: { release: WhatsNewRelease; version: string }) {
  const closeWhatsNew = useUiStore((s) => s.closeWhatsNew);
  const settingsChanged = useUiStore((s) => s.settingsChanged);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  useEffect(() => listRef.current?.focus(), []);
  useFocusTrap(dialogRef);

  /** Records the running version as seen, then closes. A save that fails still closes: the card returns next start, which is the truthful outcome. */
  const close = useCallback(async (): Promise<void> => {
    if (closingRef.current) return;
    closingRef.current = true;
    try {
      await ipc.invoke('settings:set', { key: 'whatsNew.lastSeen', value: version });
      settingsChanged();
    } catch {
      // nothing to show: the card comes back next start
    }
    closeWhatsNew();
  }, [closeWhatsNew, settingsChanged, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      void close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const groups = groupWhatsNew(release.items);
  const imageUrl = release.image ? whatsNewImageUrl(release.image.file) : null;
  let delay = 120;
  const rise = (): { animationDelay: string } => {
    const style = { animationDelay: `${Math.min(delay, 700)}ms` };
    delay += 50;
    return style;
  };

  return (
    <div
      className="fixed inset-x-0 top-9 bottom-0 z-40 flex items-center justify-center bg-bg/80 p-6 backdrop-blur-sm"
      role="presentation"
      onClick={() => void close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="guide-card relative flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(70%_100%_at_50%_0%,var(--color-accent-soft),transparent)]"
        />

        <header className="relative flex items-start justify-between gap-4 border-b border-border/60 px-8 pt-6 pb-4">
          <div>
            <h2 id="whats-new-title" className="guide-rise text-2xl font-semibold tracking-tight text-text-strong">
              What's New
            </h2>
            <p className="guide-rise mt-0.5 text-sm text-muted" style={{ animationDelay: '60ms' }}>
              {formatReleaseDate(release.date)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void close()}
            aria-label="Close"
            title="Close (Esc)"
            className="-mt-1 -mr-2 rounded-md p-1.5 text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text [&>svg]:size-4"
          >
            <X />
          </button>
        </header>

        <div ref={listRef} tabIndex={-1} className="relative min-h-0 flex-1 overflow-y-auto px-8 py-5 focus:outline-none">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={release.image?.alt ?? ''}
              draggable={false}
              className="guide-rise mb-5 w-full rounded-lg border border-border/60"
              style={rise()}
            />
          ) : null}
          {release.intro ? (
            <p className="guide-rise mb-5 text-sm text-text" style={rise()}>
              {release.intro}
            </p>
          ) : null}
          <div className="flex flex-col gap-6">
            {groups.map((group, g) => {
              const tone = TONE[group.heading?.tone ?? 'accent'];
              return (
                <div key={g}>
                  {group.heading ? (
                    <h3 className={`guide-rise mb-3 flex items-center gap-3 text-xs font-bold tracking-wider uppercase ${tone.text}`} style={rise()}>
                      <span>{group.heading.heading}</span>
                      <span aria-hidden className={`h-px flex-1 ${tone.line}`} />
                    </h3>
                  ) : null}
                  <ul className="flex flex-col gap-3.5">
                    {group.items.map((item) => (
                      <li key={item.lead} className="guide-rise flex gap-3 text-sm leading-relaxed" style={rise()}>
                        <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
                        <span>
                          <strong className="font-semibold text-text-strong">{item.lead}</strong>
                          {item.detail ? <span className="text-muted"> {item.detail}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Opens the card once, at startup, when the running version has notes the user has not seen. A start with the recovery
 * prompt or the setup guide up is left alone (the card comes back next start). With the setting off it only records
 * the running version as seen, so turning the setting on later never resurfaces old notes.
 */
export function WhatsNewHost({ releases = WHATS_NEW }: { releases?: readonly WhatsNewRelease[] }) {
  const request = useUiStore((s) => s.whatsNew);
  const openWhatsNew = useUiStore((s) => s.openWhatsNew);
  const settingsChanged = useUiStore((s) => s.settingsChanged);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    Promise.all([ipc.invoke('settings:getAll'), ipc.invoke('app:info'), ipc.invoke('recovery:get')])
      .then(([{ settings }, info, { recovery }]) => {
        if (cancelled || recovery) return;
        const lastSeen = settings['whatsNew.lastSeen'] ?? null;
        if (settings['whatsNew.enabled'] === 'false') {
          if (lastSeen !== info.version) {
            ipc
              .invoke('settings:set', { key: 'whatsNew.lastSeen', value: info.version })
              .then(() => {
                if (!cancelled) settingsChanged();
              })
              .catch(() => undefined);
          }
          return;
        }
        const release = pickWhatsNew(releases, info.version, lastSeen);
        if (!release) return;
        timer = window.setTimeout(() => {
          if (!cancelled && !useUiStore.getState().setupGuide) openWhatsNew({ release, version: info.version });
        }, OPEN_DELAY_MS);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [openWhatsNew, releases, settingsChanged]);

  return request ? <WhatsNewDialog key={request.release.version} release={request.release} version={request.version} /> : null;
}
