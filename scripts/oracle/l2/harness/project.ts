import { createHash } from 'node:crypto';
import { parseConfig, readClientSettings } from '../../../../src/main/launchers/battlenet/config';
import { readSessionFromIni } from '../../../../src/main/launchers/epic/session';
import { readSession } from '../../../../src/main/launchers/riot/session';
import { parseLoginUsers } from '../../../../src/main/launchers/steam/loginusers';

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/** Bytes whose digest is taken once every id of the run has its alias. */
export class Content {
  constructor(readonly bytes: Buffer) {}
}

// What a simulator stamps into a file it writes: the Riot Client's token times are the wall clock at the write.
const STAMPS: readonly [RegExp, string][] = [[/((?:last|original)_token_creation_time: )\d+/g, '$1<ms>']];

export function maskStamps(text: string): string {
  return STAMPS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type TextRule = (text: string) => string;

/** `sha256` is of the bytes; `projectionSha256` of the text with simulator stamps, scratch roots and ids masked. Only one of them survives stabilising. */
export function digestOf(bytes: Uint8Array, text: TextRule): { sha256: string; projectionSha256: string } {
  const decoded = decodeText(bytes);
  return { sha256: sha256(bytes), projectionSha256: decoded === null ? sha256(bytes) : sha256(text(maskStamps(decoded))) };
}

const DIGEST_KEY = /^sha256$|Sha256$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** A digest the app keeps under a name of its own (a fingerprint column, a parser's field) is shown as `{ sha256 }`, so a reader can tell it from an id. */
export function wrapDigests(value: unknown, key: string | null = null): unknown {
  if (typeof value === 'string') return key !== null && !DIGEST_KEY.test(key) && HEX64.test(value) ? { sha256: value } : value;
  if (Array.isArray(value)) return value.map((item) => wrapDigests(item, key));
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array || value instanceof Content) return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, wrapDigests(item, name)]));
}

/** The launcher state files the adapters write, each with the app's own reader for it. A token never appears: only its digest. */
export const LAUNCHER_FILES: readonly { path: string; parse: (text: string) => unknown }[] = [
  { path: 'steam/config/loginusers.vdf', parse: (text) => parseLoginUsers(text) },
  {
    path: 'localappdata/EpicGamesLauncher/Saved/Config/Windows/GameUserSettings.ini',
    parse: (text) => {
      const s = readSessionFromIni(text);
      return {
        remembered: s.remembered,
        enable: s.enable,
        dataSha256: s.data === null ? null : sha256(s.data),
        offlineDataSha256: s.offlineData === null ? null : sha256(s.offlineData),
      };
    },
  },
  { path: 'appdata/Battle.net/Battle.net.config', parse: (text) => readClientSettings(parseConfig(text).doc) },
  { path: 'localappdata/Riot Games/Riot Client/Data/RiotGamesPrivateSettings.yaml', parse: (text) => readSession(text) },
];

const LOG_LINE = /^(\S+) (WARN|ERROR) +(\[[^\]]*\]) (.*)$/;

function dropStacks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropStacks);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => name !== 'stack')
      .map(([name, item]) => [name, dropStacks(item)]),
  );
}

/** A WARN or ERROR line as written, without the `stack` of any error in its JSON tail: a stack names source files, not behaviour. */
function projectLogLine(line: string): { level: 'warn' | 'error'; text: string } | null {
  const match = LOG_LINE.exec(line);
  if (!match) return null;
  const [, at, level, scope, rest] = match as unknown as [string, string, string, string, string];
  let text = rest;
  for (let from = rest.indexOf(' {'); from !== -1; from = rest.indexOf(' {', from + 1)) {
    try {
      const meta = dropStacks(JSON.parse(rest.slice(from + 1)));
      text = `${rest.slice(0, from)} ${JSON.stringify(meta)}`;
      break;
    } catch {
      continue;
    }
  }
  return { level: level === 'WARN' ? 'warn' : 'error', text: `${at} ${level.padEnd(5)} ${scope} ${text}` };
}

// A line that only says how long something took comes and goes with the machine's load: the same run logs it or not.
const TIMING_ONLY = / \[main:launchers\] launcher status was slow /;

export function projectLog(text: string): { warn: string[]; error: string[] } {
  const out = { warn: [] as string[], error: [] as string[] };
  for (const line of text.split(/\r?\n/)) {
    const projected = projectLogLine(line);
    if (projected && !TIMING_ONLY.test(projected.text)) out[projected.level].push(projected.text);
  }
  return out;
}

const UUID_TAIL = /\[UUID…([0-9a-f]{4})\]/gi;

/** The logger keeps the last four characters of an id; with the run's ids known, that names the alias. Two ids that share a tail stay as written. */
export function aliasUuidTails(line: string, ids: ReadonlyMap<string, string>): string {
  const byTail = new Map<string, string | null>();
  for (const [id, alias] of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;
    const tail = id.slice(-4).toLowerCase();
    byTail.set(tail, byTail.has(tail) && byTail.get(tail) !== alias ? null : alias);
  }
  return line.replace(UUID_TAIL, (whole, tail: string) => {
    const alias = byTail.get(tail.toLowerCase());
    return alias ? `[UUID…${alias}]` : whole;
  });
}
