import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './out.mjs';

export const MANIFEST = 'MANIFEST.json';
export const PIN = 'PIN';
export const TOOLING_BRANCH = 'oracle-tooling';
export const SCHEMA_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

const RULES = [
  ['manifest', /^MANIFEST\.json$/],
  ['vector', /^l1\/.+\.json$/],
  ['catalogue', /^tests\/catalogue\.json$/],
  ['replay-script', /^l2\/scripts\/[^/]+\.json$/],
  ['replay-expectation', /^l2\/expected\/[^/]+\.json$/],
  ['layout-sidecar', /^ui\/.+\.layout\.json$/],
  ['triage-linkage', /^triage-linkage\.json$/],
];

export const SCHEMA_NAMES = RULES.map(([name]) => name);
export const schemaFile = (name) => `${name}.schema.json`;
export const schemaFor = (path) => RULES.find(([, pattern]) => pattern.test(path))?.[0] ?? null;

export function listFiles(dir) {
  const walk = (at, prefix) =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walk(join(at, entry.name), rel) : [rel];
    });
  return walk(dir, '').sort();
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function readPin(out) {
  const pin = {};
  for (const line of readFileSync(join(out, PIN), 'utf8').split(/\r?\n/)) {
    const match = /^(\w+)\s*=\s*(.*)$/.exec(line.trim());
    if (match) pin[match[1]] = match[2];
  }
  for (const key of ['repo', 'commit', 'version']) if (!pin[key]) throw new Error(`${PIN} has no ${key}`);
  return { repo: pin.repo, commit: pin.commit, version: pin.version };
}

export function toolingState() {
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { branch: git('rev-parse', '--abbrev-ref', 'HEAD'), commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '' };
}

export function buildManifest(out, tooling) {
  const files = {};
  for (const path of listFiles(out)) if (path !== MANIFEST) files[path] = sha256(readFileSync(join(out, path)));
  return { pin: readPin(out), tooling, files };
}
