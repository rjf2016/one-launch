import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../../app-driver.mjs';
import { ORACLE_CLOCK } from '../lib/clock.mjs';
import { jsonText, resolveOut, writeArtefact } from '../lib/out.mjs';
import { conditions, loadFixtures } from './conditions.mjs';
import { FIRST_CHECK_MS, LATE_LIMIT_MS, recordRun } from './record.mjs';
import { sha256, stabilise } from './stabilise.mjs';

const here = dirname(fileURLToPath(import.meta.url));
process.env.ORACLE_SCRATCH ??= resolve(repoRoot, '..', 'oracle-scratch', 't06');
const SCRATCH = process.env.ORACLE_SCRATCH;
export const FOLDER = 'l2/updates';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name, fallback) => {
  const hit = flag(name);
  return hit && hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : fallback;
};
const names = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
const runsWanted = Number(flagValue('runs', '3'));
const repeat = Boolean(flag('repeat'));
const out = resolveOut(args);

const appVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

async function directVerdict(cond) {
  if (!cond.direct) return undefined;
  const { verifyManifest, keyIdOf } = await import('../../../src/main/updates/manifest.ts');
  const input = 'not a manifest';
  return {
    note: 'electron-updater never hands verifyManifest a value that is not an object (its version check throws first), so this check is unreachable through the engine; the verdict is verifyManifest called directly on the value js-yaml loads from the served text',
    input,
    verdict: verifyManifest(
      input,
      cond.keys.map((spki) => ({ id: keyIdOf(spki), spki })),
    ),
  };
}

async function describeFeed(cond, fx) {
  const { keyIdOf } = await import('../../../src/main/updates/manifest.ts');
  const keys = cond.keys.map((spki) => keyIdOf(spki));
  if (!cond.feed) return { url: 'http://127.0.0.1:{port}/', listening: false, keys };
  const installer = cond.feed.installer;
  return {
    url: 'http://127.0.0.1:{port}/',
    listening: true,
    keys,
    ...(cond.feed.status ? { status: cond.feed.status } : {}),
    manifest: cond.feed.manifest,
    installer: { path: `/${fx.url}`, bytes: installer.length, text: installer.toString('utf8'), matchesManifest: installer.equals(fx.installer) },
    ...(cond.paced
      ? { paced: 'the installer is sent in three parts: the first third, 1.2 s later the second third, then the rest once a progress report has been seen' }
      : {}),
    ...(cond.autoOffAt ? { autoOffAt: cond.autoOffAt } : {}),
  };
}

function checkRun(cond, run) {
  const problems = [];
  if (run.firstCheckMs === null) problems.push('the first-check timer never fired');
  else if (run.firstCheckMs < FIRST_CHECK_MS || run.firstCheckMs > FIRST_CHECK_MS + LATE_LIMIT_MS)
    problems.push(`the first check fired ${run.firstCheckMs} ms after it was armed`);
  for (const step of run.value.steps) if (step.exit !== undefined && step.exit !== 0) problems.push(`${step.step} ended with exit code ${step.exit}`);
  const errors = run.value.steps.flatMap((s) => s.log).filter((l) => l.level === 'ERROR');
  if (errors.length) problems.push(`${errors.length} ERROR lines from the updater`);
  return problems;
}

async function captureCondition(cond, fx) {
  const runs = [];
  for (let i = 1; i <= runsWanted; i += 1) {
    const t0 = Date.now();
    const run = await recordRun(cond, fx, { slot: `run-${cond.name}` });
    const problems = checkRun(cond, run);
    console.log(
      `RUN   ${cond.name} ${i}/${runsWanted}  ${Math.round((Date.now() - t0) / 100) / 10} s  first check after ${run.firstCheckMs} ms${problems.length ? `  PROBLEM ${problems.join('; ')}` : ''}`,
    );
    if (problems.length) throw new Error(`${cond.name}: ${problems.join('; ')}`);
    runs.push(run);
  }
  const result = stabilise(runs);
  if (!result.stable) {
    const dir = join(SCRATCH, `unstable-${cond.name}`);
    mkdirSync(dir, { recursive: true });
    runs.forEach((run, i) => writeFileSync(join(dir, `run-${i + 1}.json`), jsonText(run)));
    writeFileSync(join(dir, 'report.json'), jsonText({ unexplained: result.unexplained, structural: result.structural }));
    throw new Error(
      `${cond.name}: the ${runs.length} recordings do not normalise to one transcript (unexplained ${result.unexplained.join(', ') || 'none'}; structural ${result.structural.join(', ') || 'none'}); recordings kept in ${dir}`,
    );
  }
  const direct = await directVerdict(cond);
  const head = {
    condition: cond.name,
    title: cond.title,
    group: cond.group,
    app: { version: appVersion, mode: 'unpackaged, fake launchers "none", test feed', clock: ORACLE_CLOCK },
    feed: await describeFeed(cond, fx),
    ...(direct ? { direct } : {}),
  };
  const transcript = { ...head, recorded: result.value };
  const digests = result.perRun.map((recorded) => sha256(jsonText({ ...head, recorded })));
  if (digests.some((x) => x !== sha256(jsonText(transcript)))) throw new Error(`${cond.name}: a recording's transcript differs from the one written`);
  const normalisation = {
    condition: cond.name,
    runs: runs.length,
    digests,
    rules: result.rules,
    volatile: result.volatile,
    transientDropped: result.transientDropped,
  };
  return { transcript, normalisation, seconds: runs.map((r) => Math.round(r.elapsedMs / 1000)) };
}

async function main() {
  const fx = loadFixtures(out);
  const all = conditions(fx, appVersion);
  const unknown = names.filter((n) => !all.some((c) => c.name === n));
  if (unknown.length) throw new Error(`unknown condition(s): ${unknown.join(', ')}`);
  if (!flag('readme')) {
    const chosen = names.length ? all.filter((c) => names.includes(c.name)) : all;
    const started = Date.now();
    let failed = 0;
    for (const cond of chosen) {
      try {
        const { transcript, normalisation } = await captureCondition(cond, fx);
        if (repeat) {
          const bundled = JSON.parse(readFileSync(join(out, FOLDER, `${cond.name}.json`), 'utf8'));
          const same = jsonText(bundled) === jsonText(transcript);
          console.log(`${same ? 'SAME ' : 'DIFF '} ${cond.name}`);
          if (!same) {
            failed += 1;
            writeFileSync(join(SCRATCH, `repeat-${cond.name}.json`), jsonText(transcript));
          }
        } else {
          writeArtefact(out, `${FOLDER}/${cond.name}.json`, transcript);
          writeArtefact(out, `${FOLDER}/normalisation/${cond.name}.json`, normalisation);
          console.log(`WROTE ${FOLDER}/${cond.name}.json`);
        }
      } catch (err) {
        failed += 1;
        console.log(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`${chosen.length} condition(s), ${runsWanted} recordings each, ${Math.round((Date.now() - started) / 1000)} s, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
  if (!repeat) writeArtefact(out, `${FOLDER}/README.md`, readFileSync(join(here, 'bundle', 'README.md'), 'utf8'));
}

await main();
