// The acceptance checks of ticket M0-T10 against the bundle. One PASS or FAIL line per check; exit 0 only when all pass.
//   node scripts/oracle/perf/check.mjs [--out <bundle>] [--skip-verify]
// --skip-verify leaves out the run of verify.mjs over the whole bundle, which takes minutes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveOut, repoRoot } from '../lib/out.mjs';
import { PACKAGED_DIR, folderSize, median, percentile } from './lib.mjs';

const argv = process.argv.slice(2);
const out = resolveOut(argv);
const skipVerify = argv.includes('--skip-verify');
const BASELINE = join(out, 'perf', 'baseline.json');
const METHOD = join(out, 'perf', 'METHOD.md');

export const METRICS = [
  { id: 'warm-start', paths: ['warmStart.fromProcessCreationMs.interactive.median', 'warmStart.fromProcessCreationMs.interactive.p95'] },
  {
    id: 'memory',
    paths: ['warmFolder', 'largeDb'].flatMap((session) =>
      ['visible', 'hidden'].flatMap((state) =>
        ['privateWorkingSet', 'workingSet', 'privateBytes'].map((counter) => `idle.${session}.summary.${state}.memoryBytes.${counter}.median`),
      ),
    ),
  },
  {
    id: 'idle-cpu',
    paths: ['visible', 'hidden'].flatMap((state) => [
      `idle.largeDb.summary.${state}.cpuPctOfCore.total.median`,
      `idle.largeDb.summary.${state}.cpuPctOfCore.totalFromOsCounters.median`,
    ]),
  },
  { id: 'install-size', paths: ['install.unpacked.bytes', 'install.unpacked.files'] },
  { id: 'installer-size', paths: ['install.installer.bytes'] },
  {
    id: 'launchers-status',
    paths: [
      'launchersStatus.firstCallPerStartMs.median',
      'launchersStatus.firstCallPerStartMs.p95',
      'launchersStatus.repeatedCallsMs.median',
      'launchersStatus.repeatedCallsMs.p95',
    ],
  },
];

const at = (value, path) => path.split('.').reduce((v, key) => (v === null || v === undefined ? undefined : v[key]), value);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const close = (a, b) => isNum(a) && isNum(b) && Math.abs(a - b) < 1e-6;

const results = [];
async function check(name, run) {
  const problems = [];
  let note = '';
  try {
    note = (await run(problems)) ?? '';
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  results.push(problems.length === 0);
  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${name}${note ? `: ${note}` : ''}`);
  for (const p of problems.slice(0, 25)) console.log(`      ${p}`);
  if (problems.length > 25) console.log(`      … ${problems.length - 25} more`);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;

await check('at least 10 warm starts measured on the packaged build, each from a start the page reported visible', (problems) => {
  if (!baseline) return void problems.push(`${BASELINE} is missing`);
  if (baseline.measured?.exe !== 'dist/win-unpacked/OneLaunch.exe') problems.push(`measured.exe is ${baseline.measured?.exe}, not the packaged build`);
  const samples = baseline.warmStart?.samples ?? [];
  if (samples.length < 10) problems.push(`${samples.length} warm starts`);
  const notVisible = [];
  samples.forEach((s, i) => {
    if (s.role !== 'warm') problems.push(`sample ${i} is a ${s.role} start`);
    if (!s.startupLineFound) problems.push(`sample ${i}: no startup line`);
    for (const [mark, v] of Object.entries(s.marks)) if (!isNum(v)) problems.push(`sample ${i}: ${mark} is ${v}`);
    if (!isNum(s.interactiveMs)) problems.push(`sample ${i}: no interactive time`);
    else if (!close(s.interactiveMs, Math.max(s.marks.pageLibraryFrameMs, s.marks.pageFirstContentfulPaintMs)))
      problems.push(`sample ${i}: interactiveMs is not max(library frame, first contentful paint)`);
    if (s.visibility !== 'visible' || !s.visibilityEntries.every(([state]) => state === 'visible')) notVisible.push(i);
  });
  if (notVisible.length && typeof baseline.warmStart?.notVisibleReason !== 'string')
    problems.push(`starts ${notVisible.join(', ')} were not visible and the baseline gives no reason`);
  const values = samples.map((s) => s.interactiveMs);
  const stored = baseline.warmStart?.fromProcessCreationMs?.interactive ?? {};
  if (!close(stored.median, median(values))) problems.push(`stored median ${stored.median} is not the samples' ${median(values)}`);
  if (!close(stored.p95, percentile(values, 95))) problems.push(`stored p95 ${stored.p95} is not the samples' ${percentile(values, 95)}`);
  if (baseline.discarded?.length < 2) problems.push('the discarded starts (after the build, on an empty folder) are not recorded');
  return `${samples.length} warm starts, ${samples.length - notVisible.length} visible; interactive median ${stored.median} ms, p95 ${stored.p95} ms`;
});

await check('a number exists for every metric the ticket lists', (problems) => {
  if (!baseline) return void problems.push(`${BASELINE} is missing`);
  let count = 0;
  for (const metric of METRICS) {
    for (const path of metric.paths) {
      count += 1;
      if (!isNum(at(baseline, path))) problems.push(`${metric.id}: ${path} is ${JSON.stringify(at(baseline, path))}`);
    }
  }
  for (const session of ['warmFolder', 'largeDb']) {
    for (const state of ['visible', 'hidden']) {
      const s = at(baseline, `idle.${session}.session.${state}`);
      if (!s) {
        problems.push(`idle.${session}.session.${state} is missing`);
        continue;
      }
      if (s.memory.length < 3) problems.push(`${session} ${state}: ${s.memory.length} memory samples`);
      if (s.windows.length < 1) problems.push(`${session} ${state}: no CPU window`);
      const total = s.windows.map((w) => w.total.cdpPctOfCore);
      if (!close(median(total), at(baseline, `idle.${session}.summary.${state}.cpuPctOfCore.total.median`)))
        problems.push(`${session} ${state}: stored CPU median is not the windows' median`);
      const memory = s.memory.map((m) => m.total.privateWorkingSet);
      if (!close(median(memory), at(baseline, `idle.${session}.summary.${state}.memoryBytes.privateWorkingSet.median`)))
        problems.push(`${session} ${state}: stored private working set median is not the samples' median`);
      for (const w of s.windows) {
        const sum = Object.values(w.byType).reduce((a, t) => a + t.cdpCpuS, 0);
        if (Math.abs(sum - w.total.cdpCpuS) > 1e-3) problems.push(`${session} ${state}: a window's per-type CPU does not add up to its total`);
        if (!(w.wallS > 0)) problems.push(`${session} ${state}: a window of ${w.wallS} s`);
      }
    }
    if (at(baseline, `idle.${session}.session.hiddenToTrayLogged`) !== true) problems.push(`${session}: the hide to the tray was not logged`);
    if (at(baseline, `idle.${session}.session.hiddenAfter`) !== 'hidden') problems.push(`${session}: the page was not hidden at the end of the hidden windows`);
  }
  const ls = baseline.launchersStatus ?? {};
  if (!close(ls.repeatedCallsMs?.median, median(ls.repeatedSamples ?? []))) problems.push('launchers:status repeated median does not match its samples');
  if (!close(ls.firstCallPerStartMs?.median, median(ls.firstCallSamples ?? []))) problems.push('launchers:status first-call median does not match its samples');
  if (existsSync(PACKAGED_DIR)) {
    const now = folderSize(PACKAGED_DIR);
    if (now.bytes !== baseline.install?.unpacked?.bytes || now.files !== baseline.install?.unpacked?.files)
      problems.push(
        `dist/win-unpacked now holds ${now.files} files, ${now.bytes} bytes; the baseline says ${baseline.install?.unpacked?.files}, ${baseline.install?.unpacked?.bytes}`,
      );
  }
  const installer = join(repoRoot, baseline.install?.installer?.file ?? 'missing');
  if (existsSync(installer)) {
    const bytes = readFileSync(installer);
    if (bytes.length !== baseline.install.installer.bytes) problems.push('the installer size is not the file’s');
    if (`sha256-${createHash('sha256').update(bytes).digest('base64')}` !== baseline.install.installer.digest)
      problems.push('the installer digest is not the file’s');
  }
  return `${count} values over ${METRICS.length} metrics`;
});

await check('METHOD.md names every metric in baseline.json and gives a command for each', (problems) => {
  if (!existsSync(METHOD)) return void problems.push(`${METHOD} is missing`);
  const text = readFileSync(METHOD, 'utf8');
  const sections = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^## Metric: `([^`]+)`/.exec(line);
    if (m) {
      current = m[1];
      sections.set(current, []);
    } else if (/^## /.test(line)) current = null;
    else if (current) sections.get(current).push(line);
  }
  for (const metric of METRICS) {
    const body = sections.get(metric.id);
    if (!body) {
      problems.push(`no "## Metric: \`${metric.id}\`" section`);
      continue;
    }
    const joined = body.join('\n');
    if (!/```(?:powershell|text)?\n[^`]*\S[^`]*```/.test(joined)) problems.push(`${metric.id}: no command block`);
    if (!/Rust/.test(joined)) problems.push(`${metric.id}: says nothing about the Rust build`);
    for (const path of metric.paths) {
      const field = path.split('.').slice(0, -1).join('.');
      if (!joined.includes(`\`${field}\``)) problems.push(`${metric.id}: does not name \`${field}\``);
    }
  }
  for (const id of sections.keys()) if (!METRICS.some((m) => m.id === id)) problems.push(`a section for ${id}, which is no metric of the ticket`);
  return `${sections.size} metric sections`;
});

await check('verify.mjs --allow-dirty has no finding under perf/ other than "not in the manifest"', async (problems) => {
  if (skipVerify) return 'skipped (--skip-verify)';
  const { verifyBundle } = await import('../verify.mjs');
  const result = verifyBundle({ out, allowDirty: true });
  let mine = 0;
  for (const item of result.checks) {
    for (const problem of item.problems) {
      if (!/(^|\s)perf\//.test(problem)) continue;
      mine += 1;
      if (!/: not in the manifest$/.test(problem)) problems.push(`${item.name}: ${problem}`);
    }
  }
  return `${mine} finding(s) under perf/, all "not in the manifest"`;
});

process.exit(results.every(Boolean) ? 0 : 1);
