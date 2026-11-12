import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listFiles, sha256 } from '../lib/bundle.mjs';
import { compileSchema, formatError } from '../lib/json-schema.mjs';
import { OUT_ENV, repoRoot, resolveOut } from '../lib/out.mjs';
import { AREAS, parseHeader, parseOrigin } from './lib/grammar.mjs';
import { TARGETS } from './targets.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MAX_LISTED = 40;
const schema = compileSchema(JSON.parse(readFileSync(join(repoRoot, 'scripts', 'oracle', 'schemas', 'vector.schema.json'), 'utf8')));

const option = (argv, name) => {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWrapped = (value, key) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key);
const isBytes = (value) => isWrapped(value, '$bytes') || isWrapped(value, '$file');

function areaFiles(root, area) {
  const dir = join(root, 'l1', area);
  return existsSync(dir) ? listFiles(dir).map((path) => `l1/${area}/${path}`) : [];
}

const vectorPaths = (root, area) => areaFiles(root, area).filter((path) => path.endsWith('.json'));

async function loadMapping(area) {
  const file = join(HERE, area, 'targets.mjs');
  if (!existsSync(file)) return { missing: true };
  const module = await import(pathToFileURL(file).href);
  return { missing: false, mapping: module.default, design: module.DESIGN };
}

function exportFound(sourceText, name) {
  const [owner, member] = name.split('.');
  const n = escapeRegex(owner);
  const patterns = [
    new RegExp(`^\\s*export\\s+(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\b`, 'm'),
    new RegExp(`^\\s*export\\s+(?:declare\\s+)?(?:const|let|var)\\s+${n}\\b`, 'm'),
    new RegExp(`^\\s*export\\s+(?:declare\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`, 'm'),
    new RegExp(`^\\s*export\\s+(?:declare\\s+)?(?:const\\s+)?enum\\s+${n}\\b`, 'm'),
    new RegExp(`^\\s*export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`, 'm'),
  ];
  if (!patterns.some((pattern) => pattern.test(sourceText))) return false;
  return member === undefined || new RegExp(`\\b${escapeRegex(member)}\\s*(?:<[^>\\n]*>)?\\s*(?:\\(|=)`).test(sourceText);
}

function readVector(bundle, path, problems) {
  const at = join(bundle, path);
  if (!existsSync(at)) {
    problems.push(`${path} is not in the bundle`);
    return null;
  }
  let value;
  try {
    value = JSON.parse(readFileSync(at, 'utf8'));
  } catch (error) {
    problems.push(`${path}: ${error.message}`);
    return null;
  }
  const errors = schema(value);
  if (errors.length > 0) {
    for (const error of errors.slice(0, 3)) problems.push(`${path}: ${formatError(error)}`);
    return null;
  }
  return value;
}

function checkHeader(path, value, problems) {
  let header;
  try {
    header = parseHeader(value.note);
  } catch (error) {
    problems.push(`${path}: ${error.message}`);
    return;
  }
  for (const item of value.cases) {
    item.args.forEach((arg, i) => {
      const declared = Object.hasOwn(header.decode, String(i));
      if (declared && !isBytes(arg)) problems.push(`${path}: ${item.id} arg${i} is declared ${header.decode[i]} but is not $bytes or $file`);
      if (!declared && isBytes(arg)) problems.push(`${path}: ${item.id} arg${i} is bytes with no decode on the note's first line`);
    });
  }
}

async function checkTargets(area, bundle, problems) {
  const loaded = await loadMapping(area);
  if (loaded.missing) {
    problems.push(`${area}: missing, no scripts/oracle/l1/${area}/targets.mjs yet`);
    return;
  }
  const design = area === 'example' ? loaded.design : TARGETS[area];
  const mapping = loaded.mapping;
  if (!Array.isArray(mapping)) {
    problems.push(`${area}: targets.mjs has no default export array`);
    return;
  }
  const items = new Set(design.map((entry) => entry.item));
  const mapped = new Map();
  const vectors = new Map();
  for (const [i, entry] of mapping.entries()) {
    const where = `${area}/targets.mjs[${i}]`;
    if (typeof entry?.item !== 'string' || !Array.isArray(entry.exports) || entry.exports.length === 0) {
      problems.push(`${where}: needs item (a string) and exports (a non-empty array)`);
      continue;
    }
    if (!items.has(entry.item)) problems.push(`${where}: "${entry.item}" is not an item of the ${area} targets`);
    if (mapped.has(entry.item)) problems.push(`${where}: "${entry.item}" is mapped twice`);
    mapped.set(entry.item, entry);
    for (const target of entry.exports) {
      const { export: name, source, vector } = target ?? {};
      if (typeof name !== 'string' || typeof source !== 'string' || typeof vector !== 'string') {
        problems.push(`${where}: each export needs export, source and vector strings`);
        continue;
      }
      const label = `${area}: "${entry.item}" → ${name}`;
      const sourceFile = join(repoRoot, ...source.split('/'));
      if (!/^src\/.+\.tsx?$/.test(source) || !existsSync(sourceFile)) problems.push(`${label}: no source module ${source}`);
      else if (!exportFound(readFileSync(sourceFile, 'utf8'), name)) problems.push(`${label}: ${source} does not export it`);
      if (!new RegExp(`^l1/${area}/[^/]+\\.json$`).test(vector)) {
        problems.push(`${label}: vector ${vector} is not l1/${area}/<name>.json`);
        continue;
      }
      const owner = `${name} ${source}`;
      if (vectors.has(vector) && vectors.get(vector) !== owner) problems.push(`${label}: ${vector} is also mapped to ${vectors.get(vector)}`);
      vectors.set(vector, owner);
      const value = readVector(bundle, vector, problems);
      if (!value) continue;
      if (value.function !== name) problems.push(`${label}: ${vector} says function ${value.function}`);
      if (value.source !== source) problems.push(`${label}: ${vector} says source ${value.source}`);
      if (value.cases.length === 0) problems.push(`${label}: ${vector} has no case`);
      checkHeader(vector, value, problems);
    }
  }
  for (const item of items) if (!mapped.has(item)) problems.push(`${area}: "${item}" is not mapped`);
  return { items: items.size, vectors: vectors.size, unmapped: vectorPaths(bundle, area).filter((path) => !vectors.has(path)) };
}

function generatorsOf(area) {
  const suffix = area === 'example' ? '.dev.ts' : '.gen.ts';
  const dir = join(HERE, area);
  if (!existsSync(dir)) return { include: null, count: 0 };
  const count = readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith(suffix)).length;
  return { include: `scripts/oracle/l1/${area}/**/*${suffix}`, count };
}

function runGenerators(include, out, bundle) {
  const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  return spawnSync(process.execPath, [vitest, 'run', '--config', 'scripts/oracle/vitest.config.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, [OUT_ENV]: out, ORACLE_GENERATOR: include, ORACLE_BUNDLE: bundle },
  });
}

function checkRepeat(area, bundle, scratch, problems) {
  const { include, count } = generatorsOf(area);
  if (count === 0) {
    problems.push(`${area}: missing, no generator under scripts/oracle/l1/${area}/`);
    return null;
  }
  const runs = ['a', 'b'].map((name) => join(scratch, area, name));
  for (const out of runs) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const run = runGenerators(include, out, bundle);
    if (run.status !== 0) {
      const tail = `${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-15);
      problems.push(`${area}: the generators failed (exit ${run.status}):`, ...tail.map((line) => `  ${line}`));
      return null;
    }
  }
  const [a, b] = runs;
  for (const path of listFiles(a)) if (!path.startsWith(`l1/${area}/`)) problems.push(`${area}: a generator wrote ${path}, outside l1/${area}/`);
  const lists = [areaFiles(a, area), areaFiles(b, area), areaFiles(bundle, area)];
  const all = [...new Set(lists.flat())].sort();
  for (const path of all) {
    const [inA, inB, inBundle] = lists.map((list) => list.includes(path));
    if (!inA || !inB) {
      problems.push(`${path}: written by ${inA ? 'the first run only' : inB ? 'the second run only' : 'neither run, only in the bundle'}`);
      continue;
    }
    const [hashA, hashB] = [a, b].map((root) => sha256(readFileSync(join(root, path))));
    if (hashA !== hashB) problems.push(`${path}: the two runs differ`);
    else if (!inBundle) problems.push(`${path}: not in the bundle`);
    else if (sha256(readFileSync(join(bundle, path))) !== hashA) problems.push(`${path}: the bundle's copy differs from a fresh run`);
  }
  return { generators: count, files: lists[0].length };
}

function titleFound(text, title) {
  const forms = [title, title.replace(/\\/g, '\\\\').replace(/'/g, "\\'"), title.replace(/\\/g, '\\\\').replace(/"/g, '\\"'), title.replace(/`/g, '\\`')];
  return forms.some((form) => text.includes(form));
}

function checkOrigins(area, bundle, problems) {
  const tests = new Map();
  let cases = 0;
  const paths = vectorPaths(bundle, area);
  for (const path of paths) {
    const value = readVector(bundle, path, problems);
    if (!value) continue;
    for (const item of value.cases) {
      cases += 1;
      const where = `${path}: ${item.id}`;
      let origin;
      try {
        origin = parseOrigin(item.origin);
      } catch (error) {
        problems.push(`${where}: ${item.origin.kind} origin: ${error.message}`);
        continue;
      }
      if (origin.kind === 'fixture') {
        if (!existsSync(join(bundle, origin.path)) && !existsSync(join(repoRoot, origin.path)))
          problems.push(`${where}: fixture ${origin.path} is in neither the bundle nor the Electron repo`);
      } else if (origin.kind === 'test') {
        if (!tests.has(origin.file)) {
          const file = join(repoRoot, origin.file);
          tests.set(origin.file, existsSync(file) ? readFileSync(file, 'utf8') : null);
        }
        const text = tests.get(origin.file);
        if (text === null) problems.push(`${where}: test file ${origin.file} does not exist`);
        else for (const title of origin.titles) if (!titleFound(text, title)) problems.push(`${where}: "${title}" is not in ${origin.file}`);
      }
    }
  }
  if (paths.length === 0) problems.push(`${area}: missing, no vector file in the bundle under l1/${area}/`);
  return { files: paths.length, cases };
}

async function main(argv) {
  const bundle = resolveOut(argv);
  const only = option(argv, 'area');
  if (only !== undefined && !AREAS.includes(only) && only !== 'example') {
    console.error(`--area is one of ${AREAS.join(', ')} (or example)`);
    return 2;
  }
  const areas = only ? [only] : AREAS;
  const given = option(argv, 'scratch');
  const scratch = given ? resolve(given) : mkdtempSync(join(tmpdir(), 'oracle-l1-check-'));
  console.log(`Oracle bundle: ${bundle}`);
  console.log(`Areas: ${areas.join(', ')}`);

  const checks = [
    [
      'every target has a vector',
      async (problems) => {
        const parts = [];
        for (const area of areas) {
          const result = await checkTargets(area, bundle, problems);
          if (!result) continue;
          parts.push(`${area} ${result.items} items, ${result.vectors} vector files`);
          for (const path of result.unmapped) parts.push(`${path} is in no targets.mjs (allowed)`);
        }
        return parts.join('; ');
      },
    ],
    [
      'two runs are byte-identical and match the bundle',
      async (problems) => {
        const parts = [];
        for (const area of areas) {
          const result = checkRepeat(area, bundle, scratch, problems);
          if (result) parts.push(`${area} ${result.generators} generators, ${result.files} files`);
        }
        return parts.join('; ');
      },
    ],
    [
      'every case names a real origin',
      async (problems) => {
        const parts = [];
        for (const area of areas) {
          const result = checkOrigins(area, bundle, problems);
          parts.push(`${area} ${result.cases} cases in ${result.files} files`);
        }
        return parts.join('; ');
      },
    ],
  ];

  let ok = true;
  for (const [name, run] of checks) {
    const problems = [];
    let summary = '';
    try {
      summary = await run(problems);
    } catch (error) {
      problems.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    ok &&= problems.length === 0;
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${name}${summary ? `: ${summary}` : ''}`);
    for (const problem of problems.slice(0, MAX_LISTED)) console.log(`      ${problem}`);
    if (problems.length > MAX_LISTED) console.log(`      and ${problems.length - MAX_LISTED} more`);
  }
  if (given || argv.includes('--keep')) console.log(`Runs kept in ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
  console.log(ok ? '\nl1 check passed.' : '\nl1 check FAILED.');
  return ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
