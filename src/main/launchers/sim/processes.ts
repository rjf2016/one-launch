import { ProcessAccessDeniedError, StaticProcessController } from '../../platform/processes';
import type { ProcessKnobs } from './types';

export type StartListener = (exe: string, args: readonly string[]) => void;
export type KillListener = (imageName: string) => void;

/** StaticProcessController whose onStart fans out to every listener, so several simulated launchers can share one controller. */
export class SimProcessController extends StaticProcessController {
  private readonly listeners: StartListener[] = [];
  private readonly killListeners: KillListener[] = [];
  private readonly failingStarts = new Set<string>();
  private readonly elevated = new Set<string>();
  private readonly reappears = new Map<string, { after: number; stoppedPolls: number }>();

  constructor(knobs: Partial<ProcessKnobs> = {}) {
    super();
    this.onStart = (exe, args) => {
      for (const listener of this.listeners) listener(exe, args);
    };
    this.applyKnobs(knobs);
  }

  addListener(listener: StartListener): void {
    this.listeners.push(listener);
  }

  /** Hears every kill, including one an elevated launcher refuses. */
  addKillListener(listener: KillListener): void {
    this.killListeners.push(listener);
  }

  applyKnobs(knobs: Partial<ProcessKnobs>): void {
    for (const image of knobs.running ?? []) this.setRunning(image, true);
    if (knobs.table) this.processes = knobs.table;
    if (knobs.shutdownPolls !== undefined) this.shutdownPolls = knobs.shutdownPolls;
    for (const image of knobs.startFails ?? []) this.failingStarts.add(image.toLowerCase());
    for (const image of knobs.elevated ?? []) this.elevated.add(image.toLowerCase());
    for (const [image, after] of Object.entries(knobs.reappearsAfterPolls ?? {})) this.reappears.set(image.toLowerCase(), { after, stoppedPolls: 0 });
  }

  override async isRunning(imageName: string): Promise<boolean> {
    const running = await super.isRunning(imageName);
    if (running) return true;
    const image = imageName.toLowerCase();
    const rule = this.reappears.get(image);
    if (!rule || ++rule.stoppedPolls <= rule.after) return false;
    this.reappears.delete(image);
    this.setRunning(image, true);
    return true;
  }

  override async start(exe: string, args: readonly string[]): Promise<void> {
    const image = exe.replace(/^.*[\\/]/, '').toLowerCase();
    if (!this.failingStarts.has(image)) return super.start(exe, args);
    const before = this.startFails;
    this.startFails = true;
    try {
      await super.start(exe, args);
    } finally {
      this.startFails = before;
    }
  }

  override async close(imageName: string): Promise<void> {
    if (this.elevated.has(imageName.toLowerCase())) throw new ProcessAccessDeniedError(imageName);
    await super.close(imageName);
  }

  override async kill(imageName: string, opts: { tree?: boolean } = {}): Promise<void> {
    for (const listener of this.killListeners) listener(imageName);
    if (this.elevated.has(imageName.toLowerCase())) throw new ProcessAccessDeniedError(imageName);
    await super.kill(imageName, opts);
  }
}
