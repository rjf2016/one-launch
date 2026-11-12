import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ORACLE_CLOCK } from '../lib/clock.mjs';
import { resolveOut, writeArtefact } from '../lib/out.mjs';
import { AREAS, STATUS_FILE, areaFile, filesOf, readRows, repeatRecord } from './rows.mjs';

const LOCALE = 'en-US';
const TIMEZONE = 'UTC';

export async function buildStatus(out) {
  const notes = {};
  const repeats = {};
  for (const area of Object.keys(AREAS)) {
    notes[area] = existsSync(areaFile(area)) ? ((await import(pathToFileURL(areaFile(area)).href)).rows ?? {}) : null;
    const record = join(out, repeatRecord(area));
    Object.assign(repeats, existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')).sidecars : {});
  }
  const rows = readRows(out).map((row) => {
    const base = { id: row.id, name: row.name, area: row.area };
    const note = row.area ? (notes[row.area]?.[row.id] ?? {}) : {};
    if (row.owner !== null) return { ...base, status: 'owner', reason: row.owner };
    if (note.owner) return { ...base, status: 'owner', reason: note.owner };
    if (note.skipped) return { ...base, status: 'skipped', reason: note.skipped };
    const files = filesOf(row);
    const present = files.filter((file) => existsSync(join(out, file.png)) && existsSync(join(out, file.sidecar)));
    if (present.length !== files.length) {
      const why =
        notes[row.area] === null ? 'its area has no scenario file yet' : `${files.length - present.length} of its ${files.length} shots are not in ui/shots`;
      return { ...base, status: 'missing', reason: why };
    }
    return {
      ...base,
      status: 'captured',
      ...(note.how ? { how: note.how } : {}),
      files: files.map((file) => ({ png: file.png, sidecar: file.sidecar, size: file.size, repeat: repeats[file.sidecar]?.repeat ?? null })),
    };
  });
  const count = (status) => rows.filter((row) => row.status === status).length;
  return {
    clock: { start: ORACLE_CLOCK, runs: 'main and the page both start here and run on at the real rate' },
    locale: LOCALE,
    tz: TIMEZONE,
    counts: { rows: rows.length, captured: count('captured'), owner: count('owner'), skipped: count('skipped'), missing: count('missing') },
    rows,
  };
}

async function main(argv) {
  const out = resolveOut(argv);
  const status = await buildStatus(out);
  writeArtefact(out, STATUS_FILE, status);
  const { counts } = status;
  console.log(
    `${STATUS_FILE}: ${counts.rows} rows, ${counts.captured} captured, ${counts.owner} owner, ${counts.skipped} skipped, ${counts.missing} without a status`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
