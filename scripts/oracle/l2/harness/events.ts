import { isDeepStrictEqual } from 'node:util';
import { Content, digestOf, type TextRule } from './project';

export interface JobView {
  state: string;
  steps: [string, string, string, string][];
  attention: unknown;
  [key: string]: unknown;
}

/** A job state shorter than the adapter's poll: a recording shows it or not by chance, so it is never part of an expectation. */
export interface TransientState {
  step: string;
  status: string;
  detail: string;
}

/** Whether a job is where an `awaitJob` step waits for it: every field of `until` holds, a step id together with its status. */
export function matches(job: JobView | undefined, until: Record<string, unknown>): boolean {
  if (!job) return false;
  for (const [key, want] of Object.entries(until)) {
    if (key === 'status') {
      if (!('step' in until)) throw new Error('awaitJob: "status" needs a "step"');
      continue;
    }
    if (key === 'step') {
      const step = job.steps.find((s) => s[0] === want);
      if (!step || ('status' in until && step[1] !== until['status'])) return false;
      continue;
    }
    if (job[key] !== want) return false;
  }
  return true;
}

export const describeJob = (job: JobView | undefined): string => (job ? `${job.state} [${job.steps.map((s) => `${s[0]}:${s[1]}`).join(' ')}]` : 'no such job');

/**
 * What a recording keeps of the events as they were traced, from every start, in order: no `ipc` event and no artwork
 * fetch, each job's distinct states only, and one sequence that rises across restarts.
 */
export function projectEvents(
  recorded: readonly Record<string, unknown>[],
  options: { transient?: readonly TransientState[]; extra?: (event: Record<string, unknown>) => Record<string, unknown> } = {},
): { events: Record<string, unknown>[]; transientSeen: number[] } {
  const events: Record<string, unknown>[] = [];
  const lastOfJob = new Map<string, Record<string, unknown>>();
  const transient = options.transient ?? [];
  const transientSeen = transient.map(() => 0);
  for (const event of recorded) {
    const { seq: _seq, ...rest } = event;
    if (rest['k'] === 'ipc') continue;
    // The artwork queue's fetches are background work with no tie to a switch.
    if (rest['k'] === 'plat' && rest['op'] === 'net.fetch') continue;
    if (rest['k'] === 'job') {
      const steps = rest['steps'] as string[][];
      const fleeting = transient.findIndex((t) => steps.some((step) => step[0] === t.step && step[1] === t.status && step[3] === t.detail));
      if (fleeting !== -1) {
        transientSeen[fleeting]! += 1;
        continue;
      }
      // Only the distinct states: the adapter's last progress call and the service's own report of the same steps are one state.
      const id = rest['job'] as string;
      if (isDeepStrictEqual(lastOfJob.get(id), rest)) continue;
      lastOfJob.set(id, rest);
    }
    events.push({ seq: events.length, ...rest, ...options.extra?.(event) });
  }
  return { events, transientSeen };
}

/** Puts both digests in the place of every content holder; stabilising keeps one of them. */
export function withDigests(value: unknown, text: TextRule): unknown {
  if (value instanceof Content) throw new Error('a content holder outside an object');
  if (Array.isArray(value)) return value.map((item) => withDigests(item, text));
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item instanceof Content) Object.assign(out, digestOf(item.bytes, text));
    else out[key] = withDigests(item, text);
  }
  return out;
}
