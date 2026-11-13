import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { listFiles, sha256 } from '../lib/bundle.mjs';
import { repoRoot } from '../lib/out.mjs';

export const HOME = repoRoot;
export const SCRATCH_BASE = resolve(HOME, '..', 'oracle-scratch');

export function gateScratch() {
  const scratch = resolve(process.env.ORACLE_GATE_SCRATCH ?? join(SCRATCH_BASE, 't12'));
  mkdirSync(join(scratch, 'logs'), { recursive: true });
  return scratch;
}

export const option = (argv, name) => {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
};

export function seed(bundle, target, paths, seeds) {
  for (const path of paths) {
    const from = join(bundle, path);
    if (!existsSync(from) || existsSync(join(target, path))) continue;
    mkdirSync(dirname(join(target, path)), { recursive: true });
    cpSync(from, join(target, path), { recursive: true });
    const files = statSync(from).isDirectory() ? listFiles(from).map((name) => `${path}/${name}`) : [path];
    for (const file of files) seeds[file] = sha256(readFileSync(join(target, file)));
  }
}

export const isUntouchedSeed = (target, seeds) => (path) => Object.hasOwn(seeds, path) && sha256(readFileSync(join(target, path))) === seeds[path];

function logged(logFile, run) {
  mkdirSync(dirname(logFile), { recursive: true });
  const log = openSync(logFile, 'w');
  const started = Date.now();
  try {
    const done = run(['ignore', log, log]);
    return { exit: done.status ?? 1, seconds: Math.round((Date.now() - started) / 1000), log: logFile };
  } finally {
    closeSync(log);
  }
}

function stepEnv(bundle, step) {
  const env = { ...process.env, ...step.env };
  delete env.ORACLE_OUT;
  delete env.ORACLE_GENERATOR;
  env.ORACLE_BUNDLE = bundle;
  env.ORACLE_SCRATCH = step.scratch ? join(SCRATCH_BASE, step.scratch) : SCRATCH_BASE;
  env.T11_SCRATCH = join(SCRATCH_BASE, 't11');
  return env;
}

export function runStep({ repo = HOME, bundle, out, step, logFile }) {
  return logged(logFile, (stdio) =>
    spawnSync(process.execPath, [join(repo, step.script), ...(step.args ?? []), `--out=${out}`], { cwd: repo, env: stepEnv(bundle, step), stdio }),
  );
}

// A step whose output quotes its inputs runs on the bundle's copy of them, in a folder of its own beside the capture.
export function runOnBundleInputs({ repo = HOME, bundle, out, side, covers, step, logFile }) {
  const carry = (from, to) => {
    for (const path of existsSync(from) ? listFiles(from).filter((name) => covers.test(name)) : []) {
      mkdirSync(dirname(join(to, path)), { recursive: true });
      cpSync(join(from, path), join(to, path));
    }
  };
  rmSync(side, { recursive: true, force: true });
  seed(bundle, side, step.from, {});
  carry(out, side);
  const done = runStep({ repo, bundle, out: side, step, logFile });
  carry(side, out);
  rmSync(side, { recursive: true, force: true });
  return done;
}

export function buildApp({ repo = HOME, logFile }) {
  return logged(logFile, (stdio) => spawnSync('npx electron-vite build', { cwd: repo, stdio, shell: true }));
}

export const headOf = (repo = HOME) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
