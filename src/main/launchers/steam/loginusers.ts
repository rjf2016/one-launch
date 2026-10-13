/**
 * <SteamPath>\config\loginusers.vdf: the accounts Steam remembers on this PC.
 *
 * Verified on the user's machine (docs/adapters/steam.md): each SteamID64 block holds
 * AccountName, PersonaName, RememberPassword, WantsOfflineMode, SkipOfflineModeWarning,
 * AutoLogin, Timestamp. Older clients wrote MostRecent instead of AutoLogin; the two are
 * treated as synonyms everywhere in this file.
 */

import { redactAccountNames } from '../../services/logger';
import { parseVdf, vdfFlag, vdfInt, vdfObject, vdfString, type VdfObject } from './vdf';

/** Real SteamID64s are 17 digits starting 7656119; only the shape is checked so sanitized fixtures pass too. */
export const STEAMID64_PATTERN = /^\d{15,20}$/;

export type MostRecentKey = 'AutoLogin' | 'MostRecent';
export const MOST_RECENT_KEYS: readonly MostRecentKey[] = ['AutoLogin', 'MostRecent'];

export interface SteamLoginUser {
  steamId64: string;
  accountName: string;
  personaName: string;
  rememberPassword: boolean;
  /** True when AutoLogin or MostRecent is 1. */
  mostRecent: boolean;
  /** Unix seconds of the last sign-in, or null. */
  timestamp: number | null;
  /** Which of the synonym keys this block actually contains, in file order. */
  mostRecentKeys: MostRecentKey[];
}

export class LoginUsersFormatError extends Error {
  readonly code = 'LOGINUSERS_FORMAT';
  constructor(message: string) {
    super(message);
    this.name = 'LoginUsersFormatError';
  }
}

function usersBlock(root: VdfObject): VdfObject {
  const users = vdfObject(root, 'users');
  if (!users) throw new LoginUsersFormatError('loginusers.vdf has no "users" block');
  return users;
}

/** Parses the file. Blocks without a valid SteamID64 or AccountName are skipped, never guessed at. */
export function parseLoginUsers(text: string): SteamLoginUser[] {
  const users = usersBlock(parseVdf(text));
  const out: SteamLoginUser[] = [];
  for (const [id, entry] of Object.entries(users)) {
    if (typeof entry !== 'object' || !STEAMID64_PATTERN.test(id)) continue;
    const accountName = vdfString(entry, 'AccountName')?.trim();
    if (!accountName) continue;
    out.push({
      steamId64: id,
      accountName,
      personaName: vdfString(entry, 'PersonaName')?.trim() ?? '',
      rememberPassword: vdfFlag(entry, 'RememberPassword'),
      mostRecent: MOST_RECENT_KEYS.some((k) => vdfFlag(entry, k)),
      timestamp: vdfInt(entry, 'Timestamp'),
      mostRecentKeys: MOST_RECENT_KEYS.filter((k) => vdfString(entry, k) !== undefined),
    });
  }
  // Steam names reach error messages (a wrong-account verdict names the other account), so the log masks them from here on.
  redactAccountNames(out.flatMap((u) => [u.accountName, u.personaName]));
  return out;
}

export function findLoginUser(users: readonly SteamLoginUser[], ref: { launcherUid: string | null; login: string }): SteamLoginUser | null {
  if (ref.launcherUid) {
    const byId = users.find((u) => u.steamId64 === ref.launcherUid);
    if (byId) return byId;
  }
  const login = ref.login.trim().toLowerCase();
  return users.find((u) => u.accountName.toLowerCase() === login) ?? null;
}

// ---------------------------------------------------------------------------
// Rewrite planning. Pure text transform: the caller decides whether to write the result.
// ---------------------------------------------------------------------------

export interface LineChange {
  /** 1-based line number in the original file. Insertions report the line they are inserted before. */
  line: number;
  before: string;
  after: string;
}

export interface AutoLoginRewrite {
  text: string;
  changes: LineChange[];
  /** True when the target already was the only most-recent account and nothing needs to change. */
  noop: boolean;
}

const USER_KEY_LINE = /^\s*"(\d{15,20})"\s*$/;
const MOST_RECENT_LINE = /^(\s*)"(AutoLogin|MostRecent)"(\s+)"([^"]*)"(\s*)$/i;
const ANY_KEY_LINE = /^(\s*)"[^"]*"(\s+)"[^"]*"\s*$/;

/**
 * Produces the loginusers.vdf text that marks `targetSteamId64` as the account Steam signs in as:
 * every AutoLogin/MostRecent key present is set to 1 for the target and 0 for everyone else, and a
 * block that has neither key gets an AutoLogin line. The transform works line by line so the rest
 * of the file (ordering, indentation, line endings, unknown keys) is preserved byte for byte.
 */
export function planAutoLoginRewrite(text: string, targetSteamId64: string): AutoLoginRewrite {
  const users = parseLoginUsers(text);
  if (!users.some((u) => u.steamId64 === targetSteamId64)) {
    throw new LoginUsersFormatError(`SteamID64 ${targetSteamId64} is not in loginusers.vdf`);
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const changes: LineChange[] = [];

  let depth = 0;
  let currentUser: string | null = null;
  let sawKeyInBlock = false;
  let indent = '\t\t';
  let separator = '\t\t';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (trimmed === '{') {
      depth++;
      out.push(raw);
      continue;
    }
    if (trimmed === '}') {
      if (depth === 2 && currentUser !== null) {
        if (!sawKeyInBlock) {
          const inserted = `${indent}"AutoLogin"${separator}"${currentUser === targetSteamId64 ? '1' : '0'}"`;
          out.push(inserted);
          changes.push({ line: i + 1, before: '', after: inserted });
        }
        currentUser = null;
      }
      depth--;
      out.push(raw);
      continue;
    }
    if (depth === 1) {
      const m = USER_KEY_LINE.exec(raw);
      if (m) {
        currentUser = m[1]!;
        sawKeyInBlock = false;
      }
      out.push(raw);
      continue;
    }
    if (depth === 2 && currentUser !== null) {
      const m = MOST_RECENT_LINE.exec(raw);
      if (m) {
        sawKeyInBlock = true;
        const want = currentUser === targetSteamId64 ? '1' : '0';
        if (m[4] !== want) {
          const next = `${m[1]}"${m[2]}"${m[3]}"${want}"${m[5]}`;
          changes.push({ line: i + 1, before: raw, after: next });
          out.push(next);
          continue;
        }
      } else {
        const k = ANY_KEY_LINE.exec(raw);
        if (k) {
          indent = k[1]!;
          separator = k[2]!;
        }
      }
    }
    out.push(raw);
  }

  return { text: out.join(eol), changes, noop: changes.length === 0 };
}
