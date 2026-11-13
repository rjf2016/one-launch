// Captures every layer again from this checkout into a fresh folder and compares it with the bundle.
//   node scripts/oracle/gate/self-diff.mjs [--layers=<name>,<name>] [--compare-only] [--no-build] [--fresh <folder>] [--out <bundle>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { jsonText, resolveOut } from '../lib/out.mjs';
import { PASSING, compareTrees, describe, tally } from './compare.mjs';
import { LAYERS, NOT_CAPTURED, SEEDS, layerOf } from './layers.mjs';
import { buildApp, gateScratch, headOf, isUntouchedSeed, option, runOnBundleInputs, runStep, seed } from './run.mjs';

const MAX_LISTED = 12;

function capture({ bundle, fresh, scratch, layers, state, build }) {
  let built = !build;
  seed(bundle, fresh, SEEDS, state.seeds);
  for (const layer of layers) {
    seed(bundle, fresh, layer.seeds ?? [], state.seeds);
    state.layers[layer.name] = { complete: false, steps: [] };
    for (const [i, step] of layer.steps.entries()) {
      if (step.app && !built) {
        const made = buildApp({ logFile: join(scratch, 'logs', 'self-diff-build.log') });
        console.log(`${made.exit === 0 ? 'RAN   ' : 'FAILED'}  build of the unpackaged app  ${made.seconds} s`);
        if (made.exit !== 0) throw new Error(`the build failed; see ${made.log}`);
        built = true;
      }
      const logFile = join(scratch, 'logs', `self-diff-${layer.name}-${i + 1}.log`);
      const done = step.from
        ? runOnBundleInputs({ bundle, out: fresh, side: join(scratch, 'fresh-on-bundle'), covers: layer.covers, step, logFile })
        : runStep({ bundle, out: fresh, step, logFile });
      state.layers[layer.name].steps.push({ label: step.label, ...done });
      console.log(
        `${done.exit === 0 ? 'RAN   ' : 'FAILED'}  ${layer.name}: ${step.label}  ${done.seconds} s${done.exit === 0 ? '' : `  (exit ${done.exit}, see ${done.log})`}`,
      );
      if (done.exit !== 0) break;
    }
    const steps = state.layers[layer.name].steps;
    state.layers[layer.name].complete = steps.length === layer.steps.length && steps.every((step) => step.exit === 0);
  }
}

function judge({ bundle, fresh, state }) {
  const { results, notProduced } = compareTrees(bundle, fresh, { skip: isUntouchedSeed(fresh, state.seeds) });
  const report = [];
  for (const layer of LAYERS) {
    const ran = state.layers[layer.name];
    if (!ran) continue;
    const mine = results.filter((result) => layerOf(result.path) === layer.name);
    const absent = notProduced.filter((path) => layerOf(path) === layer.name);
    const explained = {};
    const missing = [];
    for (const path of absent) {
      const why = NOT_CAPTURED.find(([pattern]) => pattern.test(path))?.[1];
      if (why) explained[why] = (explained[why] ?? 0) + 1;
      else missing.push(path);
    }
    const failing = [
      ...ran.steps
        .filter((step) => step.exit !== 0)
        .map((step) => ({ path: step.label, text: `the capture step failed (exit ${step.exit}); see ${step.log}` })),
      ...(ran.complete ? [] : ran.steps.every((step) => step.exit === 0) ? [{ path: layer.name, text: 'not every step of the layer has run' }] : []),
      ...mine.filter((result) => !PASSING.has(result.verdict)).map((result) => ({ path: result.path, text: describe(result) })),
      ...(ran.complete ? missing.map((path) => ({ path, text: 'in the bundle, and the capture did not write it' })) : []),
    ];
    const pixels = mine.filter((result) => result.verdict === 'pixels');
    report.push({
      layer: layer.name,
      ok: failing.length === 0,
      files: mine.length,
      counts: tally(mine),
      pixels: {
        files: pixels.length,
        samePixels: pixels.filter((result) => result.pixels === 0).length,
        most: Math.max(0, ...pixels.map((result) => result.pixels)),
      },
      notCapturedAgain: explained,
      seconds: ran.steps.reduce((sum, step) => sum + step.seconds, 0),
      failing,
      volatile: mine.filter((result) => result.verdict === 'volatile').map((result) => ({ path: result.path, hidden: result.hidden })),
      pixelDifferences: pixels.filter((result) => result.pixels > 0).map(({ path, pixels: count, box }) => ({ path, pixels: count, box })),
    });
  }
  return report;
}

function print(report) {
  for (const item of report) {
    const parts = Object.entries(item.counts).map(([verdict, count]) => `${count} ${verdict}`);
    const absent = Object.entries(item.notCapturedAgain).map(([why, count]) => `${count} ${why}`);
    console.log(
      `${item.ok ? 'PASS' : 'FAIL'}  ${item.layer}: ${item.files} files captured again${parts.length ? `: ${parts.join(', ')}` : ''}${absent.length ? `; not captured again: ${absent.join(', ')}` : ''}`,
    );
    if (item.pixels.files > 0)
      console.log(`      of the PNGs that are other bytes, ${item.pixels.samePixels} hold the same pixels; the most that differ in one is ${item.pixels.most}`);
    for (const failure of item.failing.slice(0, MAX_LISTED)) console.log(`      ${failure.path}\n        ${failure.text.split('\n').join('\n        ')}`);
    if (item.failing.length > MAX_LISTED) console.log(`      and ${item.failing.length - MAX_LISTED} more`);
  }
}

function main(argv) {
  const bundle = resolveOut(argv);
  const scratch = gateScratch();
  const fresh = resolve(option(argv, 'fresh') ?? join(scratch, 'fresh'));
  const stateFile = join(scratch, 'self-diff-state.json');
  const state = existsSync(stateFile) && existsSync(fresh) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { seeds: {}, layers: {} };
  const named = option(argv, 'layers')?.split(',');
  const unknown = (named ?? []).filter((name) => !LAYERS.some((layer) => layer.name === name));
  if (unknown.length > 0) throw new Error(`no layer named ${unknown.join(', ')}; the layers are ${LAYERS.map((layer) => layer.name).join(', ')}`);
  const layers = LAYERS.filter((layer) => !named || named.includes(layer.name));
  console.log(`Self-diff of ${headOf().slice(0, 7)} against ${bundle}\nFresh capture: ${fresh}`);
  if (!argv.includes('--compare-only')) {
    try {
      capture({ bundle, fresh, scratch, layers, state, build: !argv.includes('--no-build') });
    } finally {
      writeFileSync(stateFile, jsonText(state));
    }
  }
  const report = judge({ bundle, fresh, state });
  writeFileSync(join(scratch, 'self-diff-report.json'), jsonText({ tooling: headOf(), bundle, layers: report }));
  print(report);
  const waiting = LAYERS.filter((layer) => !state.layers[layer.name]).map((layer) => layer.name);
  if (waiting.length > 0) console.log(`Not captured yet: ${waiting.join(', ')}`);
  const ok = report.every((item) => item.ok) && waiting.length === 0;
  console.log(ok ? '\nself-diff is zero on every layer.' : '\nself-diff is NOT zero.');
  return ok ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`self-diff could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
