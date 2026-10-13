import { Check, ChevronRight, KeyRound, Loader2, Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLoop } from '../lib/motion';
import { phaseLabel, type PhaseId, type PhaseNames } from '../lib/phases';

function Beat({ label, delay, children }: { label: string; delay: number; children: ReactNode }) {
  return (
    <div className="guide-rise flex flex-col items-center gap-2.5" style={{ animationDelay: `${delay}ms` }}>
      {children}
      <span className="text-[11px] font-medium text-muted">{label}</span>
    </div>
  );
}

/** The product in one picture: a game, an account that keeps changing, and Play. Decorative; the welcome copy says the same in words. */
export function FlowArt() {
  return (
    <div aria-hidden className="flex items-center gap-4 rounded-2xl border border-border bg-surface-2/50 px-7 py-5">
      <Beat label="Pick a game" delay={0}>
        <div className="relative flex h-[72px] w-12 items-end justify-center overflow-hidden rounded-md border border-border bg-gradient-to-b from-surface-2 to-surface-3 p-1">
          <span className="absolute inset-0 flex items-center justify-center text-lg font-semibold text-text-strong/10 select-none">CS</span>
          <span className="relative text-[9px] leading-tight font-semibold text-text-strong">CS2</span>
        </div>
      </Beat>
      <ChevronRight className="guide-rise size-4 shrink-0 text-faint" style={{ animationDelay: '80ms' }} />
      <Beat label="Pick an account" delay={140}>
        <div className="flex h-[72px] items-center">
          <span className="inline-flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-sm font-medium text-text-strong">
            <KeyRound className="size-4 shrink-0 text-accent" />
            <span className="relative inline-block h-5 w-10 text-left">
              <span className="guide-swap-a absolute inset-0">Main</span>
              <span className="guide-swap-b absolute inset-0">Alt</span>
            </span>
          </span>
        </div>
      </Beat>
      <ChevronRight className="guide-rise size-4 shrink-0 text-faint" style={{ animationDelay: '220ms' }} />
      <Beat label="Play" delay={280}>
        <div className="relative flex h-[72px] items-center justify-center">
          <span className="guide-ring absolute size-11 rounded-full border-2 border-accent" />
          <span className="flex size-11 items-center justify-center rounded-full bg-accent text-white shadow [&>svg]:size-5">
            <Play />
          </span>
        </div>
      </Beat>
    </div>
  );
}

const DEMO_NAMES: PhaseNames = { launcher: 'Steam', account: 'Alt', game: 'Counter-Strike 2' };
const DEMO_PHASES: readonly PhaseId[] = ['close', 'switch', 'start', 'signin', 'launch'];
const DEMO_HOLD = 3;

type DemoStatus = 'pending' | 'running' | 'done';

function demoStatus(stage: number, index: number): DemoStatus {
  if (stage === 0) return 'pending';
  if (stage > DEMO_PHASES.length) return 'done';
  if (index < stage - 1) return 'done';
  return index === stage - 1 ? 'running' : 'pending';
}

/** The launch dialog's phase list playing itself: every phase pending, then each in turn, then all done for a moment. Decorative. */
export function PhaseDemo() {
  const stage = useLoop(DEMO_PHASES.length + 1 + DEMO_HOLD, 850, DEMO_PHASES.length + 1);
  return (
    <div aria-hidden className="rounded-xl border border-border bg-surface-2/50 px-4 py-3.5">
      <div className="mb-3 flex items-center gap-1.5 text-xs text-muted">
        <Play className="size-3.5 shrink-0 text-accent" />
        <span className="font-medium text-text">{DEMO_NAMES.game}</span>
        <span className="text-faint">·</span>
        <span>as {DEMO_NAMES.account}</span>
      </div>
      <ol className="flex flex-col gap-2.5">
        {DEMO_PHASES.map((id, i) => {
          const status = demoStatus(stage, i);
          return (
            <li key={id} className="flex items-center gap-2.5 text-sm">
              <span className="flex size-4 shrink-0 items-center justify-center">
                {status === 'done' ? (
                  <span className="guide-pop flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
                    <Check className="size-3" />
                  </span>
                ) : status === 'running' ? (
                  <Loader2 className="size-4 animate-spin text-accent" />
                ) : (
                  <span className="size-3.5 rounded-full border border-border-strong" />
                )}
              </span>
              <span className={status === 'pending' ? 'text-faint' : status === 'running' ? 'font-medium text-text-strong' : 'text-text'}>
                {phaseLabel(id, DEMO_NAMES)}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-[11px] text-faint">What you see when you press Play.</p>
    </div>
  );
}
