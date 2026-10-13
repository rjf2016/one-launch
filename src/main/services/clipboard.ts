import { createHash } from 'node:crypto';

export const DEFAULT_CLIPBOARD_CLEAR_MS = 30_000;

/** The subset of Electron's (promise-based) clipboard we use, so tests can substitute a fake. */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  clear(): void;
}

const fingerprint = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface CopyResult {
  clearAfterMs: number;
  /** The value was written with the formats that keep it out of Windows clipboard history and cloud sync. */
  historyExcluded: boolean;
}

/**
 * Copies sensitive text to the clipboard and clears it after a delay, but only if the clipboard
 * still holds what we put there. Only a hash of the value is kept in memory while waiting.
 * With a private writer the value also stays out of clipboard history; when that writer fails or
 * the read-back does not match, the plain write is used and the caller is told.
 */
export class ClipboardService {
  private timer: NodeJS.Timeout | null = null;
  private pendingHash: string | null = null;

  constructor(
    private readonly board: ClipboardLike,
    readonly clearAfterMs: number = DEFAULT_CLIPBOARD_CLEAR_MS,
    private readonly privateWrite: ((text: string) => Promise<void>) | null = null,
    private readonly onFallback: ((reason: string) => void) | null = null,
  ) {}

  async copySensitive(text: string): Promise<CopyResult> {
    this.cancelPending();
    let historyExcluded = false;
    if (this.privateWrite) {
      try {
        await this.privateWrite(text);
        if ((await this.board.readText()) !== text) throw new Error('clipboard read-back did not match');
        historyExcluded = true;
      } catch (err) {
        this.onFallback?.(err instanceof Error ? err.message : String(err));
      }
    }
    if (!historyExcluded) await this.board.writeText(text);
    this.pendingHash = fingerprint(text);
    this.timer = setTimeout(() => void this.clearIfUnchanged(), this.clearAfterMs);
    this.timer.unref?.();
    return { clearAfterMs: this.clearAfterMs, historyExcluded };
  }

  /** Clears the clipboard if it still contains the last value we copied. Resolves to whether it did. */
  async clearIfUnchanged(): Promise<boolean> {
    const expected = this.pendingHash;
    this.cancelPending();
    if (expected === null) return false;
    let current: string;
    try {
      current = await this.board.readText();
    } catch {
      return false;
    }
    if (fingerprint(current) !== expected) return false;
    this.board.clear();
    return true;
  }

  private cancelPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingHash = null;
  }
}
