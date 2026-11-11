import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_OUT = resolve(repoRoot, '..', 'one-launch-rs', 'oracle');
export const OUT_ENV = 'ORACLE_OUT';

export function parseOut(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = arg === '--out' ? argv[i + 1] : arg.startsWith('--out=') ? arg.slice('--out='.length) : null;
    if (value === null) continue;
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error('--out needs a folder');
    return value;
  }
  return null;
}

function isInside(parent, child) {
  const back = relative(parent, child);
  return back === '' || (!back.startsWith('..') && !isAbsolute(back));
}

export function resolveOut(argv = process.argv.slice(2), env = process.env) {
  const given = parseOut(argv) ?? env[OUT_ENV] ?? null;
  const out = given ? resolve(given) : DEFAULT_OUT;
  if (out === parse(out).root) throw new Error(`--out must not be a drive root: ${out}`);
  if (isInside(repoRoot, out)) throw new Error(`--out must be outside the Electron repo, which holds tooling only: ${out}`);
  return out;
}

export function artefactPath(out, rel) {
  const target = resolve(out, rel);
  if (target === out || !isInside(out, target)) throw new Error(`artefact path leaves the output folder: ${rel}`);
  return target;
}

export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function writeArtefact(out, rel, data) {
  const target = artefactPath(out, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof data === 'string' || data instanceof Uint8Array ? data : jsonText(data));
  return target;
}
