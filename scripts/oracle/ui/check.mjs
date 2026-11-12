import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../lib/bundle.mjs';
import { jsonText, resolveOut } from '../lib/out.mjs';
import { createUserPathScanner } from '../lib/user-paths.mjs';
import { pngSize } from './png.mjs';
import { AREAS, SHOTS_DIR, STATUS_FILE, readRows } from './rows.mjs';
import { sidecarStrings } from './sidecar.mjs';
import { buildStatus } from './status.mjs';

const MAX_LISTED = 12;

async function main(argv) {
  const out = resolveOut(argv);
  const area = argv.find((arg) => arg.startsWith('--area='))?.slice('--area='.length) ?? null;
  if (area !== null && !AREAS[area]) {
    console.error(`no area named ${area}; the areas are ${Object.keys(AREAS).join(', ')}`);
    return 2;
  }
  const checks = [];
  const check = (name, run) => {
    const problems = [];
    const summary = run(problems);
    checks.push({ name, ok: problems.length === 0, summary, problems });
  };

  const status = await buildStatus(out);
  const stored = existsSync(join(out, STATUS_FILE)) ? readFileSync(join(out, STATUS_FILE), 'utf8') : null;
  const total = readRows(out).length;
  const rows = status.rows.filter((row) => area === null || row.area === area);
  const captured = rows.filter((row) => row.status === 'captured');
  const files = captured.flatMap((row) => row.files.map((file) => ({ ...file, id: row.id })));

  check('every checklist id has a status: captured, owner, or skipped with a reason', (problems) => {
    if (stored === null) problems.push(`${STATUS_FILE} is missing; run status.mjs`);
    else if (stored !== jsonText(status)) problems.push(`${STATUS_FILE} is not what the bundle and the area files give now; run status.mjs`);
    for (const row of rows) {
      if (row.status === 'missing') problems.push(`row ${row.id} ${row.name}: no status (${row.reason})`);
      else if (row.status !== 'captured' && !row.reason) problems.push(`row ${row.id} ${row.name}: ${row.status} without a reason`);
    }
    const count = (name) => rows.filter((row) => row.status === name).length;
    return `${rows.length} of ${total} ids: ${count('captured')} captured, ${count('owner')} owner, ${count('skipped')} skipped`;
  });

  check('every captured id has a PNG at 1280x800 (and 960x600 where marked) and a layout sidecar', (problems) => {
    for (const file of files) {
      const [width, height] = pngSize(readFileSync(join(out, file.png)));
      if (width !== file.size[0] || height !== file.size[1]) problems.push(`${file.png}: ${width}x${height}, not ${file.size.join('x')}`);
      const sidecar = JSON.parse(readFileSync(join(out, file.sidecar), 'utf8'));
      if (sidecar.id !== file.id) problems.push(`${file.sidecar}: its id is ${sidecar.id}`);
      if (sidecar.viewport[0] !== file.size[0] || sidecar.viewport[1] !== file.size[1])
        problems.push(`${file.sidecar}: its viewport is ${sidecar.viewport.join('x')}`);
    }
    if (area === null && existsSync(join(out, SHOTS_DIR))) {
      const known = new Set(status.rows.flatMap((row) => (row.files ?? []).flatMap((file) => [file.png, file.sidecar])));
      for (const name of readdirSync(join(out, SHOTS_DIR)))
        if (!known.has(`${SHOTS_DIR}/${name}`)) problems.push(`${SHOTS_DIR}/${name}: belongs to no captured row`);
    }
    const small = files.filter((file) => file.size[0] === 960).length;
    return `${captured.length} ids, ${files.length} PNGs with their sidecars: ${files.length - small} at 1280x800, ${small} at 960x600`;
  });

  check('capturing a state twice gives an identical sidecar', (problems) => {
    const records = {};
    for (const name of Object.keys(AREAS)) {
      const record = join(out, `ui/repeat/${name}.json`);
      Object.assign(records, existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')).sidecars : {});
    }
    let identical = 0;
    let volatile = 0;
    for (const file of files) {
      const record = records[file.sidecar];
      if (!record) problems.push(`${file.sidecar}: not captured a second time`);
      else if (record.sha256 !== sha256(readFileSync(join(out, file.sidecar))))
        problems.push(`${file.sidecar}: captured again since its second capture was compared`);
      else if (record.repeat === 'identical') identical += 1;
      else volatile += 1;
    }
    return `${files.length} sidecars against a second capture: ${identical} byte for byte, ${volatile} identical outside the runs flagged volatile`;
  });

  check('no sidecar text contains a user path', (problems) => {
    const scanner = createUserPathScanner();
    let strings = 0;
    for (const file of files) {
      for (const value of sidecarStrings(JSON.parse(readFileSync(join(out, file.sidecar), 'utf8')))) {
        strings += 1;
        for (const hit of scanner.scanText(value)) problems.push(`${file.sidecar}: ${hit.kind} ${hit.masked}`);
      }
    }
    return `${strings} strings in ${files.length} sidecars scanned`;
  });

  console.log(`UI capture checks${area ? ` for ${area}` : ''}: ${out}`);
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}: ${item.summary}`);
    for (const problem of item.problems.slice(0, MAX_LISTED)) console.log(`      ${problem}`);
    if (item.problems.length > MAX_LISTED) console.log(`      and ${item.problems.length - MAX_LISTED} more`);
  }
  const ok = checks.every((item) => item.ok);
  console.log(ok ? '\nUI capture checks passed.' : '\nUI capture checks FAILED.');
  return ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
