/** The colours a separator may take: the app's accent and status tokens, and one per launcher. */
export const WHATS_NEW_TONES = ['accent', 'success', 'warning', 'danger', 'steam', 'epic', 'battlenet', 'riot'] as const;
export type WhatsNewTone = (typeof WHATS_NEW_TONES)[number];

/** One change: a bold lead sentence and, optionally, a plain sentence after it. */
export interface WhatsNewItem {
  lead: string;
  detail?: string;
}

/** A separator above the items that follow it: its text and its colour (accent when unset). */
export interface WhatsNewHeading {
  heading: string;
  tone?: WhatsNewTone;
}

export type WhatsNewEntry = WhatsNewItem | WhatsNewHeading;

/** A picture shown full width at the top of the list: a file in src/renderer/src/assets/whats-new/. */
export interface WhatsNewImage {
  file: string;
  alt?: string;
}

/** A release that announces itself once, the first time One Launch opens after the update that brought it. `date` is YYYY-MM-DD. */
export interface WhatsNewRelease {
  version: string;
  date: string;
  intro?: string;
  image?: WhatsNewImage;
  items: readonly WhatsNewEntry[];
}

export function isWhatsNewHeading(entry: WhatsNewEntry): entry is WhatsNewHeading {
  return 'heading' in entry;
}

/** The list as rendered: each separator with the items under it; items before the first separator form a group with none. */
export interface WhatsNewGroup {
  heading: WhatsNewHeading | null;
  items: WhatsNewItem[];
}

export function groupWhatsNew(entries: readonly WhatsNewEntry[]): WhatsNewGroup[] {
  const groups: WhatsNewGroup[] = [];
  for (const entry of entries) {
    if (isWhatsNewHeading(entry)) {
      groups.push({ heading: entry, items: [] });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last) last.items.push(entry);
    else groups.push({ heading: null, items: [entry] });
  }
  return groups;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_VERSION_LENGTH = 64;

export function isVersionString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && VERSION_RE.test(value);
}

function parseVersion(version: string): { core: number[]; pre: string[] } {
  const dash = version.indexOf('-');
  const core = (dash === -1 ? version : version.slice(0, dash)).split('.').map(Number);
  const pre = dash === -1 ? [] : version.slice(dash + 1).split('.');
  return { core, pre };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver order: the numeric core, then a prerelease sorts before the release it precedes, then prerelease ids numerically or alphabetically. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    if (pa.pre.length === pb.pre.length) return 0;
    return pa.pre.length === 0 ? 1 : -1;
  }
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const d = compareIdentifiers(x, y);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The newest release at or below the running version that the user has not seen yet. A `lastSeen` of null (or one that
 * is not a version) counts as older than everything, which is what an install from before this feature has.
 */
export function pickWhatsNew(releases: readonly WhatsNewRelease[], current: string, lastSeen: string | null): WhatsNewRelease | null {
  if (!isVersionString(current)) return null;
  const seen = isVersionString(lastSeen) ? lastSeen : null;
  let best: WhatsNewRelease | null = null;
  for (const release of releases) {
    if (!isVersionString(release.version) || compareVersions(release.version, current) > 0) continue;
    if (seen !== null && compareVersions(release.version, seen) <= 0) continue;
    if (best === null || compareVersions(release.version, best.version) > 0) best = release;
  }
  return best;
}

/** The newest release at or below the running version, seen or not: what Settings shows on request. */
export function latestWhatsNew(releases: readonly WhatsNewRelease[], current: string): WhatsNewRelease | null {
  return pickWhatsNew(releases, current, null);
}
