/**
 * %APPDATA%\Battle.net\Battle.net.config and the per-account <8-hex>.config files next to it
 * (docs/adapters/battlenet.md). JSON written by Qt: 4-space indent, CRLF, trailing newline, and
 * forward slashes escaped as "\/". The layout is detected from the file and reproduced exactly;
 * a rewrite is only allowed when the unmodified document round-trips byte for byte.
 */

import type { SwitchChange } from '@shared/models';

export type ConfigDoc = Record<string, unknown>;

export interface ConfigLayout {
  eol: '\r\n' | '\n';
  indent: number;
  trailingNewline: boolean;
  escapeSlashes: boolean;
  bom: boolean;
}

export class BattlenetConfigError extends Error {
  readonly code = 'CONFIG_FORMAT';
  constructor(message: string) {
    super(message);
    this.name = 'BattlenetConfigError';
  }
}

export function detectLayout(text: string): ConfigLayout {
  const indentMatch = /\r?\n( +)"/.exec(text);
  return {
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    indent: indentMatch ? indentMatch[1]!.length : 4,
    trailingNewline: /\r?\n$/.test(text),
    escapeSlashes: text.includes('\\/'),
    bom: text.charCodeAt(0) === 0xfeff,
  };
}

export function parseConfig(text: string): { doc: ConfigDoc; layout: ConfigLayout } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new BattlenetConfigError(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BattlenetConfigError('not a JSON object');
  return { doc: raw as ConfigDoc, layout: detectLayout(text) };
}

export function serializeConfig(doc: ConfigDoc, layout: ConfigLayout): string {
  let text = JSON.stringify(doc, null, layout.indent);
  // JSON.stringify never emits "\/", so every "/" here is inside a string and safe to escape.
  if (layout.escapeSlashes) text = text.replace(/\//g, '\\/');
  if (layout.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (layout.trailingNewline) text += layout.eol;
  return (layout.bom ? '\uFEFF' : '') + text;
}

/** True when parsing and re-serializing reproduces the file exactly, so a targeted edit changes nothing else. */
export function roundTrips(text: string): boolean {
  try {
    const { doc, layout } = parseConfig(text);
    return serializeConfig(doc, layout) === text;
  } catch {
    return false;
  }
}

function section(doc: ConfigDoc, ...path: string[]): Record<string, unknown> | null {
  let cur: unknown = doc;
  for (const p of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : null;
}

function str(o: Record<string, unknown> | null, key: string): string | null {
  const v = o?.[key];
  return typeof v === 'string' ? v : null;
}

/** Comma-separated logins; the client writes them lower-case with no spaces. */
export function splitSavedAccountNames(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export interface ClientSettings {
  /** "true" / "false" as written, or null when absent. The "Keep me logged in" preference; never written by One Launch. */
  autoLogin: string | null;
  savedAccountNames: string[];
  version: string | null;
}

export function readClientSettings(doc: ConfigDoc): ClientSettings {
  const client = section(doc, 'Client');
  return {
    autoLogin: str(client, 'AutoLogin'),
    savedAccountNames: splitSavedAccountNames(str(client, 'SavedAccountNames')),
    version: str(section(doc, 'Client', 'Version', 'Release'), 'LastBuildVersion'),
  };
}

export interface GameEntry {
  codename: string;
  lastPlayedAt: string | null;
  lastInstalledAt: string | null;
  serverUid: string | null;
}

function unixSeconds(raw: string | null): string | null {
  if (!raw || !/^\d{9,11}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
}

/** The Games section: codename → timestamps. Presence here does not mean installed. */
export function readGames(doc: ConfigDoc): Map<string, GameEntry> {
  const out = new Map<string, GameEntry>();
  const games = section(doc, 'Games');
  if (!games) return out;
  for (const [codename, value] of Object.entries(games)) {
    const o = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    out.set(codename, {
      codename,
      lastPlayedAt: unixSeconds(str(o, 'LastPlayed')),
      lastInstalledAt: unixSeconds(str(o, 'LastInstalled')),
      serverUid: str(o, 'ServerUid'),
    });
  }
  return out;
}

/** What a window close does for the account that wrote a per-account <8-hex>.config file. */
export interface UserPrefs {
  hideOnClose: boolean | null;
  displayExitPrompt: boolean | null;
}

export function readUserPrefs(text: string): UserPrefs {
  const { doc } = parseConfig(text);
  const client = section(doc, 'User', 'Client');
  const flag = (key: string): boolean | null => {
    const v = str(client, key);
    return v === null ? null : v.toLowerCase() === 'true';
  };
  return { hideOnClose: flag('HideOnClose'), displayExitPrompt: flag('DisplayExitPrompt') };
}

/** Everything but the first character before the @ is hidden: the plan names the target login in full, the others only in outline. */
export function maskLogin(login: string): string {
  const at = login.indexOf('@');
  if (at <= 0) return login.length <= 2 ? login : `${login[0]}…`;
  return `${login[0]}…${login.slice(at)}`;
}

/**
 * The file text with `login` first in Client.SavedAccountNames (moved, or added when absent; the
 * rest keep their order). The client moves the signed-in login to the front at every sign-in and
 * at start only accepts the UnifiedAuth token of the login that is first (every switch on
 * 2026-09-13 with another login first was rejected; the one with the target first signed in
 * silently). Refuses to touch a file whose layout it cannot reproduce; callers skip the step then.
 */
export function planSavedAccountNames(
  text: string,
  login: string,
): { text: string; changes: SwitchChange[]; noop: boolean; before: string[]; after: string[] } {
  const { doc, layout } = parseConfig(text);
  if (serializeConfig(doc, layout) !== text) {
    throw new BattlenetConfigError('Battle.net.config does not round-trip through the JSON writer, so One Launch will not rewrite it');
  }
  const client = section(doc, 'Client');
  if (!client) throw new BattlenetConfigError('Battle.net.config has no Client section');
  const before = splitSavedAccountNames(str(client, 'SavedAccountNames'));
  const wanted = login.trim().toLowerCase();
  if (before.length > 0 && before[0]!.toLowerCase() === wanted) return { text, changes: [], noop: true, before, after: before };
  const after = [before.find((s) => s.toLowerCase() === wanted) ?? wanted, ...before.filter((s) => s.toLowerCase() !== wanted)];
  client['SavedAccountNames'] = after.join(',');
  const next = serializeConfig(doc, layout);
  const show = (list: string[]): string => (list.length === 0 ? '(empty)' : list.map((s) => (s.toLowerCase() === wanted ? s : maskLogin(s))).join(', '));
  return { text: next, changes: [{ where: 'Client.SavedAccountNames', before: show(before), after: show(after) }], noop: next === text, before, after };
}
