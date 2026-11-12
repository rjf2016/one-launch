import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../lib/bundle.mjs';
import { repoRoot, resolveOut, writeArtefact } from '../lib/out.mjs';
import { runSession, scratchBase } from './kit.mjs';
import { AREAS, SHOTS_DIR, areaFile, readRows, repeatRecord } from './rows.mjs';
import { maskVolatile } from './sidecar.mjs';

function compare(first, second) {
  if (first.equals(second)) return 'identical';
  const a = maskVolatile(JSON.parse(first.toString('utf8')));
  const b = maskVolatile(JSON.parse(second.toString('utf8')));
  return JSON.stringify(a) === JSON.stringify(b) ? 'volatile' : 'different';
}

function firstDifference(first, second) {
  const a = maskVolatile(JSON.parse(first.toString('utf8')));
  const b = maskVolatile(JSON.parse(second.toString('utf8')));
  for (const key of Object.keys({ ...a, ...b })) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    if (!Array.isArray(a[key]) || !Array.isArray(b[key])) return `${key}: ${JSON.stringify(a[key])} against ${JSON.stringify(b[key])}`;
    if (a[key].length !== b[key].length) return `${key}: ${a[key].length} entries against ${b[key].length}`;
    const at = a[key].findIndex((item, i) => JSON.stringify(item) !== JSON.stringify(b[key][i]));
    return `${key}[${at}]: ${JSON.stringify(a[key][at])} against ${JSON.stringify(b[key][at])}`;
  }
  return 'no difference found';
}

async function main(argv) {
  const out = resolveOut(argv);
  const skip = argv.indexOf('--out');
  const area = argv.find((arg, i) => !arg.startsWith('--') && (skip === -1 || i !== skip + 1));
  if (!area || !AREAS[area]) {
    console.error(
      `usage: node scripts/oracle/ui/capture.mjs <${Object.keys(AREAS).join('|')}> [--only=<session>,...] [--repeat] [--no-build] [--out <folder>]`,
    );
    return 2;
  }
  const only = argv
    .find((arg) => arg.startsWith('--only='))
    ?.slice('--only='.length)
    .split(',');
  const repeat = argv.includes('--repeat');
  if (!argv.includes('--no-build')) {
    console.log('Building the unpackaged app (npx electron-vite build)');
    const build = spawnSync('npx electron-vite build', { cwd: repoRoot, stdio: 'inherit', shell: true });
    if (build.status !== 0) return build.status ?? 1;
  }

  const mod = await import(pathToFileURL(areaFile(area)).href);
  const sessions = mod.sessions.filter((spec) => !only || only.includes(spec.name));
  if (only && sessions.length !== only.length) {
    console.error(`${area} has no session named ${only.filter((name) => !mod.sessions.some((spec) => spec.name === name)).join(', ')}`);
    return 2;
  }
  const rows = readRows(out);
  const target = repeat ? join(scratchBase(), `ui-${area}-repeat-out`) : out;
  if (repeat) rmSync(target, { recursive: true, force: true });
  console.log(`${AREAS[area].title}: ${sessions.length} session${sessions.length === 1 ? '' : 's'}${repeat ? ', a second capture to compare' : ''}`);

  const results = [];
  for (const spec of sessions) {
    console.log(`\nSESSION ${area}/${spec.name}`);
    results.push(await runSession({ area, spec, rows, out: target, slot: `ui-${area}` }));
  }
  const failed = results.filter((result) => result.error !== null);
  const taken = results.flatMap((result) => result.taken);
  console.log(`\n${taken.length} shots from ${results.length - failed.length} of ${results.length} sessions`);
  for (const result of failed) console.log(`FAILED  ${result.name}: ${result.error.message.split('\n')[0]}`);

  let different = 0;
  if (repeat) {
    const recordPath = join(out, repeatRecord(area));
    const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : { area, sidecars: {} };
    for (const { stem } of taken) {
      const file = `${SHOTS_DIR}/${stem}.layout.json`;
      if (!existsSync(join(out, file))) {
        console.log(`MISSING  ${file} has no first capture`);
        different += 1;
        continue;
      }
      const first = readFileSync(join(out, file));
      const second = readFileSync(join(target, file));
      const verdict = compare(first, second);
      if (verdict === 'different') {
        different += 1;
        delete record.sidecars[file];
        console.log(`DIFFERENT  ${file}  ${firstDifference(first, second)}`);
      } else {
        record.sidecars[file] = { sha256: sha256(first), repeat: verdict };
      }
    }
    record.sidecars = Object.fromEntries(Object.entries(record.sidecars).sort(([a], [b]) => a.localeCompare(b)));
    writeArtefact(out, repeatRecord(area), record);
    const verdicts = taken.map(({ stem }) => record.sidecars[`${SHOTS_DIR}/${stem}.layout.json`]?.repeat);
    console.log(
      `repeat: ${verdicts.filter((v) => v === 'identical').length} identical, ${verdicts.filter((v) => v === 'volatile').length} identical outside their volatile runs, ${different} different`,
    );
    if (different === 0) rmSync(target, { recursive: true, force: true });
    else console.log(`The second capture is kept in ${target}`);
  }
  return failed.length === 0 && different === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
