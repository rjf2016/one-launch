/**
 * The Epic remembered session: [RememberMe] Enable/Data plus [Offline] Data in GameUserSettings.ini
 * (docs/adapters/epic.md, Phase 4 survey). The blobs are opaque, Epic-encrypted base64 and are
 * bearer credentials: nothing here logs them, and every description shown to the user carries a
 * fingerprint and a length instead of the value.
 */

import { createHash } from 'node:crypto';
import type { SwitchChange } from '@shared/models';
import { readSection, rewriteSection, type IniChange } from './ini';

export const REMEMBER_ME_SECTION = 'RememberMe';
export const OFFLINE_SECTION = 'Offline';

/** What One Launch stores per account, serialized as JSON and vault-encrypted. */
export interface EpicSessionBlob {
  v: 1;
  rememberMe: { enable: string; data: string };
  offline: { data: string } | null;
}

export interface EpicSessionOnDisk {
  /** Enable is True and Data is present: the launcher will sign in on its own at the next start. */
  remembered: boolean;
  enable: string | null;
  data: string | null;
  offlineData: string | null;
  /** SHA-256 hex of Data, or null when there is none. */
  fingerprint: string | null;
}

export function fingerprintOf(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** The first 8 hex digits, for plans and the UI. */
export function shortFingerprint(fingerprint: string | null): string {
  return fingerprint ? fingerprint.slice(0, 8) : '(none)';
}

export function readSessionFromIni(text: string): EpicSessionOnDisk {
  const remember = readSection(text, REMEMBER_ME_SECTION);
  const offline = readSection(text, OFFLINE_SECTION);
  const enable = remember?.['Enable']?.trim() ?? null;
  const data = remember?.['Data']?.trim() || null;
  const offlineData = offline?.['Data']?.trim() || null;
  return {
    remembered: enable?.toLowerCase() === 'true' && data !== null,
    enable,
    data,
    offlineData,
    fingerprint: data ? fingerprintOf(data) : null,
  };
}

export function sessionBlobFromIni(text: string): EpicSessionBlob | null {
  const s = readSessionFromIni(text);
  if (!s.remembered || !s.data) return null;
  return { v: 1, rememberMe: { enable: s.enable ?? 'True', data: s.data }, offline: s.offlineData ? { data: s.offlineData } : null };
}

export function serializeBlob(blob: EpicSessionBlob): string {
  return JSON.stringify(blob);
}

export function parseBlob(json: string): EpicSessionBlob {
  const raw: unknown = JSON.parse(json);
  const o = raw as Partial<EpicSessionBlob> | null;
  if (!o || o.v !== 1 || !o.rememberMe || typeof o.rememberMe.data !== 'string' || !o.rememberMe.data) {
    throw new Error('Stored Epic session has an unexpected shape');
  }
  return {
    v: 1,
    rememberMe: { enable: typeof o.rememberMe.enable === 'string' ? o.rememberMe.enable : 'True', data: o.rememberMe.data },
    offline: o.offline && typeof o.offline.data === 'string' && o.offline.data ? { data: o.offline.data } : null,
  };
}

/** Describes a Data value without revealing it. */
function describe(value: string | null): string {
  if (value === null) return '(absent)';
  if (/^[A-Za-z0-9+/=]{16,}$/.test(value)) return `(${value.length} characters, fingerprint ${shortFingerprint(fingerprintOf(value))})`;
  return value.length <= 8 ? value : `(${value.length} characters)`;
}

function mask(section: string, changes: readonly IniChange[]): SwitchChange[] {
  return changes.map((c) => ({
    where: `[${section}] ${c.key}, line ${c.line}`,
    before: c.key === 'Data' ? describe(c.before) : (c.before ?? '(absent)'),
    after: c.after === null ? '(removed)' : c.key === 'Data' ? describe(c.after) : c.after,
  }));
}

/**
 * The GameUserSettings.ini text after putting `blob` in place, or after signing the launcher out
 * when `blob` is null (Data removed from both sections). Everything else is preserved.
 *
 * Enable stays True in both cases: it is a sticky preference the launcher never turns back on by
 * itself (seen 2026-09-13: one Enable=False write left every later launcher-written file at False
 * and auto sign-in off for good). Without Data the launcher logs a decode error and opens its
 * sign-in page, which is the wanted outcome.
 */
export function planSessionWrite(text: string, blob: EpicSessionBlob | null): { text: string; changes: SwitchChange[]; noop: boolean } {
  const remember = rewriteSection(text, REMEMBER_ME_SECTION, blob ? { Enable: 'True', Data: blob.rememberMe.data } : { Enable: 'True', Data: null });
  const offline = rewriteSection(remember.text, OFFLINE_SECTION, { Data: blob?.offline?.data ?? null });
  return {
    text: offline.text,
    changes: [...mask(REMEMBER_ME_SECTION, remember.changes), ...mask(OFFLINE_SECTION, offline.changes)],
    noop: offline.text === text,
  };
}
