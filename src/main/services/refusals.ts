/**
 * Error codes for refusals the app expects and explains to the user before anything is touched: the
 * launcher is running, preview mode is on, a game needs an update. They are logged at WARN, so an ERROR
 * line always means something unexpected (docs/switching.md, "Isolation").
 */
export const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'BUSY',
  'CONFIRM_REQUIRED',
  'DRY_RUN',
  'DUPLICATE',
  'GAME_NOT_PLAYABLE',
  'GAME_RUNNING',
  'LAUNCHER_RUNNING',
  'NOT_FOUND',
  'NOT_IMPLEMENTED',
  'NOT_INSTALLED',
  'NOT_READY',
  'PROCESS_ACCESS_DENIED',
  'SWITCH_BLOCKED',
]);

/** The error's code when it is an expected refusal, else null. */
export function refusalCode(err: unknown): string | null {
  if (!err || typeof err !== 'object' || !('code' in err)) return null;
  const code = (err as { code: unknown }).code;
  return typeof code === 'string' && REFUSAL_CODES.has(code) ? code : null;
}

export function isRefusal(err: unknown): boolean {
  return refusalCode(err) !== null;
}
