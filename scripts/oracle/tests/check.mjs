import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_SOURCE } from '../lib/bundle.mjs';
import { compileSchema, formatError } from '../lib/json-schema.mjs';
import { jsonText, resolveOut } from '../lib/out.mjs';
import { pathPattern } from '../lib/path-pattern.mjs';
import { createUserPathScanner } from '../lib/user-paths.mjs';
import { verifyBundle } from '../verify.mjs';
import { CAPTURE, CATALOGUE, GOLDENS, RUNS, captureRuns, runSuite } from './capture.mjs';
import { testId, testKey, testsOf } from './catalogue.mjs';
import { PLAIN_CONFIG, scratchRoot } from './paths.mjs';

const MAX_LISTED = 12;
const ID = /^T-[0-9A-Za-z][0-9A-Za-z._-]*$/;

function main(argv) {
  const out = resolveOut(argv);
  const runs = Number(argv.find((arg) => arg.startsWith('--runs='))?.slice('--runs='.length) ?? RUNS);
  const scratch = join(scratchRoot(), 'check');
  const checks = [];
  const check = (name, run) => {
    const problems = [];
    let summary = '';
    try {
      summary = run(problems) ?? '';
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    checks.push({ name, ok: problems.length === 0, summary, problems });
  };

  const read = (rel) => (existsSync(join(out, rel)) ? readFileSync(join(out, rel)) : null);
  const catalogueBytes = read(CATALOGUE);
  if (catalogueBytes === null) {
    console.error(`${CATALOGUE} is missing from ${out}; run capture.mjs`);
    return 2;
  }
  const catalogue = JSON.parse(catalogueBytes.toString('utf8'));
  const entries = catalogue.entries ?? [];
  const goldenDir = join(out, GOLDENS);
  const goldenFiles = existsSync(goldenDir) ? readdirSync(goldenDir).map((name) => `${GOLDENS}/${name}`) : [];

  console.log(`Test catalogue checks: ${out}`);
  console.log(`  a fresh capture (${runs} runs with the shim) plus the canonical run, and one run without the shim on the scratch TEMP, in ${scratch}`);
  rmSync(scratch, { recursive: true, force: true });
  const fresh = captureRuns({ dir: join(scratch, 'capture'), runs, log: (line) => console.log(`  ${line}`) });
  console.log('  run without the shim');
  const plain = runSuite(join(scratch, 'plain'), { config: PLAIN_CONFIG, record: false });

  check("catalogue entry count equals the vitest JSON reporter's total, with it.each expanded", (problems) => {
    const validate = compileSchema(JSON.parse(readFileSync(join(SCHEMA_SOURCE, 'catalogue.schema.json'), 'utf8')));
    for (const error of validate(catalogue).slice(0, 5)) problems.push(`${CATALOGUE}: ${formatError(error)}`);
    const totals = [...fresh.runs.map((run) => run.report.numTotalTests), plain.report.numTotalTests, fresh.canonical.report.numTotalTests];
    for (const total of totals) if (total !== entries.length) problems.push(`${entries.length} entries, a run's reporter counts ${total}`);
    const listed = testsOf(fresh.runs[0].report);
    const keys = new Set(listed.map(testKey));
    const entryKeys = new Set(entries.map(testKey));
    for (const test of listed) if (!entryKeys.has(testKey(test))) problems.push(`not catalogued: ${test.file} › ${[...test.suite, test.name].join(' › ')}`);
    for (const entry of entries) if (!keys.has(testKey(entry))) problems.push(`${entry.id}: no such test in the run`);
    if (keys.size !== listed.length) problems.push(`the reporter lists ${listed.length} tests under ${keys.size} distinct names`);
    const files = new Set(entries.map((entry) => entry.file)).size;
    return `${entries.length} entries in ${files} files; reporter totals ${[...new Set(totals)].join(', ')} over ${totals.length} runs, each case of an it.each its own test`;
  });

  check('ids are unique and stable across two runs', (problems) => {
    const seen = new Set();
    for (const entry of entries) {
      if (!ID.test(entry.id)) problems.push(`${entry.id}: not of the form T-…`);
      if (seen.has(entry.id)) problems.push(`${entry.id}: used twice`);
      seen.add(entry.id);
      if (entry.id !== testId(entry)) problems.push(`${entry.id}: not the id its file, suite and name give (${testId(entry)})`);
    }
    const again = jsonText(fresh.built.catalogue);
    if (again !== catalogueBytes.toString('utf8')) {
      const before = new Map(entries.map((entry) => [entry.id, jsonText(entry)]));
      const after = fresh.built.catalogue.entries;
      for (const entry of after) if (before.get(entry.id) !== jsonText(entry)) problems.push(`${entry.id}: differs in the fresh capture`);
      for (const id of before.keys()) if (!after.some((entry) => entry.id === id)) problems.push(`${id}: gone from the fresh capture`);
      if (problems.length === 0) problems.push(`${CATALOGUE}: the fresh capture orders it differently`);
    }
    return `${seen.size} unique ids, each derived from file, suite path and name; the fresh capture's catalogue is byte-identical`;
  });

  check('every adapter-flow test has a result golden', (problems) => {
    const named = new Set();
    let flows = 0;
    let calls = 0;
    for (const entry of entries) {
      if (entry.golden !== null) named.add(entry.golden);
      if (entry.kind !== 'adapter-flow') continue;
      flows += 1;
      if (entry.golden === null) {
        problems.push(`${entry.id}: adapter-flow without a golden`);
        continue;
      }
      const bytes = read(entry.golden);
      if (bytes === null) {
        problems.push(`${entry.id}: ${entry.golden} is not in the bundle`);
        continue;
      }
      const golden = JSON.parse(bytes.toString('utf8'));
      for (const field of ['id', 'file', 'name']) if (golden[field] !== entry[field]) problems.push(`${entry.golden}: its ${field} is not the entry's`);
      if (JSON.stringify(golden.suite) !== JSON.stringify(entry.suite)) problems.push(`${entry.golden}: its suite is not the entry's`);
      const recorded =
        fresh.runs[0].records.get(entry.file)?.filter((call) => call.test && testKey({ file: entry.file, ...call.test }) === testKey(entry)) ?? [];
      if (!Array.isArray(golden.calls) || golden.calls.length !== recorded.length)
        problems.push(`${entry.golden}: ${golden.calls?.length} calls, the fresh run recorded ${recorded.length} for that test`);
      else if (
        golden.calls.some((call, i) => call.method !== recorded[i].method || call.launcher !== recorded[i].launcher || call.outcome !== recorded[i].outcome)
      )
        problems.push(`${entry.golden}: its calls are not the ones the fresh run recorded, in that order`);
      calls += recorded.length;
    }
    for (const file of goldenFiles) if (!named.has(file)) problems.push(`${file}: no catalogue entry names it`);
    return `${flows} adapter-flow tests, each with its golden (${calls} calls); ${named.size} goldens in all, ${goldenFiles.length} files`;
  });

  check('two capture runs give byte-identical goldens', (problems) => {
    const expected = new Map([...fresh.built.goldens].map(([path, value]) => [path, jsonText(value)]));
    for (const [path, text] of expected) {
      const bytes = read(path);
      if (bytes === null) problems.push(`${path}: in the fresh capture, not in the bundle`);
      else if (bytes.toString('utf8') !== text) problems.push(`${path}: differs from the fresh capture`);
    }
    for (const file of goldenFiles) if (!expected.has(file)) problems.push(`${file}: in the bundle, not in the fresh capture`);
    if (read(CAPTURE)?.toString('utf8') !== jsonText(fresh.built.capture)) problems.push(`${CAPTURE}: differs from the fresh capture's`);
    return `${expected.size} goldens and ${CAPTURE} identical byte for byte to a capture of ${runs} more runs`;
  });

  check("the catalogue's statuses are the canonical run's: check.mjs's config and clock, no shim, TEMP as inherited", (problems) => {
    const canonical = new Map(testsOf(fresh.canonical.report).map((test) => [testKey(test), test.status]));
    const scratchTemp = new Map(testsOf(plain.report).map((test) => [testKey(test), test.status]));
    const tally = {};
    for (const entry of entries) {
      tally[entry.status] = (tally[entry.status] ?? 0) + 1;
      if (canonical.get(testKey(entry)) !== entry.status)
        problems.push(`${entry.id}: ${entry.status} in the catalogue, ${canonical.get(testKey(entry))} in the canonical run`);
    }
    const report = fresh.canonical.report;
    if (report.numPassedTests !== (tally.passed ?? 0) || report.numPendingTests !== (tally.skipped ?? 0) || report.numTodoTests !== (tally.todo ?? 0))
      problems.push(
        `canonical ${report.numPassedTests} passed, ${report.numPendingTests} skipped, ${report.numTodoTests} todo; catalogue ${JSON.stringify(tally)}`,
      );
    const moved = entries.filter((entry) => canonical.get(testKey(entry)) !== scratchTemp.get(testKey(entry)));
    const note = moved.map((entry) => `${entry.id} (${scratchTemp.get(testKey(entry))} on the scratch TEMP)`).join(', ');
    return `canonical ${report.numPassedTests} passed, ${report.numPendingTests} skipped, ${report.numTodoTests} todo, equal to the catalogue's; ${moved.length} status${moved.length === 1 ? '' : 'es'} differ${moved.length === 1 ? 's' : ''} on the scratch TEMP${note ? `: ${note}` : ''}`;
  });

  check('the shim changes no outcome: same tests, passes and skips with and without it, both on the scratch TEMP', (problems) => {
    const strip = (list) => list.map((test) => `${testKey(test)} ${test.status}`);
    const withShim = strip(testsOf(fresh.runs[0].report));
    const without = strip(testsOf(plain.report));
    const missing = without.filter((line) => !withShim.includes(line));
    for (const line of missing.slice(0, 5)) problems.push(`without the shim only: ${line}`);
    if (withShim.length !== without.length) problems.push(`${withShim.length} tests with the shim, ${without.length} without`);
    const counts = (report) =>
      `${report.numPassedTests} passed, ${report.numPendingTests} skipped, ${report.numTodoTests} todo, ${report.numFailedTests} failed`;
    for (const run of fresh.runs)
      if (counts(run.report) !== counts(plain.report)) problems.push(`with the shim ${counts(run.report)}; without ${counts(plain.report)}`);
    return `${counts(plain.report)} in every run, with the shim and without`;
  });

  check('no file under tests/ names a scratch folder, this machine or its user', (problems) => {
    const scanner = createUserPathScanner();
    const scratchPattern = new RegExp(pathPattern(scratchRoot()), 'gi');
    let files = 0;
    for (const rel of [CATALOGUE, CAPTURE, ...goldenFiles]) {
      const text = read(rel)?.toString('utf8') ?? '';
      files += 1;
      for (const hit of scanner.scanText(text)) problems.push(`${rel}: ${hit.kind} ${hit.masked}`);
      if (scratchPattern.test(text)) problems.push(`${rel}: names the scratch folder`);
      scratchPattern.lastIndex = 0;
    }
    return `${files} files scanned`;
  });

  check('verify.mjs --allow-dirty finds nothing under tests/ but "not in the manifest"', (problems) => {
    const result = verifyBundle({ out, allowDirty: true });
    let unlisted = 0;
    for (const item of result.checks) {
      for (const problem of item.problems) {
        if (!problem.startsWith('tests/') && !problem.includes(' tests/')) continue;
        if (/^tests\/\S+: not in the manifest$/.test(problem)) unlisted += 1;
        else problems.push(`${item.name}: ${problem}`);
      }
    }
    return `${unlisted} files under tests/ not in the manifest yet, nothing else`;
  });

  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}: ${item.summary}`);
    for (const problem of item.problems.slice(0, MAX_LISTED)) console.log(`      ${problem}`);
    if (item.problems.length > MAX_LISTED) console.log(`      and ${item.problems.length - MAX_LISTED} more`);
  }
  const ok = checks.every((item) => item.ok);
  if (ok) rmSync(scratch, { recursive: true, force: true });
  console.log(ok ? '\nTest catalogue checks passed.' : `\nTest catalogue checks FAILED. The runs stay in ${scratch}.`);
  return ok ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`check could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
