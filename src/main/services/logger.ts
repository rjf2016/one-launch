import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '@shared/models';

// ---------------------------------------------------------------------------
// Redaction. Runs on every line before it reaches disk or console.
// ---------------------------------------------------------------------------

/** Object keys whose values are always replaced, regardless of content. */
const SENSITIVE_KEY =
  /^(pass(word|wd|phrase)?|pwd|secret|secret_enc|token|api[_-]?key|apikey|authorization|auth|cookie|session|session[_-]?(id|blob|data)|refresh[_-]?token|access[_-]?token|credential(s)?|private[_-]?key|remember[_-]?me|value_enc|data)$/i;

/** `password=hunter2`, `token: abc`, `"apiKey": "abc"` inside free text. */
const KEY_VALUE_IN_TEXT =
  /\b(pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|session|refresh[_-]?token|access[_-]?token|credentials?|private[_-]?key)\b(["']?\s*[=:]\s*)(["']?)([^\s"',;&}]+)/gi;

/** INI-style `Data=<blob>` (Epic's [RememberMe] section). */
const INI_DATA_BLOB = /(\bData\s*=\s*)(\S+)/g;

/** `steam.exe -login <user> <password>` command lines. */
const STEAM_LOGIN_ARGS = /(-login\s+\S+\s+)(\S+)/gi;

// Every pattern here must stay linear on a long run of one kind of character: they run synchronously on the main thread over text a launcher file or the update feed can supply.

/** JWT-shaped tokens. */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** Email addresses: the Epic and Battle.net logins, which adapter messages name. */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;

/** SteamID64s (17 digits starting 7656119): launcher account ids never belong in the log. */
const STEAM_ID64 = /\b7656119\d{10}\b/g;

/** UUIDs: a Riot account id is one. One Launch's own job and account ids are too, so the last four characters stay for matching lines up. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The Windows user name in a profile path, whether its separators are raw, JSON-escaped, or forward slashes. */
const PROFILE_PATH = /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/:*?"<>|\r\n]+/gi;

/** Long opaque blobs (base64 / hex / token-like): 48+ chars with at least one digit, so a long word or path segment is left alone. */
const LONG_RUN = /[A-Za-z0-9+/_-]{48,}={0,2}/g;
const DIGIT = /\d/;

const REDACTED = '[REDACTED]';

/**
 * Account names have no shape a pattern could catch (a Steam login is any word), so they are masked
 * by value: whoever reads a login, display name, or persona name from the database or a launcher
 * file hands it over here first, and any message built from it afterwards is already covered.
 * Names are only ever added; the set is as small as the number of accounts on the PC.
 */
const accountNames = new Set<string>();
let accountNamePattern: RegExp | null = null;

const MIN_NAME_LENGTH = 3;
/** The longest login the app accepts. A name of tens of thousands of characters makes V8 reject the pattern, and every later log call with it. */
const MAX_NAME_LENGTH = 256;
const MAX_ACCOUNT_NAMES = 2000;
/** Labels that identify nobody and are ordinary log words; masking them would only make the log harder to read. */
const NOT_A_NAME: ReadonlySet<string> = new Set([
  'steam',
  'epic',
  'epic games',
  'battle.net',
  'battlenet',
  'blizzard',
  'riot',
  'riot games',
  'riot client',
  'valorant',
  'main',
  'alt',
  'account',
  'default',
  'test',
  'user',
]);

export function redactAccountNames(names: Iterable<string | null | undefined>): void {
  for (const raw of names) {
    const name = raw?.trim().toLowerCase();
    if (!name || name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH || NOT_A_NAME.has(name) || accountNames.has(name)) continue;
    if (accountNames.size >= MAX_ACCOUNT_NAMES) return;
    accountNames.add(name);
    accountNamePattern = null;
  }
}

/** For tests. */
export function forgetAccountNames(): void {
  accountNames.clear();
  accountNamePattern = null;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function maskAccountNames(input: string): string {
  if (accountNames.size === 0) return input;
  if (!accountNamePattern) {
    const alternatives = [...accountNames].sort((a, b) => b.length - a.length).map((n) => n.replace(REGEX_SPECIAL, '\\$&'));
    // Whole names only, so "bob" inside "bobsled" or a camelCase key is left alone.
    accountNamePattern = new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives.join('|')})(?![A-Za-z0-9_])`, 'gi');
  }
  return input.replace(accountNamePattern, '[ACCOUNT]');
}

export function redactString(input: string): string {
  return maskAccountNames(input)
    .replace(KEY_VALUE_IN_TEXT, (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}${REDACTED}`)
    .replace(INI_DATA_BLOB, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(STEAM_LOGIN_ARGS, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(EMAIL, '[EMAIL]')
    .replace(STEAM_ID64, '[STEAMID]')
    .replace(UUID, (id) => `[UUID…${id.slice(-4)}]`)
    .replace(PROFILE_PATH, '$1[USER]')
    .replace(LONG_RUN, (run) => (DIGIT.test(run) ? REDACTED : run));
}

const MAX_DEPTH = 6;

/** Deep-copies a value, replacing anything under a sensitive key. Safe for cycles and Buffers. */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (value instanceof Uint8Array) return `<bytes ${value.byteLength}>`;
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_DEPTH) return '[depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1, seen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// File sink with size-based rotation.
// ---------------------------------------------------------------------------

export interface FileSinkOptions {
  dir: string;
  /** Base file name without extension, e.g. 'onelaunch' -> onelaunch.log, onelaunch.1.log ... */
  name: string;
  maxBytes: number;
  /** Number of rotated files to keep in addition to the live file. */
  keep: number;
}

export class FileSink {
  private size = -1;
  readonly currentPath: string;

  constructor(private readonly opts: FileSinkOptions) {
    this.currentPath = join(opts.dir, `${opts.name}.log`);
  }

  private rotatedPath(n: number): string {
    return join(this.opts.dir, `${this.opts.name}.${n}.log`);
  }

  write(line: string): void {
    if (!existsSync(this.opts.dir)) mkdirSync(this.opts.dir, { recursive: true });
    if (this.size < 0) this.size = existsSync(this.currentPath) ? statSync(this.currentPath).size : 0;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.size > 0 && this.size + bytes > this.opts.maxBytes) this.rotate();
    appendFileSync(this.currentPath, line, 'utf8');
    this.size += bytes;
  }

  rotate(): void {
    const { keep } = this.opts;
    if (keep <= 0) {
      if (existsSync(this.currentPath)) unlinkSync(this.currentPath);
      this.size = 0;
      return;
    }
    const oldest = this.rotatedPath(keep);
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = keep - 1; i >= 1; i--) {
      const from = this.rotatedPath(i);
      if (existsSync(from)) renameSync(from, this.rotatedPath(i + 1));
    }
    if (existsSync(this.currentPath)) renameSync(this.currentPath, this.rotatedPath(1));
    this.size = 0;
  }
}

// ---------------------------------------------------------------------------
// Logger.
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export interface LoggingOptions {
  dir: string;
  level?: LogLevel;
  /** Mirror lines to stdout/stderr (dev). */
  console?: boolean;
  maxBytes?: number;
  keep?: number;
}

let sink: FileSink | null = null;
let threshold: LogLevel = 'info';
let mirror = false;

export function initLogging(opts: LoggingOptions): FileSink {
  sink = new FileSink({
    dir: opts.dir,
    name: 'onelaunch',
    maxBytes: opts.maxBytes ?? 1024 * 1024,
    keep: opts.keep ?? 5,
  });
  threshold = opts.level ?? 'info';
  mirror = opts.console ?? false;
  return sink;
}

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function getLogLevel(): LogLevel {
  return threshold;
}

const MAX_TEXT_LENGTH = 8 * 1024;

// Applied after redaction: cutting first could leave the start of a secret too short for its pattern to match.
function clip(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}… [${text.length - MAX_TEXT_LENGTH} more characters]` : text;
}

function onOneLine(text: string): string {
  return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function formatLine(timestamp: string, level: LogLevel, scope: string, message: string, meta?: unknown): string {
  const prefix = `${timestamp} ${level.toUpperCase().padEnd(5)} [${scope}] `;
  try {
    const head = `${prefix}${onOneLine(clip(redactString(message)))}`;
    if (meta === undefined) return `${head}\n`;
    let metaText: string;
    try {
      metaText = JSON.stringify(redactValue(meta));
    } catch {
      metaText = '"[unserializable]"';
    }
    // Belt and braces: the serialized form goes through string redaction too.
    return `${head} ${clip(redactString(metaText))}\n`;
  } catch {
    return `${prefix}[log line dropped: redaction failed]\n`;
  }
}

function emit(scope: string, level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  try {
    const line = formatLine(new Date().toISOString(), level, scope, message, meta);
    try {
      sink?.write(line);
    } catch {
      // Logging must never crash the app. Fall through to console if mirroring.
    }
    if (mirror) {
      const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      out.write(line);
    }
  } catch {
    return;
  }
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit(scope, 'debug', m, meta),
    info: (m, meta) => emit(scope, 'info', m, meta),
    warn: (m, meta) => emit(scope, 'warn', m, meta),
    error: (m, meta) => emit(scope, 'error', m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
