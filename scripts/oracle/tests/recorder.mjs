import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { UNENCODABLE, encode, encodeError } from './encode.mjs';
import { RECORD_ENV, recordName, repoRoot } from './paths.mjs';

export const METHODS = ['preflight', 'switchAccount', 'launchGame', 'restoreBackup'];
const WRAPPED = Symbol.for('one-launch.oracle-tests.wrapped');

const state = { file: null, current: null, calls: [] };

const suitePath = (task) => {
  const titles = [];
  for (let suite = task.suite; suite && suite !== task.file && suite.type === 'suite' && !('filepath' in suite); suite = suite.suite)
    titles.unshift(suite.name);
  return titles;
};

export function enter(task) {
  state.file ??= task.file?.filepath ?? null;
  state.current = { suite: suitePath(task), name: task.name };
}

export function leave() {
  state.current = null;
}

// A value the encoder refuses must not break the test; the capture refuses the record instead.
const safely = (fn, value) => {
  try {
    return fn(value);
  } catch (error) {
    return { [UNENCODABLE]: error instanceof Error ? error.message : String(error) };
  }
};

function begin(adapter, method, args) {
  const call = { test: state.current, launcher: typeof adapter?.id === 'string' ? adapter.id : null, method, args: safely(encode, args), outcome: 'pending' };
  state.calls.push(call);
  return call;
}

const returned = (call, value) => {
  call.outcome = 'returned';
  call.result = safely(encode, value);
};

const threw = (call, error) => {
  call.outcome = 'threw';
  call.error = safely(encodeError, error);
};

export function wrapAdapter(mod, className) {
  const proto = mod[className]?.prototype;
  if (!proto) throw new Error(`the module has no class ${className}`);
  for (const method of METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, method);
    const original = descriptor?.value;
    if (typeof original !== 'function' || original[WRAPPED]) continue;
    const wrapped = function (...args) {
      const call = begin(this, method, args);
      let out;
      try {
        out = original.apply(this, args);
      } catch (error) {
        threw(call, error);
        throw error;
      }
      // The caller keeps the very promise the adapter returned, so no await of theirs takes an extra tick.
      if (out !== null && typeof out === 'object' && typeof out.then === 'function')
        out.then(
          (value) => returned(call, value),
          (error) => threw(call, error),
        );
      else returned(call, out);
      return out;
    };
    Object.defineProperty(wrapped, 'name', { value: method });
    wrapped[WRAPPED] = true;
    Object.defineProperty(proto, method, { ...descriptor, value: wrapped });
  }
  return mod;
}

export function flush(fallbackFile) {
  const dir = process.env[RECORD_ENV];
  const file = state.file ?? fallbackFile ?? null;
  if (!dir || !file) return;
  const rel = relative(repoRoot, file).replace(/\\/g, '/');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, recordName(rel)), `${JSON.stringify({ file: rel, calls: state.calls }, null, 2)}\n`);
}
