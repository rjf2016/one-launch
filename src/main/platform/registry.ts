import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RegistryHive = 'HKCU' | 'HKLM';

const HIVE_NAMES: Record<RegistryHive, string> = {
  HKCU: 'HKEY_CURRENT_USER',
  HKLM: 'HKEY_LOCAL_MACHINE',
};

export interface RegistryReader {
  getString(hive: RegistryHive, key: string, name: string): Promise<string | null>;
  getDword(hive: RegistryHive, key: string, name: string): Promise<number | null>;
  /** Every value directly under `key` (raw reg.exe type and data). Empty when the key is missing. */
  listValues(hive: RegistryHive, key: string): Promise<RegistryNamedValue[]>;
  /** Every subkey under `key`, any depth, with its values (`reg query /s`). Empty when the key is missing. A big tree is slow: see searchTree. */
  queryTree(hive: RegistryHive, key: string): Promise<RegistryKeyDump[]>;
  /**
   * The subkeys under `key`, any depth, that hold a value whose data contains `text`, each with only
   * those values (`reg query /s /f <text> /d`). reg.exe filters, so the output stays small: the full
   * dump of the Uninstall tree took 600 ms idle and a minute under CPU load, this takes 60 ms either way.
   */
  searchTree(hive: RegistryHive, key: string, text: string): Promise<RegistryKeyDump[]>;
  /** Every value directly under `key\subkey`, where `subkey` is a name reg.exe itself reported (product names hold characters a key in source code never does). */
  listSubkeyValues(hive: RegistryHive, key: string, subkey: string): Promise<RegistryNamedValue[]>;
}

/** Writes are only ever issued by the switch paths and by backup restore, after a snapshot. */
export interface RegistryWriter {
  setString(hive: RegistryHive, key: string, name: string, value: string): Promise<void>;
  setDword(hive: RegistryHive, key: string, name: string, value: number): Promise<void>;
  /** `hex` is the raw bytes as contiguous hex digits, as reg.exe prints REG_BINARY data. */
  setBinary(hive: RegistryHive, key: string, name: string, hex: string): Promise<void>;
  deleteValue(hive: RegistryHive, key: string, name: string): Promise<void>;
}

export type Registry = RegistryReader & RegistryWriter;

export interface RegistryValue {
  type: string;
  data: string;
}

export interface RegistryNamedValue extends RegistryValue {
  name: string;
}

export interface RegistryKeyDump {
  /** Path of the subkey relative to the queried key, e.g. "Overwatch" or "Launch Options\\Pro". */
  relative: string;
  values: RegistryNamedValue[];
}

export class RegistryError extends Error {
  readonly code = 'REGISTRY';
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

function system32(exe: string): string {
  const root = process.env['SystemRoot'] ?? process.env['windir'];
  return root ? join(root, 'System32', exe) : exe;
}

/** Absolute path to reg.exe so a stray reg.exe earlier on PATH cannot be picked up. */
export function regExePath(): string {
  return system32('reg.exe');
}

export function cmdExePath(): string {
  return system32('cmd.exe');
}

/** The double quote, what cmd.exe expands or interprets even inside double quotes, and control characters. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be kept out of a cmd.exe command line
const CMD_UNSAFE = /["%^&|<>!\x00-\x1f]/;

/**
 * reg.exe prints in the console's OEM code page and swaps what that page lacks for a look-alike
 * ("™" comes back as "T"), so no decoding afterwards can recover a non-ASCII path. Under code page
 * 65001 it prints UTF-8, and the only way to give a child console a code page is `chcp` in the same
 * cmd.exe. Returns the verbatim command line for `cmd.exe /d /s /c`; the exit code is reg.exe's.
 */
export function utf8RegCommand(regExe: string, args: readonly string[]): string {
  if ([regExe, ...args].some((a) => CMD_UNSAFE.test(a))) throw new RegistryError('Refusing to pass unexpected characters to cmd.exe');
  return `"chcp 65001>nul & ${[regExe, ...args].map((a) => `"${a}"`).join(' ')}"`;
}

const VALUE_LINE = /^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*))?$/;
const KEY_LINE = /^HKEY_[A-Z_]+(\\.*)?$/;

/**
 * Pulls one value out of `reg query <key> /v <name>` output, which looks like:
 *
 *     HKEY_CURRENT_USER\Software\Valve\Steam
 *         SteamPath    REG_SZ    d:/games/steam
 */
export function parseRegQueryOutput(stdout: string, name: string): RegistryValue | null {
  const wanted = name.toLowerCase();
  for (const line of stdout.split(/\r?\n/)) {
    const m = VALUE_LINE.exec(line);
    if (!m) continue;
    if (m[1]!.trim().toLowerCase() !== wanted) continue;
    return { type: m[2]!, data: (m[3] ?? '').replace(/\s+$/, '') };
  }
  return null;
}

/**
 * Parses `reg query <key>` and `reg query <key> /s` output into one entry per key line: the key's
 * full path and the value lines that follow it. Subkey names printed without values (plain `reg
 * query`) come back with an empty value list.
 */
export function parseRegQueryDump(stdout: string): { key: string; values: RegistryNamedValue[] }[] {
  const out: { key: string; values: RegistryNamedValue[] }[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') continue;
    if (KEY_LINE.test(line)) {
      out.push({ key: line, values: [] });
      continue;
    }
    const m = VALUE_LINE.exec(line);
    if (!m || out.length === 0) continue;
    out[out.length - 1]!.values.push({ name: m[1]!.trim(), type: m[2]!, data: (m[3] ?? '').replace(/\s+$/, '') });
  }
  return out;
}

export function parseDword(data: string): number | null {
  const s = data.trim();
  const n = /^0x[0-9a-f]+$/i.test(s) ? Number.parseInt(s, 16) : /^\d+$/.test(s) ? Number.parseInt(s, 10) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function isExit(err: unknown, code: number): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

// Never err.message: Node puts the whole command line in it, and for a write that includes the data (a sign-in token for Battle.net).
function writeFailure(err: unknown, data = ''): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; killed?: unknown; stderr?: unknown };
  if (e.killed === true) return 'reg.exe timed out';
  const code = typeof e.code === 'number' ? `exit code ${e.code}` : typeof e.code === 'string' ? e.code : 'no exit code';
  const stderr = typeof e.stderr === 'string' ? e.stderr.replace(/\s+/g, ' ').trim() : '';
  if (!stderr || (data.length >= 8 && stderr.toLowerCase().includes(data.toLowerCase()))) return code;
  return `${code}: ${stderr.slice(0, 200)}`;
}

/** One key or value-name segment: the usual characters (braces for MSI product codes) with at least one word character, so "." and ".." never pass. */
const SEGMENT_PATTERN = /^[\w .(){}-]*\w[\w .(){}-]*$/;
const NAME_PATTERN = SEGMENT_PATTERN;
const validKey = (key: string): boolean => key.split('\\').every((seg) => SEGMENT_PATTERN.test(seg));
/** No control characters and no double quotes; everything else is passed through as one argv entry. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be kept out of a reg.exe argument
const DATA_PATTERN = /^[^\x00-\x1f"]{0,1024}$/;
const HEX_PATTERN = /^(?:[0-9a-fA-F]{2}){1,16384}$/;
const SEARCH_TEXT_PATTERN = /^[\w .-]{3,64}$/;
/** One path segment as reg.exe printed it: anything but a separator, a quote, or a control character, and not a dot segment. utf8RegCommand still refuses what cmd.exe would interpret. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be kept out of a reg.exe argument
const REPORTED_SEGMENT_PATTERN = /^(?!\.{1,2}$)[^\\"\x00-\x1f]{1,255}$/;

/** `verbatim` hands `args` to the process as written, without Node's quoting (cmd.exe does not read quotes the way Node writes them). */
export type RegExec = (file: string, args: string[], opts?: { verbatim?: boolean }) => Promise<{ stdout: string }>;

const defaultExec: RegExec = async (file, args, opts) => {
  const { stdout } = await execFileAsync(file, args, {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    windowsVerbatimArguments: opts?.verbatim === true,
  });
  return { stdout };
};

/**
 * Shells out to reg.exe. Values are never logged here; callers decide what is safe to record.
 * `exec` is injectable so tests can assert the exact command line without touching the registry.
 */
export class WindowsRegistry implements Registry {
  constructor(private readonly exec: RegExec = defaultExec) {}

  private path(hive: RegistryHive, key: string, name: string): string {
    if (!validKey(key) || (name !== '' && !NAME_PATTERN.test(name))) {
      throw new RegistryError('Refusing to touch a registry path with unexpected characters');
    }
    return `${HIVE_NAMES[hive]}\\${key}`;
  }

  /** Every read goes through `utf8RegCommand`. Writes print nothing worth decoding and stay direct, so their data never meets cmd.exe. */
  private read(args: readonly string[]): Promise<{ stdout: string }> {
    return this.exec(cmdExePath(), ['/d', '/s', '/c', utf8RegCommand(regExePath(), args)], { verbatim: true });
  }

  /** An empty `name` reads the key's default value (`reg query /ve`, printed as "(Default)"). */
  async query(hive: RegistryHive, key: string, name: string): Promise<RegistryValue | null> {
    if (process.platform !== 'win32') return null;
    const full = this.path(hive, key, name);
    try {
      const { stdout } = await this.read(name === '' ? ['query', full, '/ve'] : ['query', full, '/v', name]);
      return parseRegQueryOutput(stdout, name === '' ? '(Default)' : name);
    } catch (err) {
      // reg.exe exits 1 when the key or value does not exist.
      if (isExit(err, 1)) return null;
      throw new RegistryError(`reg query failed for ${hive}\\${key}\\${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getString(hive: RegistryHive, key: string, name: string): Promise<string | null> {
    const v = await this.query(hive, key, name);
    if (!v) return null;
    return v.type === 'REG_SZ' || v.type === 'REG_EXPAND_SZ' ? v.data : null;
  }

  async getDword(hive: RegistryHive, key: string, name: string): Promise<number | null> {
    const v = await this.query(hive, key, name);
    if (!v || (v.type !== 'REG_DWORD' && v.type !== 'REG_QWORD')) return null;
    return parseDword(v.data);
  }

  /** `full` is the whole key path, already checked; `flags` follow it on the command line. Exit 1 is a missing key, or a search with no match. */
  private async dump(hive: RegistryHive, key: string, full: string, flags: readonly string[]): Promise<{ key: string; values: RegistryNamedValue[] }[]> {
    if (process.platform !== 'win32') return [];
    try {
      const { stdout } = await this.read(['query', full, ...flags]);
      return parseRegQueryDump(stdout);
    } catch (err) {
      if (isExit(err, 1)) return [];
      throw new RegistryError(`reg query failed for ${hive}\\${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private under(hive: RegistryHive, key: string, dumps: readonly { key: string; values: RegistryNamedValue[] }[]): RegistryKeyDump[] {
    const prefix = `${HIVE_NAMES[hive]}\\${key}\\`.toLowerCase();
    return dumps.filter((d) => d.key.toLowerCase().startsWith(prefix)).map((d) => ({ relative: d.key.slice(prefix.length), values: d.values }));
  }

  async listValues(hive: RegistryHive, key: string): Promise<RegistryNamedValue[]> {
    const full = this.path(hive, key, '');
    return (await this.dump(hive, key, full, [])).find((d) => d.key.toLowerCase() === full.toLowerCase())?.values ?? [];
  }

  async queryTree(hive: RegistryHive, key: string): Promise<RegistryKeyDump[]> {
    return this.under(hive, key, await this.dump(hive, key, this.path(hive, key, ''), ['/s']));
  }

  async searchTree(hive: RegistryHive, key: string, text: string): Promise<RegistryKeyDump[]> {
    if (!SEARCH_TEXT_PATTERN.test(text)) throw new RegistryError('Refusing to search the registry for unexpected characters');
    return this.under(hive, key, await this.dump(hive, key, this.path(hive, key, ''), ['/s', '/f', text, '/d']));
  }

  async listSubkeyValues(hive: RegistryHive, key: string, subkey: string): Promise<RegistryNamedValue[]> {
    if (!REPORTED_SEGMENT_PATTERN.test(subkey)) throw new RegistryError('Refusing to read a registry subkey with unexpected characters');
    const full = `${this.path(hive, key, '')}\\${subkey}`;
    return (await this.dump(hive, `${key}\\${subkey}`, full, [])).find((d) => d.key.toLowerCase() === full.toLowerCase())?.values ?? [];
  }

  private async add(hive: RegistryHive, key: string, name: string, type: 'REG_SZ' | 'REG_DWORD' | 'REG_BINARY', data: string): Promise<void> {
    if (process.platform !== 'win32') throw new RegistryError('Registry writes are Windows-only');
    const full = this.path(hive, key, name);
    if (type === 'REG_BINARY' ? !HEX_PATTERN.test(data) : !DATA_PATTERN.test(data)) {
      throw new RegistryError(`Refusing to write unexpected characters to ${name}`);
    }
    try {
      await this.exec(regExePath(), ['add', full, '/v', name, '/t', type, '/d', data, '/f']);
    } catch (err) {
      throw new RegistryError(`reg add failed for ${hive}\\${key}\\${name}: ${writeFailure(err, data)}`);
    }
  }

  setString(hive: RegistryHive, key: string, name: string, value: string): Promise<void> {
    return this.add(hive, key, name, 'REG_SZ', value);
  }

  async setDword(hive: RegistryHive, key: string, name: string, value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RegistryError(`Not a DWORD: ${value}`);
    await this.add(hive, key, name, 'REG_DWORD', String(value));
  }

  setBinary(hive: RegistryHive, key: string, name: string, hex: string): Promise<void> {
    return this.add(hive, key, name, 'REG_BINARY', hex.toLowerCase());
  }

  async deleteValue(hive: RegistryHive, key: string, name: string): Promise<void> {
    if (process.platform !== 'win32') throw new RegistryError('Registry writes are Windows-only');
    const full = this.path(hive, key, name);
    try {
      await this.exec(regExePath(), ['delete', full, '/v', name, '/f']);
    } catch (err) {
      // Already absent is the state we wanted.
      if (isExit(err, 1)) return;
      throw new RegistryError(`reg delete failed for ${hive}\\${key}\\${name}: ${writeFailure(err)}`);
    }
  }
}

export type RegistryWrite = { op: 'set'; path: string; value: string | number } | { op: 'delete'; path: string };

interface StaticEntry {
  /** Full path as first given, e.g. "HKCU\Software\Valve\Steam\SteamPath". */
  path: string;
  type: string;
  data: string;
}

/** In-memory registry for tests and fixtures. Keys are matched case-insensitively; every write is recorded. */
export class StaticRegistry implements Registry {
  private readonly values = new Map<string, StaticEntry>();
  readonly writes: RegistryWrite[] = [];
  /** Test hook: throw from the next write with this message. */
  failNextWrite: string | null = null;

  constructor(entries: Record<string, string | number> = {}) {
    for (const [k, v] of Object.entries(entries)) this.set(k, v);
  }

  /** `path` is "HKCU\Software\Valve\Steam\SteamPath". Strings become REG_SZ, numbers REG_DWORD. Does not record a write. */
  set(path: string, value: string | number): void {
    this.values.set(
      path.toLowerCase(),
      typeof value === 'number' ? { path, type: 'REG_DWORD', data: `0x${value.toString(16)}` } : { path, type: 'REG_SZ', data: value },
    );
  }

  /** Seeds a REG_BINARY value from contiguous hex digits. Does not record a write. */
  setBinaryValue(path: string, hex: string): void {
    this.values.set(path.toLowerCase(), { path, type: 'REG_BINARY', data: hex.toUpperCase() });
  }

  delete(path: string): void {
    this.values.delete(path.toLowerCase());
  }

  private key(hive: RegistryHive, key: string, name: string): string {
    return `${hive}\\${key}\\${name}`;
  }

  private lookup(hive: RegistryHive, key: string, name: string): StaticEntry | undefined {
    return this.values.get(this.key(hive, key, name).toLowerCase());
  }

  private write(entry: RegistryWrite): void {
    if (this.failNextWrite) {
      const message = this.failNextWrite;
      this.failNextWrite = null;
      throw new RegistryError(message);
    }
    this.writes.push(entry);
  }

  async getString(hive: RegistryHive, key: string, name: string): Promise<string | null> {
    const v = this.lookup(hive, key, name);
    return v && (v.type === 'REG_SZ' || v.type === 'REG_EXPAND_SZ') ? v.data : null;
  }

  async getDword(hive: RegistryHive, key: string, name: string): Promise<number | null> {
    const v = this.lookup(hive, key, name);
    return v && v.type === 'REG_DWORD' ? parseDword(v.data) : null;
  }

  private under(hive: RegistryHive, key: string): { rest: string; entry: StaticEntry }[] {
    const prefix = `${hive}\\${key}\\`.toLowerCase();
    const out: { rest: string; entry: StaticEntry }[] = [];
    for (const [k, entry] of this.values) {
      if (k.startsWith(prefix)) out.push({ rest: entry.path.slice(prefix.length), entry });
    }
    return out;
  }

  async listValues(hive: RegistryHive, key: string): Promise<RegistryNamedValue[]> {
    return this.under(hive, key)
      .filter(({ rest }) => !rest.includes('\\'))
      .map(({ rest, entry }) => ({ name: rest, type: entry.type, data: entry.data }));
  }

  async queryTree(hive: RegistryHive, key: string): Promise<RegistryKeyDump[]> {
    const groups = new Map<string, RegistryKeyDump>();
    for (const { rest, entry } of this.under(hive, key)) {
      const cut = rest.lastIndexOf('\\');
      if (cut < 0) continue;
      const relative = rest.slice(0, cut);
      let group = groups.get(relative.toLowerCase());
      if (!group) {
        group = { relative, values: [] };
        groups.set(relative.toLowerCase(), group);
      }
      group.values.push({ name: rest.slice(cut + 1), type: entry.type, data: entry.data });
    }
    return [...groups.values()];
  }

  async searchTree(hive: RegistryHive, key: string, text: string): Promise<RegistryKeyDump[]> {
    const wanted = text.toLowerCase();
    const groups = new Map<string, RegistryKeyDump>();
    for (const { rest, entry } of this.under(hive, key)) {
      const cut = rest.lastIndexOf('\\');
      if (cut < 0 || !entry.data.toLowerCase().includes(wanted)) continue;
      const relative = rest.slice(0, cut);
      const group = groups.get(relative.toLowerCase()) ?? { relative, values: [] };
      groups.set(relative.toLowerCase(), group);
      group.values.push({ name: rest.slice(cut + 1), type: entry.type, data: entry.data });
    }
    return [...groups.values()];
  }

  listSubkeyValues(hive: RegistryHive, key: string, subkey: string): Promise<RegistryNamedValue[]> {
    return this.listValues(hive, `${key}\\${subkey}`);
  }

  async setString(hive: RegistryHive, key: string, name: string, value: string): Promise<void> {
    const path = this.key(hive, key, name);
    this.write({ op: 'set', path, value });
    this.set(path, value);
  }

  async setDword(hive: RegistryHive, key: string, name: string, value: number): Promise<void> {
    const path = this.key(hive, key, name);
    this.write({ op: 'set', path, value });
    this.set(path, value);
  }

  async setBinary(hive: RegistryHive, key: string, name: string, hex: string): Promise<void> {
    const path = this.key(hive, key, name);
    this.write({ op: 'set', path, value: `binary:${hex.length / 2} bytes` });
    this.setBinaryValue(path, hex);
  }

  async deleteValue(hive: RegistryHive, key: string, name: string): Promise<void> {
    const path = this.key(hive, key, name);
    this.write({ op: 'delete', path });
    this.delete(path);
  }
}
