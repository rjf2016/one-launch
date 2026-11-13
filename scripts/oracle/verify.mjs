// Findings name the file and rule with the value masked; nothing here may print a whole match.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScanner, isExcluded, loadAllowlist, mask } from '../hooks/no-secrets.mjs';
import { MANIFEST, SCHEMA_NAMES, SCHEMA_SOURCE, listFiles, readPin, schemaFile, schemaFor, sha256 } from './lib/bundle.mjs';
import { compileSchema, formatError } from './lib/json-schema.mjs';
import { resolveOut } from './lib/out.mjs';
import { createUserPathScanner, machineIdentity, maskName } from './lib/user-paths.mjs';

export const BUNDLE_ALLOW = fileURLToPath(new URL('./bundle.allow', import.meta.url));
const MAX_LISTED = 20;
const DIGEST_KEY = /^sha256$|Sha256$/;
const NOREPLY = /@users\.noreply\.github\.com$/i;
const BATCH = 400;

export const fingerprint = (value) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);

function parseJson(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('starts with a byte order mark');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function visit(value, onValue, key = null) {
  onValue(value, key);
  if (Array.isArray(value)) for (const item of value) visit(item, onValue, key);
  else if (value !== null && typeof value === 'object') for (const [name, item] of Object.entries(value)) visit(item, onValue, name);
}

function repeated(values) {
  const seen = new Set();
  const twice = new Set();
  for (const value of values) (seen.has(value) ? twice : seen).add(value);
  return [...twice];
}

const SEMANTICS = {
  vector(path, value, bundle, problems) {
    for (const id of repeated(value.cases.map((item) => item.id))) problems.push(`${path}: case id ${id} is used twice`);
    visit(value.cases, (item) => {
      if (item === null || typeof item !== 'object' || typeof item.$file !== 'string') return;
      const digest = bundle.digests.get(item.$file);
      if (digest === undefined) problems.push(`${path}: $file ${item.$file} is not in the bundle`);
      else if (digest !== item.sha256) problems.push(`${path}: $file ${item.$file} has another sha256`);
    });
  },
  catalogue(path, value, bundle, problems) {
    for (const id of repeated(value.entries.map((entry) => entry.id))) problems.push(`${path}: id ${id} is used twice`);
    for (const entry of value.entries) {
      if (entry.golden !== null && !bundle.digests.has(entry.golden)) problems.push(`${path}: ${entry.id} names a golden that is not in the bundle`);
    }
  },
  'replay-script'(path, _value, bundle, problems) {
    const expected = path.replace(/^l2\/scripts\//, 'l2/expected/');
    if (!bundle.digests.has(expected)) problems.push(`${path}: no expectation at ${expected}`);
  },
  'replay-expectation'(path, value, bundle, problems) {
    const script = path.replace(/^l2\/expected\//, 'l2/scripts/');
    if (!bundle.digests.has(script)) problems.push(`${path}: no script at ${script}`);
    value.events.forEach((event, i) => {
      if (i > 0 && event.seq <= value.events[i - 1].seq) problems.push(`${path}: events/${i} seq does not rise`);
    });
  },
  'layout-sidecar'(path, _value, bundle, problems) {
    const shot = path.replace(/\.layout\.json$/, '.png');
    if (!bundle.digests.has(shot)) problems.push(`${path}: no shot at ${shot}`);
  },
  'triage-linkage'(path, value, bundle, problems) {
    for (const id of repeated(value.rows.map((row) => row.id))) problems.push(`${path}: row ${id} appears twice`);
    for (const row of value.rows) {
      for (const link of row.affects)
        if (!bundle.digests.has(link.artefact)) problems.push(`${path}: ${row.id} names ${link.artefact}, which is not in the bundle`);
    }
  },
};

export function verifyBundle({ out, allowDirty = false, identity = machineIdentity(), repoAllow = loadAllowlist(), bundleAllow = BUNDLE_ALLOW } = {}) {
  const checks = [];
  // A finding in a file name would otherwise be printed in full by every message that names the file.
  const hidden = new Set();
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

  const files = listFiles(out);
  const bytes = new Map(files.map((path) => [path, readFileSync(join(out, path))]));
  const bundle = { digests: new Map(files.map((path) => [path, sha256(bytes.get(path))])) };
  const validators = new Map();
  const parsed = new Map();

  check('schemas', (problems) => {
    const expected = new Set(SCHEMA_NAMES.map((name) => `schemas/${schemaFile(name)}`));
    for (const name of SCHEMA_NAMES) {
      const file = schemaFile(name);
      const source = readFileSync(join(SCHEMA_SOURCE, file));
      try {
        validators.set(name, compileSchema(parseJson(source)));
      } catch (error) {
        problems.push(`${file}: ${error.message}`);
        continue;
      }
      const copy = bytes.get(`schemas/${file}`);
      if (!copy) problems.push(`schemas/${file} is missing from the bundle; run emit-schemas.mjs`);
      else if (!copy.equals(source)) problems.push(`schemas/${file} differs from the tooling's schema; run emit-schemas.mjs`);
    }
    for (const path of files) if (path.startsWith('schemas/') && !expected.has(path)) problems.push(`${path}: not a schema the tooling has`);
    return `${validators.size} compile and match the tooling`;
  });

  check('artefacts', (problems) => {
    let raw = 0;
    for (const path of files) {
      const name = schemaFor(path);
      if (name === null) {
        raw += 1;
        continue;
      }
      const validate = validators.get(name);
      if (!validate) {
        problems.push(`${path}: its schema ${name} did not compile`);
        continue;
      }
      let value;
      try {
        value = parseJson(bytes.get(path));
      } catch (error) {
        problems.push(`${path}: ${error.message}`);
        continue;
      }
      const errors = validate(value);
      if (errors.length > 0) {
        for (const error of errors.slice(0, 5)) problems.push(`${path}: ${formatError(error)}`);
        if (errors.length > 5) problems.push(`${path}: and ${errors.length - 5} more`);
        continue;
      }
      parsed.set(path, { name, value });
      SEMANTICS[name]?.(path, value, bundle, problems);
    }
    for (const path of files) {
      if (/^ui\/shots\/.+\.png$/.test(path) && !bundle.digests.has(path.replace(/\.png$/, '.layout.json')))
        problems.push(`${path}: no layout sidecar beside it`);
    }
    return `${parsed.size} valid against their schema, ${raw} without one`;
  });

  check('manifest', (problems) => {
    const manifest = parsed.get(MANIFEST)?.value;
    if (!manifest) {
      if (!bytes.has(MANIFEST)) problems.push(`${MANIFEST} is missing; run manifest.mjs`);
      return '';
    }
    const pin = readPin(out);
    for (const key of Object.keys(pin)) if (manifest.pin[key] !== pin[key]) problems.push(`pin.${key} is not what PIN says`);
    if (manifest.tooling.dirty && !allowDirty) problems.push('written from an uncommitted tooling tree; commit the tooling and run manifest.mjs again');
    for (const path of files) {
      if (path === MANIFEST) continue;
      if (!Object.hasOwn(manifest.files, path)) problems.push(`${path}: not in the manifest`);
      else if (manifest.files[path] !== bundle.digests.get(path)) problems.push(`${path}: sha256 is not the manifest's`);
    }
    for (const path of Object.keys(manifest.files)) if (!bytes.has(path)) problems.push(`${path}: in the manifest, not in the bundle`);
    return `${Object.keys(manifest.files).length} files hashed, pin ${manifest.pin.commit.slice(0, 7)}, tooling ${manifest.tooling.commit.slice(0, 7)}`;
  });

  check('secrets', (problems) => {
    const fingerprints = loadAllowlist(bundleAllow);
    const scanLine = createScanner({ allow: { has: (value) => repoAllow.has(value) || fingerprints.has(fingerprint(value)) }, username: identity.username });
    const digests = new Set(bundle.digests.values());
    for (const { value } of parsed.values()) {
      visit(value, (item, key) => {
        if (typeof item === 'string' && key !== null && DIGEST_KEY.test(key)) digests.add(item);
      });
    }
    for (const digest of Object.values(parsed.get(MANIFEST)?.value.files ?? {})) digests.add(digest);
    let scanned = 0;
    for (const path of files) {
      for (const hit of scanLine(path)) {
        hidden.add(hit.value);
        problems.push(`${path}: its name  ${hit.rule}  ${mask(hit.value)}`);
      }
      const content = bytes.get(path);
      if (isExcluded(path) || content.subarray(0, 8000).includes(0)) continue;
      scanned += 1;
      content
        .toString('utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const hit of scanLine(line.replace(/\r$/, ''))) {
            if (hit.rule === 'hex64' && digests.has(hit.value.toLowerCase())) continue;
            problems.push(`${path}:${i + 1}  ${hit.rule}  ${mask(hit.value)}`);
          }
        });
    }
    return `${files.length} file names and ${scanned} text files scanned`;
  });

  check('user paths', (problems) => {
    const scanner = createUserPathScanner({ identity, allow: repoAllow });
    for (const path of files) {
      for (const hit of scanner.scanText(path)) {
        hidden.add(path.slice(hit.index, hit.index + hit.length));
        problems.push(`${path}: its name  ${hit.kind}  ${hit.masked}`);
      }
      for (const hit of scanner.scanBytes(bytes.get(path))) problems.push(`${path}  ${hit.kind}  ${hit.masked}`);
    }
    for (const [path, { name, value }] of parsed) {
      if (name !== 'layout-sidecar') continue;
      visit(value, (item) => {
        if (typeof item !== 'string') return;
        for (const hit of scanner.scanText(item)) problems.push(`${path}: text in the shot  ${hit.kind}  ${hit.masked}`);
      });
    }
    return `${files.length} files scanned, names and bytes`;
  });

  const scrub = (text) => [...hidden].reduce((out, value) => out.split(value).join(maskName(value)), text);
  for (const item of checks) item.problems = item.problems.map(scrub);
  return { ok: checks.every((item) => item.ok), checks };
}

const git = (root, args, input) =>
  execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, input, maxBuffer: 1024 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });

// What a push would publish (every blob any ref reaches) and what the next commit could add (changed, staged and untracked files).
export function repoEntries(root) {
  const entries = [];
  const objects = git(root, ['rev-list', '--all', '--objects'])
    .toString('utf8')
    .split('\n')
    .filter((line) => line.includes(' '))
    .map((line) => ({ id: line.slice(0, line.indexOf(' ')), path: line.slice(line.indexOf(' ') + 1) }));
  for (let i = 0; i < objects.length; i += BATCH) {
    const batch = objects.slice(i, i + BATCH);
    const packed = git(root, ['cat-file', '--batch'], `${batch.map((item) => item.id).join('\n')}\n`);
    let at = 0;
    for (const item of batch) {
      const eol = packed.indexOf(10, at);
      const [, type, size] = packed.toString('latin1', at, eol).split(' ');
      if (size === undefined) throw new Error(`git has no object ${item.id}`);
      const start = eol + 1;
      if (type === 'blob')
        entries.push({ path: item.path, where: `history, blob ${item.id.slice(0, 7)}`, bytes: packed.subarray(start, start + Number(size)) });
      at = start + Number(size) + 1;
    }
  }
  const names = (args) => git(root, args).toString('utf8').split('\0').filter(Boolean);
  const pending = new Set([
    ...names(['ls-files', '-z', '--modified', '--others', '--exclude-standard']),
    ...names(['diff', '--cached', '--name-only', '-z', '--diff-filter=d']),
  ]);
  for (const path of [...pending].sort())
    if (existsSync(join(root, path))) entries.push({ path, where: 'not committed yet', bytes: readFileSync(join(root, path)) });
  return entries;
}

export function verifyRepo({ out, identity = machineIdentity(), repoAllow = loadAllowlist(), bundleAllow = BUNDLE_ALLOW } = {}) {
  const root = git(out, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const entries = repoEntries(root);
  const checks = [];
  const hidden = new Set();
  const check = (name, run) => {
    const problems = [];
    const summary = run(problems) ?? '';
    checks.push({ name, ok: problems.length === 0, summary, problems });
  };

  check('repo secrets', (problems) => {
    const fingerprints = loadAllowlist(bundleAllow);
    const scanLine = createScanner({ allow: { has: (value) => repoAllow.has(value) || fingerprints.has(fingerprint(value)) }, username: identity.username });
    const digests = new Set(entries.map((entry) => sha256(entry.bytes)));
    for (const entry of entries) {
      if (!entry.path.endsWith('.json')) continue;
      let value;
      try {
        value = parseJson(entry.bytes);
      } catch {
        continue;
      }
      visit(value, (item, key) => {
        if (typeof item === 'string' && key !== null && DIGEST_KEY.test(key)) digests.add(item);
      });
      if (entry.path.endsWith(MANIFEST) && value?.files) for (const digest of Object.values(value.files)) digests.add(digest);
    }
    let scanned = 0;
    for (const { path, where, bytes } of entries) {
      for (const hit of scanLine(path)) {
        hidden.add(hit.value);
        problems.push(`${path} (${where}): its name  ${hit.rule}  ${mask(hit.value)}`);
      }
      if (isExcluded(path) || bytes.subarray(0, 8000).includes(0)) continue;
      scanned += 1;
      bytes
        .toString('utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const hit of scanLine(line.replace(/\r$/, ''))) {
            if (hit.rule === 'hex64' && digests.has(hit.value.toLowerCase())) continue;
            problems.push(`${path}:${i + 1} (${where})  ${hit.rule}  ${mask(hit.value)}`);
          }
        });
    }
    return `${entries.length} files of ${root}, in its history or waiting for a commit; ${scanned} of them text`;
  });

  check('repo user paths', (problems) => {
    const scanner = createUserPathScanner({ identity, allow: repoAllow });
    for (const { path, where, bytes } of entries) {
      for (const hit of scanner.scanText(path)) {
        hidden.add(path.slice(hit.index, hit.index + hit.length));
        problems.push(`${path} (${where}): its name  ${hit.kind}  ${hit.masked}`);
      }
      for (const hit of scanner.scanBytes(bytes)) problems.push(`${path} (${where})  ${hit.kind}  ${hit.masked}`);
    }
    return `${entries.length} files scanned, names and bytes`;
  });

  check('repo commits', (problems) => {
    const commits = git(root, ['log', '--all', '--format=%ae%x09%ce']).toString('utf8').split('\n').filter(Boolean);
    const counts = new Map();
    for (const line of commits)
      for (const address of new Set(line.split('\t'))) if (!NOREPLY.test(address)) counts.set(address, (counts.get(address) ?? 0) + 1);
    for (const [address, count] of counts)
      problems.push(`${count} of ${commits.length} commits carry an author or committer address that is not a GitHub noreply address  ${maskName(address)}`);
    return `${commits.length} commits, every author and committer address a GitHub noreply address`;
  });

  const scrub = (text) => [...hidden].reduce((line, value) => line.split(value).join(maskName(value)), text);
  for (const item of checks) item.problems = item.problems.map(scrub);
  return { ok: checks.every((item) => item.ok), checks };
}

function main(argv) {
  const out = resolveOut(argv);
  console.log(`Oracle bundle: ${out}`);
  const result = { ok: true, checks: [] };
  for (const part of [
    ...(argv.includes('--repo-only') ? [] : [() => verifyBundle({ out, allowDirty: argv.includes('--allow-dirty') })]),
    ...(argv.includes('--repo') || argv.includes('--repo-only') ? [() => verifyRepo({ out })] : []),
  ]) {
    const done = part();
    result.ok &&= done.ok;
    result.checks.push(...done.checks);
  }
  for (const item of result.checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok && item.summary ? `: ${item.summary}` : ''}`);
    for (const problem of item.problems.slice(0, MAX_LISTED)) console.log(`      ${problem}`);
    if (item.problems.length > MAX_LISTED) console.log(`      and ${item.problems.length - MAX_LISTED} more`);
  }
  console.log(result.ok ? '\nverify passed.' : '\nverify FAILED.');
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`verify could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
