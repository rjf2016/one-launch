import { createNormaliser, measureVolatile, normaliseRuns } from '../../lib/normalise.mjs';
import { aliasUuidTails, maskStamps, sha256 } from './project';
import type { RawRun } from './runner';

export interface Field {
  path: string;
  rule: string;
}

export interface Stabilised {
  value: { events: Record<string, unknown>[]; final: Record<string, unknown> };
  stable: boolean;
  /** Paths whose value differed between the recordings as recorded, before any rule ran. */
  volatile: string[];
  /** Every path a rule changed, with the rule. */
  normalised: Field[];
  /** Changed by a rule although the recordings agreed there. */
  normalisedNotVolatile: Field[];
  /** `*_enc` paths that hold no value in any row of any recording: the one place a rule may write where nothing differed, `{ present: false }` for a null. */
  emptyEncColumns: string[];
  /** Differed between the recordings and no rule changed it. */
  volatileNotNormalised: string[];
  structural: string[];
  unexplained: string[];
}

type Plain = Record<string, unknown>;

const segment = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
const isPlain = (value: unknown): value is Plain => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
const allSame = <T>(items: T[]): boolean => items.every((item) => item === items[0]);

/** Walks the recordings side by side, position by position, and hands `visit` the objects that sit at the same place in each. */
function together(nodes: unknown[], path: string, visit: (objects: Plain[], path: string) => void): void {
  if (nodes.every(Array.isArray)) {
    const lists = nodes as unknown[][];
    if (!allSame(lists.map((list) => list.length))) return;
    lists[0]!.forEach((_, i) =>
      together(
        lists.map((list) => list[i]),
        `${path}/*`,
        visit,
      ),
    );
    return;
  }
  if (!nodes.every(isPlain)) return;
  const objects = nodes as Plain[];
  visit(objects, path);
  for (const key of Object.keys(objects[0]!)) {
    if (objects.every((object) => key in object))
      together(
        objects.map((object) => object[key]),
        `${path}/${segment(key)}`,
        visit,
      );
  }
}

function withoutProjections(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProjections);
  if (!isPlain(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'projectionSha256')
      .map(([key, item]) => [key, withoutProjections(item)]),
  );
}

const isManifestWrite = (event: Plain): boolean =>
  event['op'] === 'file.write' && typeof event['path'] === 'string' && /\\backups\\[a-z]+\\[^\\]+\\manifest\.json$/.test(event['path']);

/**
 * Makes several recordings of one script compare equal, and says exactly what it took. The harness's own rules run
 * first and only where the recordings differ at the same place; the protected normaliser does the rest.
 */
export function stabilise(runs: RawRun[]): Stabilised {
  const raw = measureVolatile(runs.map((run) => withoutProjections(run.value)));
  const values = runs.map((run) => structuredClone(run.value));
  const text = runs.map((run) => createNormaliser({ roots: run.roots, aliases: run.aliases }).text);
  const notes = new Map<string, Field>();
  const note = (path: string, rule: string): void => void notes.set(`${path}\u0000${rule}`, { path, rule });
  const filled = new Set<string>();
  const empty = new Set<string>();

  together(values, '', (objects, path) => {
    // A content digest: of the bytes where every recording wrote the same bytes, else of the masked text.
    if (objects.every((o) => typeof o['sha256'] === 'string' && typeof o['projectionSha256'] === 'string')) {
      if (allSame(objects.map((o) => o['sha256']))) {
        for (const o of objects) delete o['projectionSha256'];
      } else if (allSame(objects.map((o) => o['projectionSha256']))) {
        for (const o of objects) delete o['sha256'];
        note(`${path}/sha256`, 'projection');
      } else if (objects.every(isManifestWrite)) {
        // A snapshot's manifest holds its creation time; what it says is in the final state.
        for (const o of objects) {
          delete o['sha256'];
          delete o['projectionSha256'];
        }
        note(`${path}/sha256`, 'manifest');
      }
    }
    // A vault-encrypted value whose plaintext holds a simulator stamp: the digest of the masked plaintext, under the name without `_enc`.
    for (const key of Object.keys(objects[0]!)) {
      if (!key.endsWith('_enc')) continue;
      (objects.some((o) => o[key] instanceof Uint8Array) ? filled : empty).add(`${path}/${segment(key)}`);
      if (!objects.every((o) => o[key] instanceof Uint8Array)) continue;
      const plain = objects.map((o, i) => runs[i]!.vault.decrypt(Buffer.from(o[key] as Uint8Array)));
      if (allSame(plain)) continue;
      const masked = plain.map((value, i) => sha256(text[i]!(maskStamps(value))));
      if (!allSame(masked)) continue;
      for (const o of objects) {
        delete o[key];
        o[key.slice(0, -'_enc'.length)] = { present: true, projectionSha256: masked[0] };
      }
      note(`${path}/${segment(key)}`, 'enc-projection');
    }
  });

  // The logger leaves the last four characters of an id; they become the id's alias.
  for (const level of ['warn', 'error'] as const) {
    values.forEach((value, i) => {
      const lines = (value.final['log'] as Record<string, string[]>)[level]!;
      lines.forEach((line, at) => {
        const aliased = aliasUuidTails(line, runs[i]!.ids);
        if (aliased === line) return;
        lines[at] = aliased;
        note(`/final/log/${level}/*`, 'log-id');
      });
    });
  }

  const result = normaliseRuns(values.map((value, i) => ({ value, roots: runs[i]!.roots, aliases: runs[i]!.aliases, vault: runs[i]!.vault })));
  const normalised = [...new Map([...(result.fields as Field[]), ...notes.values()].map((f) => [`${f.path}\u0000${f.rule}`, f])).values()].sort((a, b) =>
    a.path === b.path ? (a.rule < b.rule ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
  const touched = new Set(normalised.map((f) => f.path));
  const differed = new Set(raw.volatile);
  return {
    value: result.value as Stabilised['value'],
    stable: result.stable && raw.structural.length === 0,
    volatile: raw.volatile,
    normalised,
    normalisedNotVolatile: normalised.filter((f) => !differed.has(f.path)),
    emptyEncColumns: [...empty].filter((path) => !filled.has(path)).sort(),
    volatileNotNormalised: raw.volatile.filter((path) => !touched.has(path)),
    structural: [...new Set([...raw.structural, ...result.structural])].sort(),
    unexplained: result.unexplained,
  };
}
