import { createHash } from 'node:crypto';
import { createNormaliser, measureVolatile, normaliseRuns } from '../lib/normalise.mjs';
import { jsonText } from '../lib/out.mjs';

export const ENGINE_HEADERS = new Set(['accept', 'authorization', 'cache-control', 'if-none-match', 'range', 'user-agent', 'x-user-staging-id']);
const NO_CACHE_VALUE = /noCache=[0-9a-v]+/g;
export const NO_CACHE = '<t32>';

const clone = (value) => JSON.parse(JSON.stringify(value));
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function mapStrings(value, fn, path = '') {
  if (typeof value === 'string') return fn(value, path);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn, `${path}/*`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, `${path}/${k}`)]));
  return value;
}

function splitHeaders(value) {
  for (const step of value.steps) {
    step.requests = step.requests.map((req) => {
      const engine = {};
      const transport = {};
      for (const [name, v] of Object.entries(req.headers)) (ENGINE_HEADERS.has(name) ? engine : transport)[name] = v;
      return { method: req.method, path: req.path, query: req.query, headers: engine, transport, answer: req.answer };
    });
  }
}

// Each rule records the paths it changed and in how many recordings, so the report says what it touched.
class Rules {
  constructor() {
    this.touched = new Map();
  }

  note(rule, path) {
    const key = `${rule}\u0000${path}`;
    const entry = this.touched.get(key) ?? { rule, path, runs: 0 };
    entry.runs += 1;
    this.touched.set(key, entry);
  }

  list() {
    return [...this.touched.values()].sort((a, b) => (a.rule === b.rule ? (a.path < b.path ? -1 : 1) : a.rule < b.rule ? -1 : 1));
  }
}

export function prepare(runs) {
  const rules = new Rules();
  const prepared = runs.map((run) => {
    const value = clone(run.value);
    splitHeaders(value);
    const port = String(run.port);
    const portPattern = new RegExp(`127\\.0\\.0\\.1:${port}(?!\\d)`, 'g');
    const seen = new Set();
    const ported = mapStrings(value, (text, path) => {
      const out = text.replace(portPattern, '127.0.0.1:{port}');
      if (out !== text && !seen.has(path)) {
        seen.add(path);
        rules.note('port', path);
      }
      return out;
    });
    let dropped = 0;
    for (const step of ported.steps) {
      const before = step.states.length;
      step.states = step.states.filter((s) => !(s.state === 'downloading' && s.percent === 100));
      dropped += before - step.states.length;
      if (before !== step.states.length) rules.note('transient', `/steps/${step.step}/states`);
    }
    return { ...run, value: ported, transientDropped: dropped };
  });

  const { volatile } = measureVolatile(prepared.map((r) => r.value));
  const volatilePaths = new Set(volatile);
  for (const run of prepared) {
    const seen = new Set();
    run.value = mapStrings(run.value, (text, path) => {
      if (!volatilePaths.has(path.replace(/\/\d+(?=\/|$)/g, '/*'))) return text;
      const out = path.endsWith('/query/noCache') ? NO_CACHE : text.replace(NO_CACHE_VALUE, `noCache=${NO_CACHE}`);
      if (out !== text && !seen.has(path)) {
        seen.add(path);
        rules.note('noCache', path);
      }
      return out;
    });
  }
  return { prepared, rules };
}

export function stabilise(runs) {
  const { prepared, rules } = prepare(runs);
  const result = normaliseRuns(prepared.map(({ value, roots }) => ({ value, roots })));
  const perRun = prepared.map(({ value, roots }) => createNormaliser({ roots, volatile: result.volatile }).normalise(value));
  const same = perRun.every((v) => jsonText(v) === jsonText(result.value));
  const pathRules = rules.list().map(({ rule, path, runs: n }) => ({ rule, path: path.replace(/\/\d+(?=\/|$)/g, '/*'), runs: n }));
  const merged = new Map();
  for (const r of pathRules) {
    const key = `${r.rule}\u0000${r.path}`;
    const known = merged.get(key);
    if (known) known.runs = Math.max(known.runs, r.runs);
    else merged.set(key, { ...r });
  }
  return {
    value: result.value,
    stable: result.stable && same,
    perRun,
    rules: [...merged.values(), ...result.fields.map((f) => ({ rule: f.rule, path: f.path }))],
    volatile: result.volatile,
    unexplained: result.unexplained,
    structural: result.structural,
    transientDropped: prepared.map((r) => r.transientDropped),
  };
}
