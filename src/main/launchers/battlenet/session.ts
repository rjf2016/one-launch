/**
 * The Battle.net remembered session: the REG_BINARY value(s) under
 * HKCU\Software\Blizzard Entertainment\Battle.net\UnifiedAuth (docs/adapters/battlenet.md,
 * "Where the session lives"). The client rewrites the value at every sign-in and deletes it on
 * logout. The bytes are a DPAPI blob bound to this Windows user; they are bearer material all the
 * same, so nothing here logs them and every description carries a fingerprint and a size instead.
 */

import { createHash } from 'node:crypto';
import type { RegistryNamedValue } from '../../platform/registry';

export const BATTLENET_HKCU_KEY = 'Software\\Blizzard Entertainment\\Battle.net';
export const UNIFIED_AUTH_KEY = `${BATTLENET_HKCU_KEY}\\UnifiedAuth`;

export interface TokenValue {
  name: string;
  /** Contiguous lower-case hex digits. */
  hex: string;
}

/** What One Launch stores per account, serialized as JSON and vault-encrypted. */
export interface BattlenetSessionBlob {
  v: 1;
  unifiedAuth: TokenValue;
}

export function fingerprintOf(hex: string): string {
  return createHash('sha256').update(hex.toLowerCase(), 'utf8').digest('hex');
}

/** The first 8 hex digits, for plans and the UI. */
export function shortFingerprint(fingerprint: string | null): string {
  return fingerprint ? fingerprint.slice(0, 8) : '(none)';
}

const HEX = /^(?:[0-9a-fA-F]{2})+$/;

/** The REG_BINARY values under UnifiedAuth as token values; anything of another type is ignored. */
export function tokenValues(values: readonly RegistryNamedValue[]): TokenValue[] {
  return values.filter((v) => v.type === 'REG_BINARY' && HEX.test(v.data)).map((v) => ({ name: v.name, hex: v.data.toLowerCase() }));
}

export function serializeBlob(blob: BattlenetSessionBlob): string {
  return JSON.stringify(blob);
}

/** Accepts v1 blobs and the short-lived v2 (2026-09-13, carried a cookie store that turned out not to matter; ignored). */
export function parseBlob(json: string): BattlenetSessionBlob {
  const raw: unknown = JSON.parse(json);
  const o = raw as { v?: unknown; unifiedAuth?: Partial<TokenValue> } | null;
  const ua = o?.unifiedAuth;
  if (!o || (o.v !== 1 && o.v !== 2) || !ua || typeof ua.name !== 'string' || !ua.name || typeof ua.hex !== 'string' || !HEX.test(ua.hex)) {
    throw new Error('Stored Battle.net session has an unexpected shape');
  }
  return { v: 1, unifiedAuth: { name: ua.name, hex: ua.hex.toLowerCase() } };
}

/** Describes a token value without revealing it. */
export function describeToken(value: TokenValue | null): string {
  if (!value) return '(absent)';
  return `(${value.hex.length / 2} bytes, fingerprint ${shortFingerprint(fingerprintOf(value.hex))})`;
}
