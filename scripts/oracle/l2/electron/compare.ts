import { isDeepStrictEqual } from 'node:util';
import { createNormaliser, type Aliases } from '../../lib/normalise.mjs';
import { aliasUuidTails, maskStamps, sha256 } from '../harness/project';

type Plain = Record<string, unknown>;

export interface Recording {
  events: Plain[];
  final: Plain;
  roots: { launchers: string; data: string };
  aliases: Aliases;
  ids: ReadonlyMap<string, string>;
  vault: { decrypt: (ciphertext: Buffer) => string };
}

export interface Comparison {
  differences: string[];
  /** What the expectation holds and a traced Electron run cannot show, so it was left out of the comparison. */
  notCompared: string[];
  platEvents: number;
  jobEvents: number;
  jobEventsInElectron: number;
}

const isPlain = (value: unknown): value is Plain => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
const withoutSeq = ({ seq: _seq, ...rest }: Plain): Plain => rest;

/**
 * Brings one recording to the expectation's shape where the two record the same thing differently: which of the two
 * content digests the expectation kept at each place, and a stamped vault value as the digest of its masked plaintext.
 */
function align(expected: unknown, actual: unknown, path: string, rec: Recording, text: (value: string) => string, notCompared: string[]): void {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let i = 0; i < Math.min(expected.length, actual.length); i += 1) align(expected[i], actual[i], `${path}/${i}`, rec, text, notCompared);
    return;
  }
  if (!isPlain(expected) || !isPlain(actual)) return;
  if (typeof actual['sha256'] === 'string' && typeof actual['projectionSha256'] === 'string') {
    if ('sha256' in expected) delete actual['projectionSha256'];
    else if ('projectionSha256' in expected) delete actual['sha256'];
    else {
      delete actual['sha256'];
      delete actual['projectionSha256'];
    }
  } else if (typeof actual['sha256'] === 'string' && !('sha256' in expected)) {
    // The app's own trace carries the digest of the bytes and nothing else.
    if ('projectionSha256' in expected) {
      notCompared.push(`${path}/projectionSha256: Electron's trace has only the digest of the bytes written`);
      delete expected['projectionSha256'];
    }
    delete actual['sha256'];
  }
  for (const key of Object.keys(expected)) {
    const enc = `${key}_enc`;
    if (key in actual || !(actual[enc] instanceof Uint8Array)) continue;
    const plain = rec.vault.decrypt(Buffer.from(actual[enc] as Uint8Array));
    delete actual[enc];
    actual[key] = { present: true, projectionSha256: sha256(text(maskStamps(plain))) };
  }
  for (const key of Object.keys(expected)) if (key in actual) align(expected[key], actual[key], `${path}/${key}`, rec, text, notCompared);
}

function firstDifference(expected: unknown, actual: unknown, path: string): string | null {
  if (isDeepStrictEqual(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      const only = (from: unknown[], other: unknown[]): string =>
        JSON.stringify(from.filter((item) => !other.some((o) => isDeepStrictEqual(o, item)))).slice(0, 1500);
      return `${path}: ${expected.length} entries expected, ${actual.length} in Electron; only expected ${only(expected, actual)}; only in Electron ${only(actual, expected)}`;
    }
    for (let i = 0; i < expected.length; i += 1) {
      const found = firstDifference(expected[i], actual[i], `${path}/${i}`);
      if (found) return found;
    }
  }
  if (isPlain(expected) && isPlain(actual)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (!(key in expected)) return `${path}/${key}: only in Electron`;
      if (!(key in actual)) return `${path}/${key}: only in the expectation`;
      const found = firstDifference(expected[key], actual[key], `${path}/${key}`);
      if (found) return found;
    }
  }
  return `${path}: expected ${JSON.stringify(expected)?.slice(0, 300)}, Electron ${JSON.stringify(actual)?.slice(0, 300)}`;
}

/**
 * The oracle's own comparison, on a recording made through real Electron: platform events in exact order, the
 * expectation's job events as a subsequence of the recorded ones, and the final state exactly.
 */
export function compare(expectation: { events: Plain[]; final: Plain }, rec: Recording, timePaths: readonly string[]): Comparison {
  const expected = structuredClone(expectation);
  const notCompared: string[] = [];
  const text = createNormaliser({ roots: rec.roots, aliases: rec.aliases }).text;

  if ('registry' in expected.final) {
    notCompared.push("/final/registry: the fake registry lives in the app's memory and a running Electron shows none of it");
    delete expected.final['registry'];
  }
  const log = rec.final['log'] as Record<string, string[]>;
  for (const level of ['warn', 'error']) log[level] = log[level]!.map((line) => aliasUuidTails(line, rec.ids));

  const plat = (events: Plain[]): Plain[] => events.filter((e) => e['k'] === 'plat').map(withoutSeq);
  const job = (events: Plain[]): Plain[] => events.filter((e) => e['k'] === 'job').map(withoutSeq);
  const expectedPlat = plat(expected.events);
  const actualPlat = plat(rec.events);
  align(expectedPlat, actualPlat, '/events(plat)', rec, text, notCompared);
  align(expected.final, rec.final, '/final', rec, text, notCompared);

  // Jobs first, so their paths are `/events/*/...` as the normalisation report names them; the order between the two kinds is not what is compared.
  const normalised = createNormaliser({ roots: rec.roots, aliases: rec.aliases, vault: rec.vault, volatile: [...timePaths] }).normalise({
    events: [...job(rec.events), ...actualPlat],
    final: rec.final,
  }) as { events: Plain[]; final: Plain };
  const actualJobs = normalised.events.filter((e) => e['k'] === 'job');
  const differences: string[] = [];

  const platDifference = firstDifference(
    expectedPlat,
    normalised.events.filter((e) => e['k'] === 'plat'),
    '/events(plat)',
  );
  if (platDifference) differences.push(platDifference);

  const expectedJobs = job(expected.events);
  let at = 0;
  for (const [i, want] of expectedJobs.entries()) {
    while (at < actualJobs.length && !isDeepStrictEqual(actualJobs[at], want)) at += 1;
    if (at === actualJobs.length) {
      const steps = (want['steps'] as string[][]).map((s) => `${s[0]}:${s[1]}`).join(' ');
      differences.push(`/events(job)/${i}: Electron's job stream has no ${String(want['job'])} ${String(want['state'])} [${steps}] after the states before it`);
      break;
    }
    at += 1;
  }

  for (const key of Object.keys(expected.final)) {
    const found = firstDifference(expected.final[key], normalised.final[key], `/final/${key}`);
    if (found) differences.push(found);
  }
  for (const key of Object.keys(normalised.final)) if (!(key in expected.final)) differences.push(`/final/${key}: only in Electron`);

  return { differences, notCompared, platEvents: expectedPlat.length, jobEvents: expectedJobs.length, jobEventsInElectron: actualJobs.length };
}
