/**
 * The Riot Client's remembered session: the `riot-client` block under `psl` › `authorization` in
 * RiotGamesPrivateSettings.yaml (docs/adapters/riot.md › Session file). The block carries bearer
 * tokens, so nothing here logs a value and every description carries a fingerprint instead. The
 * reader fails closed: a block that is not in the shape seen on a real client reads as
 * `unexpected`, never as a session or a sign-out. It understands only what the client writes
 * (space-indented maps, one scalar per line, one-line list items), on purpose: no YAML library.
 */

import { createHash } from 'node:crypto';
import { redactAccountNames } from '../../services/logger';

export const SESSION_BLOCK_PATH: readonly string[] = ['psl', 'authorization', 'riot-client'];

export interface RiotId {
  gameName: string;
  tagLine: string;
}

export interface RiotSession {
  /** The Riot account id: the id token's `sub`, lower-cased. The same across token rotations, different between accounts. */
  accountId: string;
  /** The Riot ID the token names. A name: a display-name suggestion, never logged. */
  riotId: RiotId | null;
  /** SHA-256 hex of the refresh token, which the client replaces at every start: a stored copy with another fingerprint is out of date. */
  fingerprint: string;
  /** `is_dpop_bound`. True would bind the tokens to a device key that no copy of the file carries. Null when the flag is absent. */
  dpopBound: boolean | null;
  /** `refresh_token_write_count`: how often the client has rotated the token since the sign-in. */
  writeCount: number | null;
}

export type RiotSessionRead =
  | { kind: 'session'; session: RiotSession }
  /** `riot-client: null`: the client's own signed-out state. */
  | { kind: 'signed-out' }
  /** Not the shape seen on a real client. Nothing is guessed from it. */
  | { kind: 'unexpected'; reason: string };

/** What One Launch stores per account: the whole file, serialized as JSON and vault-encrypted. Putting the whole file back is the switch confirmed by hand. */
export interface RiotSessionBlob {
  v: 1;
  file: string;
}

export function fingerprintOf(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf8').digest('hex');
}

/** The first 8 hex digits, for the log and the UI. */
export function shortFingerprint(fingerprint: string | null): string {
  return fingerprint ? fingerprint.slice(0, 8) : '(none)';
}

export function riotIdText(id: RiotId): string {
  return `${id.gameName}#${id.tagLine}`;
}

export function serializeBlob(blob: RiotSessionBlob): string {
  return JSON.stringify(blob);
}

interface Entry {
  key: string;
  line: number;
  indent: number;
  /** The text after `key:` on the same line, or null when a block follows (or nothing does). */
  value: string | null;
}

/** `key:` or `key: value`. A list item (`- …`) never matches: its dash is not followed by a colon. */
const KEY_LINE = /^( *)([A-Za-z0-9_.-]+):(?:[ \t]+(.*?))?[ \t]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_PART = /^[A-Za-z0-9_-]+$/;
const MAX_NAME_LENGTH = 64;

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  return n;
}

/**
 * The keys directly inside the block that follows line `parent`: the lines after it, until one at
 * the parent's indent or less, at the indent of the block's first line. Deeper lines (nested
 * blocks) and list items are passed over. A parent of -1 at indent -1 is the top level.
 */
function entriesOf(lines: readonly string[], parent: number, parentIndent: number): Entry[] {
  const out: Entry[] = [];
  let blockIndent = -1;
  for (let i = parent + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const indent = indentOf(line);
    if (indent <= parentIndent) break;
    if (blockIndent < 0) blockIndent = indent;
    if (indent !== blockIndent) continue;
    const m = KEY_LINE.exec(line);
    if (m) out.push({ key: m[2]!, line: i, indent, value: m[3] ? m[3] : null });
  }
  return out;
}

function unquote(value: string | null | undefined): string | null {
  if (!value) return null;
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  const text = quoted ? quoted[1]! : value;
  return text.length > 0 ? text : null;
}

function isNull(value: string): boolean {
  return value === 'null' || value === '~' || value === 'Null' || value === 'NULL';
}

/** The payload of a JWT, read for its fields only: the signature is not checked and the token goes nowhere. */
function idTokenClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && JWT_PART.test(p))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function nameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_NAME_LENGTH ? text : null;
}

/** The Riot ID from the token's `acct` claim, handed to the log's redaction before anything can mention it. */
function riotIdOf(claims: Record<string, unknown>): RiotId | null {
  const acct = claims['acct'];
  if (!acct || typeof acct !== 'object') return null;
  const gameName = nameOf((acct as Record<string, unknown>)['game_name']);
  const tagLine = nameOf((acct as Record<string, unknown>)['tag_line']);
  if (!gameName || !tagLine) return null;
  const id = { gameName, tagLine };
  redactAccountNames([gameName, riotIdText(id)]);
  return id;
}

const unexpected = (reason: string): RiotSessionRead => ({ kind: 'unexpected', reason });

function splitLines(text: string): { bom: string; eol: string; lines: string[] } {
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  return { bom, eol: text.includes('\r\n') ? '\r\n' : '\n', lines: text.slice(bom.length).split(/\r?\n/) };
}

/** The `riot-client` entry, walking the path from the top, or the dotted path of the first key that is missing. */
function findSessionBlock(lines: readonly string[]): { entry: Entry; missing: null } | { entry: null; missing: string } {
  let block: Entry = { key: '', line: -1, indent: -1, value: null };
  const path: string[] = [];
  for (const key of SESSION_BLOCK_PATH) {
    path.push(key);
    const entry = entriesOf(lines, block.line, block.indent).find((e) => e.key === key);
    if (!entry) return { entry: null, missing: path.join('.') };
    block = entry;
  }
  return { entry: block, missing: null };
}

/** The index after the last line of the block that follows `entry` (blank lines after it are not part of the block). */
function blockEnd(lines: readonly string[], entry: Entry): number {
  let end = entry.line + 1;
  for (let i = entry.line + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    if (indentOf(line) <= entry.indent) break;
    end = i + 1;
  }
  return end;
}

/**
 * The file with the `riot-client` block replaced: by `riot-client: null` (the client's own signed-out
 * state) when `body` is null, else by the given lines at the block's field indent, one level in. Every
 * other line, the line endings and a BOM stay as they are. Throws when the block path is not there.
 */
export function spliceSessionBlock(text: string, body: readonly string[] | null): string {
  const { bom, eol, lines } = splitLines(text);
  const found = findSessionBlock(lines);
  if (!found.entry) throw new Error(`no ${found.missing} block`);
  const { entry } = found;
  const pad = ' '.repeat(entry.indent);
  const replacement = body === null ? [`${pad}riot-client: null`] : [`${pad}riot-client:`, ...body.map((line) => `${pad}    ${line}`)];
  lines.splice(entry.line, blockEnd(lines, entry) - entry.line, ...replacement);
  return bom + lines.join(eol);
}

/** The sign-out write: the session block becomes `null` and nothing else changes. A no-op for a file that is already signed out. */
export function planSignOut(text: string): { text: string; noop: boolean } {
  const read = readSession(text);
  if (read.kind === 'unexpected') throw new Error(`${read.reason}; the file is left alone`);
  if (read.kind === 'signed-out') return { text, noop: true };
  return { text: spliceSessionBlock(text, null), noop: false };
}

/** The stored blob back from its JSON. Only its shape is checked here; whether the file holds a session is the caller's question. */
export function parseBlob(json: string): RiotSessionBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('the stored Riot sign-in is not readable');
  }
  const blob = parsed as { v?: unknown; file?: unknown } | null;
  if (!blob || typeof blob !== 'object' || blob.v !== 1 || typeof blob.file !== 'string') throw new Error('the stored Riot sign-in is not in a known shape');
  return { v: 1, file: blob.file };
}

/** Reads the session block. The rest of the file (the device cookie, the pre-116 cookie block) is never looked at. */
export function readSession(text: string): RiotSessionRead {
  const { lines } = splitLines(text);
  const found = findSessionBlock(lines);
  if (!found.entry) return unexpected(`no ${found.missing} block`);
  const block = found.entry;
  if (block.value !== null) return isNull(block.value) ? { kind: 'signed-out' } : unexpected('riot-client is neither null nor a block');
  const fields = new Map(entriesOf(lines, block.line, block.indent).map((e) => [e.key, e.value]));
  if (fields.size === 0) return unexpected('riot-client is empty');
  const idToken = unquote(fields.get('id_token'));
  if (!idToken) return unexpected('riot-client has no id_token');
  const refreshToken = unquote(fields.get('refresh_token'));
  if (!refreshToken) return unexpected('riot-client has no refresh_token');
  const claims = idTokenClaims(idToken);
  if (!claims) return unexpected('id_token is not a readable token');
  const sub = claims['sub'];
  if (typeof sub !== 'string' || !UUID.test(sub)) return unexpected('id_token names no account id');
  const dpop = fields.get('is_dpop_bound');
  const count = fields.get('refresh_token_write_count');
  return {
    kind: 'session',
    session: {
      accountId: sub.toLowerCase(),
      riotId: riotIdOf(claims),
      fingerprint: fingerprintOf(refreshToken),
      dpopBound: dpop === 'true' ? true : dpop === 'false' ? false : null,
      writeCount: count && /^\d{1,9}$/.test(count) ? Number(count) : null,
    },
  };
}
