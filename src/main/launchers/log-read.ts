import { closeSync, openSync, readSync } from 'node:fs';

/** No launcher writes a log line near this long. The parsers skip anything longer, so one endless line cannot stall a sign-in wait. */
export const MAX_LOG_LINE_LENGTH = 16 * 1024;

export function readRange(path: string, from: number, length: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The text between `from` and `size`, or only its last `maxBytes` when there is more: the newest lines decide a sign-in, never the oldest. */
export function readTail(path: string, from: number, size: number, maxBytes: number): string {
  const start = Math.max(from, size - maxBytes);
  if (size - start <= 0) return '';
  const text = readRange(path, start, size - start);
  if (start === from) return text;
  // A clipped read starts mid-line (possibly mid-character), so its first line goes.
  const nl = text.indexOf('\n');
  return nl >= 0 ? text.slice(nl + 1) : '';
}
