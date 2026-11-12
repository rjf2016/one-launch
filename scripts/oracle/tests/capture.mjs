import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORACLE_CLOCK } from '../lib/clock.mjs';
import { Aliases, normaliseRuns } from '../lib/normalise.mjs';
import { artefactPath, jsonText, resolveOut, writeArtefact } from '../lib/out.mjs';
import { duplicates, kindOf, testId, testKey, testsOf, waiverOf } from './catalogue.mjs';
import { UNENCODABLE } from './encode.mjs';
import { CONFIG, LIVE_ENV, PLAIN_CONFIG, RECORD_ENV, here, recordName, repoRoot, scratchRoot } from './paths.mjs';

export const RUNS = 3;
export const CATALOGUE = 'tests/catalogue.json';
export const GOLDENS = 'tests/goldens';
export const CAPTURE = 'tests/capture.json';
export const README = 'tests/README.md';
const README_SOURCE = join(here, 'bundle', 'README.md');

// inheritTemp runs exactly as check.mjs does, on the caller's TEMP; such a run must never record, as its paths are this machine's.
export function runSuite(dir, { config = CONFIG, record = true, inheritTemp = false } = {}) {
  if (inheritTemp && record) throw new Error('a run on the inherited TEMP records nothing');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const temp = inheritTemp ? null : join(dir, 'tmp');
  if (temp) mkdirSync(temp, { recursive: true });
  const report = join(dir, 'report.json');
  const env = temp ? { ...process.env, TEMP: temp, TMP: temp } : { ...process.env };
  delete env[LIVE_ENV];
  delete env[RECORD_ENV];
  if (record) env[RECORD_ENV] = join(dir, 'records');
  const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(process.execPath, [vitest, 'run', '--config', config, '--reporter=json', `--outputFile=${report}`], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!existsSync(report)) throw new Error(`vitest wrote no report (exit ${run.status}):\n${run.stderr.slice(-2000)}`);
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  const failed = parsed.testResults.flatMap((file) =>
    file.assertionResults.filter((item) => item.status === 'failed').map((item) => `${file.name.slice(repoRoot.length + 1)} › ${item.fullName}`),
  );
  const broken = parsed.testResults.filter((file) => file.status === 'failed' && file.assertionResults.every((item) => item.status !== 'failed'));
  if (run.status !== 0 || failed.length > 0 || broken.length > 0 || !parsed.success)
    throw new Error(
      `the suite is not green in ${dir} (exit ${run.status}); failed: ${[...failed, ...broken.map((file) => `${file.name} (${file.message})`)].join('; ') || 'none listed'}. Run the capture again on a quieter machine; never retry a test.`,
    );
  const records = new Map();
  if (record) {
    for (const name of readdirSync(join(dir, 'records'))) {
      const value = JSON.parse(readFileSync(join(dir, 'records', name), 'utf8'));
      if (recordName(value.file) !== name) throw new Error(`${name}: holds the record of ${value.file}`);
      records.set(value.file, value.calls);
    }
  }
  return { dir, temp, report: parsed, records };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A test's temporary folders are the direct children of TEMP its calls name; each becomes its own root, in the order the calls first name it.
export function tempRoots(value, temp) {
  const segments = temp.split(/[\\/]+/).filter(Boolean);
  const pattern = new RegExp(`(?<![A-Za-z0-9])${segments.map(escape).join('[\\\\/]+')}[\\\\/]+([A-Za-z0-9._-]+)`, 'gi');
  const children = [];
  const visit = (item) => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(pattern)) if (!children.some((child) => child.toLowerCase() === match[1].toLowerCase())) children.push(match[1]);
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item !== null && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  const roots = { temp };
  children.forEach((child, i) => {
    roots[`tmp${i === 0 ? '' : String.fromCharCode(65 + i)}`] = `${temp}\\${child}`;
  });
  return roots;
}

const ACCOUNT_METHODS = new Set(['preflight', 'switchAccount']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const namedIds = (call) => {
  const found = [];
  const [first, second] = call.args ?? [];
  if (ACCOUNT_METHODS.has(call.method) && isRecord(first) && typeof first.id === 'string') found.push({ kind: 'account', id: first.id, part: first.login });
  for (const item of [first, second, isRecord(second) ? second.game : undefined])
    if (isRecord(item) && typeof item.id === 'string' && typeof item.launcherGameId === 'string')
      found.push({ kind: 'game', id: item.id, part: item.launcherGameId });
  return found;
};

// An account or game id the services generated (a UUID) differs between runs; it becomes @acct:<launcher>:<login> or @game:<launcher>:<launcherGameId>.
export function idAliases(runs) {
  const perRun = runs.map(() => new Aliases());
  for (let i = 0; i < runs[0].length; i += 1) {
    const named = runs.map((calls) => namedIds(calls[i]));
    named[0].forEach((first, j) => {
      const ids = named.map((list) => list[j]);
      if (ids.some((item) => item?.kind !== first.kind) || ids.every((item) => item.id === first.id)) return;
      ids.forEach((item, r) => perRun[r][item.kind](item.id, runs[r][i].launcher, item.part));
    });
  }
  return perRun;
}

const callOf = ({ launcher, method, args, outcome, result, error }) => ({
  launcher,
  method,
  args,
  outcome,
  ...(outcome === 'returned' ? { result } : {}),
  ...(outcome === 'threw' ? { error } : {}),
});

export function build(runs, canonical) {
  const lists = runs.map((run) => testsOf(run.report));
  const dupes = duplicates(lists[0]);
  if (dupes.length > 0) throw new Error(`two tests share file, suite path and name, so their ids would collide: ${dupes.join('; ')}`);
  const total = runs[0].report.numTotalTests;
  for (const [r, list] of lists.entries()) {
    if (list.length !== runs[r].report.numTotalTests)
      throw new Error(`run ${r + 1}: ${list.length} tests listed, the reporter counts ${runs[r].report.numTotalTests}`);
    if (JSON.stringify(list) !== JSON.stringify(lists[0])) throw new Error(`run ${r + 1} lists other tests or statuses than run 1`);
  }
  const statuses = new Map(testsOf(canonical.report).map((test) => [testKey(test), test.status]));
  if (statuses.size !== total || lists[0].some((test) => !statuses.has(testKey(test))))
    throw new Error('the canonical run lists other tests than the capture runs');

  const byTest = runs.map((run) => {
    const calls = new Map();
    for (const [file, list] of run.records) {
      for (const call of list) {
        if (call.test === null) throw new Error(`${file}: a ${call.method} call outside any test`);
        const key = testKey({ file, suite: call.test.suite, name: call.test.name });
        if (!calls.has(key)) calls.set(key, []);
        calls.get(key).push(callOf(call));
      }
    }
    return calls;
  });

  const known = new Set(lists[0].map(testKey));
  for (const calls of byTest)
    for (const key of calls.keys()) if (!known.has(key)) throw new Error(`calls recorded for a test the reporter does not list: ${key}`);
  const recordedFiles = new Set(runs[0].records.keys());
  const missing = [...new Set(lists[0].filter((test) => test.status === 'passed').map((test) => test.file))].filter((file) => !recordedFiles.has(file));
  if (missing.length > 0) throw new Error(`the recorder did not run in: ${missing.join(', ')}`);

  const entries = [];
  const goldens = new Map();
  const fields = new Map();
  for (const test of lists[0]) {
    const id = testId(test);
    const kind = kindOf(test);
    const key = testKey(test);
    const recorded = byTest.map((calls) => calls.get(key) ?? []);
    if (recorded.some((calls) => JSON.stringify(calls).includes(`"${UNENCODABLE}"`)))
      throw new Error(`${id}: a value the encoder could not carry; see ${UNENCODABLE} in the run's records`);
    let golden = null;
    if (kind === 'adapter-flow' || recorded.some((calls) => calls.length > 0)) {
      golden = `${GOLDENS}/${id}.json`;
      const aliases = idAliases(recorded);
      const value = (calls) => ({ id, file: test.file, suite: test.suite, name: test.name, calls });
      const result = normaliseRuns(recorded.map((calls, r) => ({ value: value(calls), roots: tempRoots(calls, runs[r].temp), aliases: aliases[r] })));
      if (!result.stable)
        throw new Error(
          `${id} (${test.file} › ${[...test.suite, test.name].join(' › ')}) does not repeat: structural ${JSON.stringify(result.structural)}, unexplained ${JSON.stringify(result.unexplained)}`,
        );
      goldens.set(golden, result.value);
      for (const field of result.fields) {
        const name = `${field.rule}\u0000${field.path}`;
        if (!fields.has(name)) fields.set(name, { rule: field.rule, path: field.path, goldens: 0 });
        fields.get(name).goldens += 1;
      }
    }
    entries.push({
      id,
      file: test.file,
      suite: test.suite,
      name: test.name,
      environment: test.environment,
      kind,
      status: statuses.get(key),
      golden,
      waiver: waiverOf(test),
    });
  }
  if (entries.length !== total) throw new Error(`${entries.length} entries for ${total} tests`);
  const record = {
    clock: ORACLE_CLOCK,
    runs: runs.length,
    rules: [...fields.values()].sort((a, b) => (a.rule === b.rule ? (a.path < b.path ? -1 : 1) : a.rule < b.rule ? -1 : 1)),
  };
  return { catalogue: { entries }, goldens, capture: record, total };
}

export const runCanonical = (dir) => runSuite(dir, { config: PLAIN_CONFIG, record: false, inheritTemp: true });

export function captureRuns({ dir, runs = RUNS, log = () => {} }) {
  const recorded = [];
  for (let r = 1; r <= runs; r += 1) {
    log(`run ${r} of ${runs}`);
    recorded.push(runSuite(join(dir, `run-${r}`)));
  }
  log('canonical run: no shim, TEMP as inherited, as check.mjs runs it');
  const canonical = runCanonical(join(dir, 'canonical'));
  return { runs: recorded, canonical, built: build(recorded, canonical) };
}

export function writeBundle(out, built) {
  const goldensDir = artefactPath(out, GOLDENS);
  rmSync(goldensDir, { recursive: true, force: true });
  writeArtefact(out, CATALOGUE, built.catalogue);
  for (const [path, value] of built.goldens) writeArtefact(out, path, value);
  writeArtefact(out, CAPTURE, built.capture);
  writeArtefact(out, README, readFileSync(README_SOURCE));
}

export const summarise = (built) => {
  const count = (pick) =>
    built.catalogue.entries.reduce((acc, entry) => {
      const key = pick(entry);
      if (key !== null) acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  const calls = {};
  for (const value of built.goldens.values())
    for (const call of value.calls) calls[`${call.method} ${call.outcome}`] = (calls[`${call.method} ${call.outcome}`] ?? 0) + 1;
  return {
    total: built.total,
    kind: count((entry) => entry.kind),
    environment: count((entry) => entry.environment),
    status: count((entry) => entry.status),
    goldens: built.goldens.size,
    goldensByKind: count((entry) => (entry.golden ? entry.kind : null)),
    emptyGoldens: [...built.goldens.values()].filter((value) => value.calls.length === 0).length,
    calls,
    waivers: count((entry) => entry.waiver?.category ?? null),
  };
};

function main(argv) {
  const out = resolveOut(argv);
  const runs = Number(argv.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ?? RUNS);
  if (!Number.isInteger(runs) || runs < 2) throw new Error('--runs takes a whole number, two at least');
  const dir = join(scratchRoot(), 'capture');
  console.log(`Capturing the test catalogue and result goldens: ${runs} runs in ${dir}, into ${out}`);
  const { built } = captureRuns({ dir, runs, log: (line) => console.log(`  ${line}`) });
  writeBundle(out, built);
  console.log(jsonText(summarise(built)));
  rmSync(dir, { recursive: true, force: true });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
