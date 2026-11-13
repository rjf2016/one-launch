import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from '../lib/bundle.mjs';
import { pixelDiff } from '../ui/native/pixels.mjs';
import { maskVolatile } from '../ui/sidecar.mjs';

const SIDECAR = /^ui\/shots\/.+\.layout\.json$/;
const SCREEN_PNG = /^ui\/.+\.png$/;
const NOT_COMPARED = [
  [/^MANIFEST\.json$/, 'the hashes of the bundle it sits in'],
  [/^perf\//, 'measured timings, which do not repeat'],
];

export const PASSING = new Set(['identical', 'volatile', 'pixels', 'not compared']);

const short = (value) => {
  const text = JSON.stringify(value);
  if (text === undefined) return 'absent';
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
};

const isTree = (value) => value !== null && typeof value === 'object';

export function jsonDifferences(reference, candidate, limit = 5) {
  const first = [];
  let total = 0;
  const note = (at, a, b) => {
    total += 1;
    if (first.length < limit) first.push({ at: at || '/', reference: short(a), candidate: short(b) });
  };
  const walk = (a, b, at) => {
    if (a === b) return;
    if (!isTree(a) || !isTree(b) || Array.isArray(a) !== Array.isArray(b)) return note(at, a, b);
    if (Array.isArray(a)) {
      if (a.length !== b.length) note(`${at}/length`, a.length, b.length);
      for (let i = 0; i < Math.min(a.length, b.length); i += 1) walk(a[i], b[i], `${at}/${i}`);
      return;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    for (const key of new Set([...keysA, ...keysB])) {
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) note(`${at}/${key}`, a[key], b[key]);
      else walk(a[key], b[key], `${at}/${key}`);
    }
    if (keysA.length === keysB.length && keysA.some((key, i) => key !== keysB[i]) && keysA.every((key) => Object.hasOwn(b, key)))
      note(`${at}/(key order)`, keysA, keysB);
  };
  walk(reference, candidate, '');
  return { total, first };
}

function textDifference(reference, candidate) {
  const a = reference.toString('utf8').split('\n');
  const b = candidate.toString('utf8').split('\n');
  const line = a.findIndex((text, i) => text !== b[i]);
  const at = line === -1 ? a.length : line;
  return { total: 1, first: [{ at: `line ${at + 1}`, reference: short(a[at]), candidate: short(b[at]) }] };
}

export function compareFile(path, reference, candidate) {
  const skipped = NOT_COMPARED.find(([pattern]) => pattern.test(path));
  if (skipped) return { verdict: 'not compared', why: skipped[1] };
  if (reference.equals(candidate)) return { verdict: 'identical' };
  if (SCREEN_PNG.test(path)) {
    let diff = null;
    try {
      diff = pixelDiff(reference, candidate);
    } catch {
      diff = null;
    }
    return diff === null
      ? { verdict: 'different', total: 1, first: [{ at: 'size', reference: 'a PNG', candidate: 'a PNG of another size or kind' }] }
      : { verdict: 'pixels', pixels: diff.count, box: diff.box };
  }
  if (!path.endsWith('.json')) return { verdict: 'different', ...textDifference(reference, candidate) };
  let a;
  let b;
  try {
    a = JSON.parse(reference.toString('utf8'));
    b = JSON.parse(candidate.toString('utf8'));
  } catch {
    return { verdict: 'different', ...textDifference(reference, candidate) };
  }
  if (SIDECAR.test(path)) {
    const masked = jsonDifferences(maskVolatile(a), maskVolatile(b));
    if (masked.total === 0) return { verdict: 'volatile', hidden: jsonDifferences(a, b, 3) };
    return { verdict: 'different', ...masked };
  }
  const found = jsonDifferences(a, b);
  if (found.total === 0) return { verdict: 'different', total: 1, first: [{ at: '/', reference: 'the same JSON', candidate: 'in other bytes' }] };
  return { verdict: 'different', ...found };
}

export function compareTrees(reference, candidate, { skip = () => false } = {}) {
  const inReference = new Set(listFiles(reference));
  const results = [];
  for (const path of listFiles(candidate)) {
    if (skip(path)) continue;
    if (!inReference.has(path)) results.push({ path, verdict: 'extra' });
    else results.push({ path, ...compareFile(path, readFileSync(join(reference, path)), readFileSync(join(candidate, path))) });
  }
  const compared = new Set(results.map((result) => result.path));
  return { results, notProduced: [...inReference].filter((path) => !compared.has(path)).sort() };
}

export function tally(results) {
  const counts = {};
  for (const result of results) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  return counts;
}

export function describe(result) {
  if (result.verdict === 'pixels') return `${result.pixels} pixels differ${result.box ? ` within ${result.box.join(',')}` : ''}`;
  if (result.verdict === 'extra') return 'not in the bundle';
  if (!result.first) return '';
  const lines = result.first.map((item) => `${item.at}: ${item.reference} against ${item.candidate}`);
  if (result.total > result.first.length) lines.push(`and ${result.total - result.first.length} more`);
  return lines.join('\n');
}
