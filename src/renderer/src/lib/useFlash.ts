import { useEffect, useState } from 'react';

export type FlashTone = 'info' | 'success' | 'error';

export interface Flash {
  text: string;
  tone: FlashTone;
}

/** Momentary status text ("Saved", "3 added, 0 removed") that clears itself after `ms`. */
export function useFlash(): [Flash | null, (text: string, tone?: FlashTone, ms?: number) => void] {
  const [flash, setFlash] = useState<Flash | null>(null);
  const [tick, setTick] = useState(0);
  const [ttl, setTtl] = useState(2500);
  useEffect(() => {
    if (flash === null) return;
    const id = window.setTimeout(() => setFlash(null), ttl);
    return () => window.clearTimeout(id);
  }, [flash, tick, ttl]);
  return [
    flash,
    (text, tone = 'info', ms = tone === 'error' ? 6000 : 3000) => {
      setTtl(ms);
      setFlash({ text, tone });
      setTick((t) => t + 1);
    },
  ];
}

/** Classes for the element that shows a flash; with none it stays in the page, out of sight, so the next message is announced. */
export function flashClassOf(flash: Flash | null): string {
  return flash ? `text-xs ${flashClass[flash.tone]}` : 'sr-only';
}

export const flashClass: Record<FlashTone, string> = {
  info: 'text-muted',
  success: 'text-success',
  error: 'text-danger',
};
