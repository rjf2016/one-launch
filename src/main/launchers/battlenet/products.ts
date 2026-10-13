/**
 * Battle.net products (docs/adapters/battlenet.md, "Library"). Every product has three names:
 * the internal codename (`prometheus`; the `--uid=` of its Uninstall entry and the key in
 * Battle.net.config's Games), the program code (`Pro`; `--exec="launch Pro"`, the registry
 * Launch Options subkey), and the TACT product code (`pro`; product.db, `battlenet://game/pro`).
 */

import { normalizeLauncherPath } from '../../platform/fs-path';
import type { RegistryKeyDump } from '../../platform/registry';

export interface ProductCodes {
  programCode: string;
  tactCode: string;
  name: string;
  /** Confirmed on the survey machine (client log, registry, product.db all agree). */
  verified: boolean;
  /** The same game's Steam appid, when it is sold on Steam too; lets artwork come from Steam's CDN without a key. */
  steamAppId?: string;
}

/**
 * Codename → codes. `prometheus` and `hs_beta` were verified on 2026-09-12; the rest are the codes
 * seen in the wild (spec section 8.4) and are used only when no other source names the product.
 */
export const PRODUCTS: Readonly<Record<string, ProductCodes>> = {
  prometheus: { programCode: 'Pro', tactCode: 'pro', name: 'Overwatch', verified: true, steamAppId: '2357570' },
  hs_beta: { programCode: 'WTCG', tactCode: 'hsb', name: 'Hearthstone', verified: true },
  wow: { programCode: 'WoW', tactCode: 'wow', name: 'World of Warcraft', verified: false },
  wow_classic: { programCode: 'WoWC', tactCode: 'wow_classic', name: 'World of Warcraft Classic', verified: false },
  wow_classic_era: { programCode: 'WoWC', tactCode: 'wow_classic_era', name: 'World of Warcraft Classic Era', verified: false },
  diablo3: { programCode: 'D3', tactCode: 'd3', name: 'Diablo III', verified: false },
  fenris: { programCode: 'Fen', tactCode: 'fenris', name: 'Diablo IV', verified: false, steamAppId: '2344520' },
  osi: { programCode: 'OSI', tactCode: 'osi', name: 'Diablo II: Resurrected', verified: false },
  anbs: { programCode: 'ANBS', tactCode: 'anbs', name: 'Diablo Immortal', verified: false },
  s2: { programCode: 'S2', tactCode: 's2', name: 'StarCraft II', verified: false },
  s1: { programCode: 'S1', tactCode: 's1', name: 'StarCraft', verified: false },
  heroes: { programCode: 'Hero', tactCode: 'hero', name: 'Heroes of the Storm', verified: false },
  w3: { programCode: 'W3', tactCode: 'w3', name: 'Warcraft III: Reforged', verified: false },
  odin: { programCode: 'ODIN', tactCode: 'odin', name: 'Call of Duty: Modern Warfare', verified: false },
  zeus: { programCode: 'ZEUS', tactCode: 'zeus', name: 'Call of Duty: Black Ops Cold War', verified: false, steamAppId: '1985810' },
  fore: { programCode: 'FORE', tactCode: 'fore', name: 'Call of Duty: Vanguard', verified: false, steamAppId: '1985820' },
  lazr: { programCode: 'LAZR', tactCode: 'lazr', name: 'Call of Duty: Modern Warfare II', verified: false, steamAppId: '1938090' },
  auks: { programCode: 'AUKS', tactCode: 'auks', name: 'Call of Duty', verified: false, steamAppId: '1938090' },
  viper: { programCode: 'VIPR', tactCode: 'viper', name: 'Call of Duty: Black Ops 4', verified: false },
  rtro: { programCode: 'RTRO', tactCode: 'rtro', name: 'Blizzard Arcade Collection', verified: false },
  wlby: { programCode: 'WLBY', tactCode: 'wlby', name: 'Warcraft III', verified: false },
  gryphon: { programCode: 'GRY', tactCode: 'gryphon', name: 'Warcraft Rumble', verified: false },
};

/** A product's codes, from the table or from a TACT code learned from product.db. */
export function productCodes(codename: string, tactFromDb?: string | null): ProductCodes | null {
  const known = PRODUCTS[codename];
  if (known) return tactFromDb && tactFromDb !== known.tactCode ? { ...known, tactCode: tactFromDb } : known;
  if (tactFromDb) return { programCode: tactFromDb.toUpperCase(), tactCode: tactFromDb, name: codename, verified: false };
  return null;
}

export const UNINSTALL_KEY = 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
/** What a registry search for Blizzard's products looks for; BLIZZARD_UNINSTALLER then checks the value it finds. */
export const BLIZZARD_UNINSTALLER_TEXT = 'Blizzard Uninstaller';
const BLIZZARD_UNINSTALLER = /Blizzard Uninstaller\.exe/i;
const UID_ARG = /--uid=("([^"]+)"|(\S+))/;

export interface UninstallEntry {
  /** Subkey name under Uninstall, e.g. "Overwatch". */
  key: string;
  codename: string;
  name: string;
  installPath: string | null;
}

/** Products installed through the Agent: every Uninstall entry whose uninstaller is Blizzard's, keyed by its --uid. The client itself (battle.net) is left out. */
export function parseUninstallEntries(tree: readonly RegistryKeyDump[]): UninstallEntry[] {
  const out: UninstallEntry[] = [];
  for (const dump of tree) {
    if (dump.relative.includes('\\')) continue;
    const value = (name: string): string | null => dump.values.find((v) => v.name.toLowerCase() === name.toLowerCase())?.data ?? null;
    const uninstall = value('UninstallString');
    if (!uninstall || !BLIZZARD_UNINSTALLER.test(uninstall)) continue;
    const m = UID_ARG.exec(uninstall);
    const codename = (m?.[2] ?? m?.[3] ?? '').trim();
    if (!codename || codename === 'battle.net') continue;
    const location = value('InstallLocation');
    out.push({
      key: dump.relative,
      codename,
      name: value('DisplayName')?.trim() || PRODUCTS[codename]?.name || codename,
      installPath: location && location.trim() ? normalizeLauncherPath(location) : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export interface ProductDbEntry {
  codename: string;
  tactCode: string;
  installPath: string;
}

const CODENAME = /^[a-z][a-z0-9_.]{1,31}$/;
const TACT = /^[a-z][a-z0-9_]{1,15}$/;
const PATH_TAIL = /([A-Za-z]:[\\/].+)$/;
/** Far more products than Battle.net has ever offered; a file that yields more is not a real product.db. */
const MAX_PRODUCTS = 512;

/**
 * C:\ProgramData\Battle.net\Agent\product.db is a protobuf; each install record carries the codename,
 * the TACT code, and the install path as consecutive strings. This pulls those triples out of the
 * printable runs without decoding the message (a length byte that happens to be printable may be
 * glued to the front of a string, hence the lenient path match).
 */
export function parseProductDb(buf: Uint8Array): ProductDbEntry[] {
  const strings: string[] = [];
  let cur = '';
  for (const b of buf) {
    if (b >= 0x20 && b < 0x7f) {
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= 2) strings.push(cur);
      cur = '';
    }
  }
  if (cur.length >= 2) strings.push(cur);
  const out: ProductDbEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 2 < strings.length && out.length < MAX_PRODUCTS; i++) {
    const codename = strings[i]!;
    const tact = strings[i + 1]!;
    const path = PATH_TAIL.exec(strings[i + 2]!)?.[1];
    if (!CODENAME.test(codename) || !TACT.test(tact) || !path) continue;
    if (codename === 'agent' || codename === 'battle.net') continue;
    if (seen.has(codename)) continue;
    seen.add(codename);
    out.push({ codename, tactCode: tact, installPath: normalizeLauncherPath(path) });
  }
  return out;
}

export interface AggregateEntry {
  name: string;
  tactCode: string;
  launchUri: string | null;
  iconPath: string | null;
  lastPlayedAt: string | null;
}

/** C:\ProgramData\Battle.net\Agent\aggregate.json, the client's own list for the Xbox app. May lag behind installs. */
export function parseAggregate(text: string): AggregateEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  const list = raw && typeof raw === 'object' ? (raw as { installed?: unknown }).installed : undefined;
  if (!Array.isArray(list)) return [];
  const out: AggregateEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const tact = typeof o['product_id'] === 'string' ? o['product_id'] : null;
    if (!tact) continue;
    const ts = typeof o['last_played_timestamp'] === 'number' && o['last_played_timestamp'] > 0 ? new Date(o['last_played_timestamp']).toISOString() : null;
    out.push({
      name: typeof o['name'] === 'string' ? o['name'] : tact,
      tactCode: tact,
      launchUri: typeof o['launch_uri'] === 'string' ? o['launch_uri'] : null,
      iconPath: typeof o['icon_path'] === 'string' ? normalizeLauncherPath(o['icon_path']) : null,
      lastPlayedAt: ts,
    });
  }
  return out;
}

export type BattlenetLaunchForm = 'uri' | 'exec';

/** What launchGame sends: the URI the client advertises in aggregate.json, or the --exec form. */
export function launchCommand(
  codes: Pick<ProductCodes, 'programCode' | 'tactCode'>,
  form: BattlenetLaunchForm,
): { kind: 'uri'; url: string } | { kind: 'exec'; arg: string } {
  return form === 'exec' ? { kind: 'exec', arg: `--exec=launch ${codes.programCode}` } : { kind: 'uri', url: `battlenet://game/${codes.tactCode}` };
}
