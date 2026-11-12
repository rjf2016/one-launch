import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { join } from 'node:path';
import { afterAll, expect } from 'vitest';

const DIR = process.env.ORACLE_L1_COVERAGE_DIR;
const SRC = process.env.ORACLE_L1_COVERAGE_SRC;
const STATE = Symbol.for('one-launch.l1-coverage');

function post(session, method, params = {}) {
  let out;
  let failure;
  session.post(method, params, (error, result) => {
    failure = error;
    out = result;
  });
  if (failure) throw failure;
  return out;
}

const normal = (url) =>
  decodeURIComponent(url.replace(/^file:\/\/\//, ''))
    .replace(/\\/g, '/')
    .toLowerCase();

function start() {
  const session = new Session();
  session.connect();
  const scripts = new Map();
  session.on('Debugger.scriptParsed', ({ params }) => {
    if (normal(params.url).startsWith(SRC)) scripts.set(params.scriptId, params.url);
  });
  post(session, 'Profiler.enable');
  post(session, 'Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  post(session, 'Debugger.enable');
  return { session, scripts, dumps: 0 };
}

if (DIR && SRC) {
  const state = (globalThis[STATE] ??= start());
  afterAll(() => {
    const { session, scripts } = state;
    const { result } = post(session, 'Profiler.takePreciseCoverage');
    const out = [];
    for (const entry of result) {
      if (!scripts.has(entry.scriptId)) continue;
      const { scriptSource } = post(session, 'Debugger.getScriptSource', { scriptId: entry.scriptId });
      out.push({ url: entry.url, source: scriptSource, functions: entry.functions });
    }
    const file = expect.getState().testPath ?? 'unknown';
    state.dumps += 1;
    const name = createHash('sha256').update(`${file}\n${process.pid}\n${state.dumps}`).digest('hex').slice(0, 16);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${name}.json`), JSON.stringify({ test: file, scripts: out }));
  });
}
