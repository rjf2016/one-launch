// The acceptance checks of ticket M0-T11 against the bundle. One PASS, FAIL or SKIP line per check; exit 0 only when none fails.
//   node scripts/oracle/takeover/check.mjs [--out <bundle>] [--skip-app] [--units]
// --skip-app leaves out everything that starts Electron (the fixture, the layout, the safeStorage probe).
// --units prints the units of plan/design/takeover.md that coverage.json must map, and exits.
import { execFileSync, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repoRoot, resolveOut } from '../lib/out.mjs';
import { probeSafeStorage } from './vault/safestorage-probe.mjs';
import { unwrapProfileKey } from './vault/profile-key.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const skipApp = argv.includes('--skip-app');
const out = resolveOut(argv);
const rustRepo = resolve(out, '..');
const DESIGN = join(rustRepo, 'plan', 'design', 'takeover.md');
const BUNDLE = join(out, 'takeover');
const SCRATCH = resolve(process.env.T11_SCRATCH ?? join(repoRoot, '..', 'oracle-scratch', 't11'));
const TAGS = new Set(['static', 'argv', 'runner-reg', 'runner-fs', 'runner-proc', 'runner-exit', 'unit', 'local', 'owner']);

const isInside = (parent, child) => {
  const back = relative(resolve(parent).toLowerCase(), resolve(child).toLowerCase());
  return back !== '' && !back.startsWith('..') && !isAbsolute(back);
};
if (/[\\/]Users[\\/]/i.test(`${SCRATCH}\\`) || isInside(repoRoot, SCRATCH) || isInside(rustRepo, SCRATCH))
  throw new Error(`the scratch folder must be outside both repos and any user profile: ${SCRATCH}`);

function removeUnderScratch(folder) {
  if (!isInside(SCRATCH, folder)) throw new Error(`refusing to remove ${folder}: not under ${SCRATCH}`);
  rmSync(folder, { recursive: true, force: true });
}

export function designUnits(text) {
  const units = [];
  let para = [];
  const flush = () => {
    if (para.length)
      units.push(
        ...para
          .join(' ')
          .split(/(?<=\.)\s+(?=[A-Z`])/)
          .map((s) => s.trim()),
      );
    para = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^#/.test(line) || line.trim() === '') flush();
    else if (/^\s*(?:-|\d+\.)\s+/.test(line)) {
      flush();
      units.push(line.trim());
    } else para.push(line.trim());
  }
  flush();
  return units.filter(Boolean);
}

if (argv.includes('--units')) {
  for (const u of designUnits(readFileSync(DESIGN, 'utf8'))) console.log(JSON.stringify(u));
  process.exit(0);
}

const results = [];
async function check(name, run) {
  const problems = [];
  let note = '';
  try {
    note = (await run(problems)) ?? '';
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  const state = note === 'SKIP' ? 'SKIP' : problems.length ? 'FAIL' : 'PASS';
  results.push(state);
  console.log(`${state}  ${name}${note && note !== 'SKIP' ? `: ${note}` : ''}${note === 'SKIP' ? ' (--skip-app)' : ''}`);
  for (const p of problems.slice(0, 25)) console.log(`      ${p}`);
  if (problems.length > 25) console.log(`      … ${problems.length - 25} more`);
}

const pin = /^commit\s*=\s*([0-9a-f]{40})\s*$/m.exec(readFileSync(join(out, 'PIN'), 'utf8'))?.[1];
const lineCounts = new Map();
function linesOf(path) {
  if (lineCounts.has(path)) return lineCounts.get(path);
  let text = null;
  if (path.startsWith('oracle/')) {
    const file = join(out, path.slice('oracle/'.length));
    if (existsSync(file)) text = readFileSync(file, 'utf8');
  } else {
    const tracked = spawnSync('git', ['-C', repoRoot, 'show', `${pin}:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (tracked.status === 0) text = tracked.stdout;
    else if (existsSync(join(repoRoot, path))) text = readFileSync(join(repoRoot, path), 'utf8');
  }
  const count = text === null ? null : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  lineCounts.set(path, count);
  return count;
}

function assertions(contract) {
  const found = [];
  for (const block of contract.split(/\n\s*\n/)) {
    const m = /^\*\*([A-Z]\d+(?:\.\d+)?)\*\*\s/.exec(block.trim());
    if (m) found.push({ id: m[1], text: block.trim() });
  }
  return found;
}

const contractText = readFileSync(join(BUNDLE, 'contract.md'), 'utf8');

await check('1 contract: every design line covered, every citation resolves', (problems) => {
  const list = assertions(contractText);
  const ids = new Set(list.map((a) => a.id));
  if (ids.size !== list.length) problems.push('an assertion number is used twice');
  let cited = 0;
  for (const a of list) {
    const tags = [...a.text.matchAll(/Check: ([^.(]+)/g)].flatMap((m) => [...m[1].matchAll(/`([a-z-]+)`/g)].map((t) => t[1]));
    if (tags.length === 0 || tags.some((t) => !TAGS.has(t))) problems.push(`${a.id}: no check method, or one not in the table`);
    const cites = [...a.text.matchAll(/`((?:oracle\/)?[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)`/g)];
    if (cites.length === 0 && !a.id.startsWith('O')) problems.push(`${a.id}: no source line cited`);
    for (const [, path, spec] of cites) {
      cited += 1;
      const count = linesOf(path);
      if (count === null) {
        problems.push(`${a.id}: ${path} does not exist at the pin or on disk`);
        continue;
      }
      for (const part of spec.split(',')) {
        const [from, to = from] = part.split('-').map(Number);
        if (from < 1 || to < from || to > count) problems.push(`${a.id}: ${path}:${part} is outside its ${count} lines`);
      }
    }
  }
  const units = designUnits(readFileSync(DESIGN, 'utf8'));
  const table = JSON.parse(readFileSync(join(here, 'coverage.json'), 'utf8'));
  const mapped = new Map(table.map((row) => [row.unit, row.covers]));
  for (const u of units) {
    const covers = mapped.get(u);
    if (!covers || covers.length === 0) problems.push(`not covered: ${u.slice(0, 90)}`);
    else for (const id of covers) if (!ids.has(id)) problems.push(`coverage names ${id}, which contract.md does not have`);
  }
  for (const row of table) if (!units.includes(row.unit)) problems.push(`coverage row is no longer a line of the design: ${row.unit.slice(0, 90)}`);
  return `${list.length} assertions, ${cited} citations, ${units.length} design units mapped`;
});

function nodeOpen(key, blob) {
  if (blob.length < 31 || blob.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('not a v10 blob');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(3, 15));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(15, blob.length - 16)), decipher.final()]).toString('utf8');
}

await check('2 portable v10 vectors decrypt with node:crypto alone, and the failures fail', (problems) => {
  const v = JSON.parse(readFileSync(join(BUNDLE, 'vault', 'portable-v10.json'), 'utf8'));
  const key = Buffer.from(v.key.base64, 'base64');
  const other = Buffer.from(v.otherKey.base64, 'base64');
  if (key.length !== 32) problems.push('the key is not 32 bytes');
  for (const t of v.valid) {
    const [nonce, ct, tag, blob] = [t.nonce, t.ciphertext, t.tag, t.blob].map((x) => Buffer.from(x, 'base64'));
    if (!Buffer.concat([Buffer.from('v10'), nonce, ct, tag]).equals(blob)) problems.push(`${t.name}: blob is not prefix, nonce, ciphertext, tag`);
    try {
      if (nodeOpen(key, blob) !== t.plaintext) problems.push(`${t.name}: decrypts to another plaintext`);
    } catch (err) {
      problems.push(`${t.name}: does not decrypt (${err.message})`);
    }
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const again = Buffer.concat([Buffer.from('v10'), nonce, c.update(Buffer.from(t.plaintext, 'utf8')), c.final(), c.getAuthTag()]);
    if (!again.equals(blob)) problems.push(`${t.name}: encrypting the plaintext with the nonce does not give the blob`);
  }
  for (const f of v.failures) {
    let opened = true;
    try {
      nodeOpen(f.key === 'otherKey' ? other : key, Buffer.from(f.blob, 'base64'));
    } catch {
      opened = false;
    }
    if (opened) problems.push(`${f.name}: decrypts, but must fail`);
  }
  if (skipApp) return `${v.valid.length} valid, ${v.failures.length} failures; the safeStorage results were not re-measured (--skip-app)`;
  const probe = probeSafeStorage(SCRATCH);
  for (const w of probe.written)
    if (w.prefix !== 'v10' || w.blobBytes !== w.expectedBytes || !w.opensWithTheProfileKeyByNodeCrypto)
      problems.push(`safeStorage wrote ${w.name} differently`);
  for (const t of v.valid) {
    const p = probe.decrypted.find((d) => d.name === t.name);
    if (!p || p.plaintextMatches !== t.electron.decryptsToThePlaintext) problems.push(`${t.name}: safeStorage now gives another result`);
  }
  for (const f of v.failures) {
    const p = probe.decrypted.find((d) => d.name === f.name);
    const now = p && { decrypts: p.decrypts, returned: p.returned ?? null, thrown: p.thrown ?? null, processExit: p.processExit, chromiumLog: p.chromiumLog };
    if (JSON.stringify(now) !== JSON.stringify(f.electron.safeStorage)) problems.push(`${f.name}: safeStorage now gives another result`);
  }
  return `${v.valid.length} valid, ${v.failures.length} failures; real safeStorage re-measured on a throwaway profile and matches`;
});

const fixtureDir = join(SCRATCH, 'check-fixture');
let fixtureMade = false;

await check('3 the fixture script writes a machine-local data folder whose secrets read back through its own key', (problems) => {
  if (skipApp) return 'SKIP';
  removeUnderScratch(fixtureDir);
  const script = join(BUNDLE, 'vault', 'make-local-fixture.mjs');
  const write = spawnSync(process.execPath, [script, fixtureDir, `--electron=${repoRoot}`], { encoding: 'utf8', timeout: 240_000 });
  if (write.status !== 0) {
    problems.push(`the script left with ${write.status}: ${(write.stderr || write.stdout).trim().split('\n').pop()}`);
    return '';
  }
  fixtureMade = true;
  const manifest = JSON.parse(readFileSync(join(fixtureDir, 'fixture.json'), 'utf8'));
  const key = unwrapProfileKey(join(fixtureDir, 'data', 'chromium'), SCRATCH);
  const Database = createRequire(join(repoRoot, 'package.json'))('better-sqlite3');
  const db = new Database(join(fixtureDir, 'data', 'onelaunch.db'), { readonly: true });
  let read = 0;
  try {
    for (const a of manifest.accounts) {
      const row = db.prepare('SELECT secret_enc FROM accounts WHERE launcher = ? AND login = ?').get(a.launcher, a.login);
      if (!row) problems.push(`account ${a.login} is missing`);
      else if (a.password === null ? row.secret_enc !== null : nodeOpen(key, row.secret_enc) !== a.password)
        problems.push(`account ${a.login}: the password does not read back`);
      else read += 1;
    }
    for (const [name, value] of Object.entries({ ...manifest.secrets, [manifest.probe.key]: manifest.probe.value })) {
      const row = db.prepare('SELECT value_enc FROM secrets WHERE key = ?').get(name);
      if (!row || nodeOpen(key, row.value_enc) !== value) problems.push(`secret ${name} does not read back`);
      else read += 1;
    }
  } finally {
    db.close();
  }
  const back = spawnSync(process.execPath, [script, '--read', fixtureDir, `--electron=${repoRoot}`], { encoding: 'utf8', timeout: 240_000 });
  const lines = back.stdout.split(/\r?\n/).filter((l) => /^(PASS|FAIL)/.test(l));
  if (back.status !== 0 || lines.length === 0 || lines.some((l) => l.startsWith('FAIL')))
    problems.push(`--read through the app: ${lines.filter((l) => l.startsWith('FAIL')).join('; ') || back.stderr.trim()}`);
  return `${read} values decrypted with the profile key by node:crypto; --read through the app: ${lines.length} PASS; only ${relative(SCRATCH, fixtureDir)} under the scratch folder was written or removed`;
});

await check('4 the blob prefix and Local State layout in LAYOUT.md hold on the folder check 3 made', (problems) => {
  if (skipApp) return 'SKIP';
  if (!fixtureMade) throw new Error('check 3 made no folder');
  const md = readFileSync(join(BUNDLE, 'vault', 'LAYOUT.md'), 'utf8');
  const stated = JSON.parse(/```json layout\n([\s\S]*?)\n```/.exec(md)?.[1] ?? 'null');
  if (!stated) throw new Error('LAYOUT.md has no layout block');
  const root = fixtureDir;
  const statePath = join(root, ...stated.localState.split('/'));
  if (!existsSync(statePath)) problems.push(`no ${stated.localState}`);
  if (existsSync(join(root, ...stated.notAt.split('/')))) problems.push(`${stated.notAt} exists too`);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const osCrypt = state[stated.keyPath[0]];
  if (JSON.stringify(Object.keys(osCrypt ?? {}).sort()) !== JSON.stringify([...stated.osCryptKeys].sort())) problems.push('os_crypt holds other keys');
  const raw = osCrypt?.[stated.keyPath[1]];
  if (typeof raw !== 'string') problems.push('the wrapped key is not a string');
  const wrapped = Buffer.from(raw ?? '', stated.keyEncoding);
  if (wrapped.toString(stated.keyEncoding) !== raw) problems.push('the wrapped key is not canonical base64');
  if (wrapped.subarray(0, stated.wrappedPrefixBytes).toString('latin1') !== stated.wrappedPrefix) problems.push('the wrapped key has another prefix');
  const start = Buffer.from(stated.dpapiBlobStartsWith.replace(/ /g, ''), 'hex');
  if (!wrapped.subarray(stated.wrappedPrefixBytes, stated.wrappedPrefixBytes + start.length).equals(start)) problems.push('the DPAPI blob starts otherwise');
  const key = unwrapProfileKey(dirname(statePath), SCRATCH);
  if (key.length !== stated.unwrappedKeyBytes) problems.push('the unwrapped key has another length');
  const manifest = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
  const expected = new Map([
    ...manifest.accounts.filter((a) => a.password !== null).map((a) => [`accounts.secret_enc/${a.login}`, a.password]),
    ...Object.entries({ ...manifest.secrets, [stated.probe.key]: stated.probe.value }).map(([k, val]) => [`secrets.value_enc/${k}`, val]),
  ]);
  const Database = createRequire(join(repoRoot, 'package.json'))('better-sqlite3');
  const db = new Database(join(root, 'data', 'onelaunch.db'), { readonly: true });
  let blobs = 0;
  try {
    const ids = { accounts: 'login', secrets: 'key', launcher_sessions: 'account_id' };
    for (const column of stated.columns) {
      const [table, col] = column.split('.');
      for (const row of db.prepare(`SELECT ${ids[table]} AS id, ${col} AS enc FROM ${table}`).all()) {
        if (row.enc === null) continue;
        blobs += 1;
        if (row.enc.subarray(0, 3).toString('latin1') !== stated.blobPrefix) problems.push(`${column} ${row.id}: another prefix`);
        const plain = expected.get(`${column}/${row.id}`);
        if (plain === undefined) problems.push(`${column} ${row.id}: not in fixture.json`);
        else if (row.enc.length !== stated.overheadBytes + Buffer.byteLength(plain, 'utf8'))
          problems.push(`${column} ${row.id}: not ${stated.overheadBytes} bytes over the plaintext`);
      }
    }
  } finally {
    db.close();
  }
  if (stated.overheadBytes !== 3 + stated.nonceBytes + stated.tagBytes) problems.push('the stated overhead is not prefix, nonce and tag');
  if (blobs === 0) problems.push('no ciphertext found');
  removeUnderScratch(fixtureDir);
  return `${blobs} stored values checked; the fixture folder was removed`;
});

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));
}

await check('5 the generated files repeat byte for byte', (problems) => {
  const targets = [
    ['takeover/migrations', 'migrations'],
    ['takeover/nsis', 'nsis'],
    ['takeover/fixture-script', 'vault'],
    ...(skipApp ? [] : [['takeover/vault', 'vault']]),
  ];
  const runs = ['repeat-a', 'repeat-b'].map((name) => join(SCRATCH, name));
  for (const run of runs) {
    removeUnderScratch(run);
    for (const [gen] of targets) {
      const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'oracle', 'generate.mjs'), gen, '--out', run], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 400_000,
      });
      if (r.status !== 0) problems.push(`${gen} into ${relative(SCRATCH, run)} left with ${r.status}`);
    }
  }
  let compared = 0;
  for (const folder of [...new Set(targets.map(([, f]) => f))]) {
    const generated = filesUnder(join(runs[0], 'takeover', folder));
    for (const rel of generated) {
      const a = readFileSync(join(runs[0], 'takeover', folder, rel));
      const b = existsSync(join(runs[1], 'takeover', folder, rel)) ? readFileSync(join(runs[1], 'takeover', folder, rel)) : null;
      const c = existsSync(join(BUNDLE, folder, rel)) ? readFileSync(join(BUNDLE, folder, rel)) : null;
      compared += 1;
      if (!b || !a.equals(b)) problems.push(`${folder}/${rel}: two runs differ`);
      if (!c || !a.equals(c)) problems.push(`${folder}/${rel}: differs from the bundle`);
    }
  }
  for (const run of runs) removeUnderScratch(run);
  return `${compared} files, two runs and the bundle${skipApp ? ' (portable-v10.json left out: --skip-app)' : ''}`;
});

await check('6 the vendored copies are the sources they claim', (problems) => {
  const templates = join(repoRoot, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
  const held = JSON.parse(readFileSync(join(BUNDLE, 'nsis', 'templates-held-back.json'), 'utf8')).files;
  const heldRel = held.map((h) => h.path.replace(/^templates\/nsis\//, ''));
  const all = filesUnder(templates);
  const src = all.filter((rel) => !heldRel.includes(rel));
  const vendored = filesUnder(join(BUNDLE, 'nsis', 'templates'));
  if (JSON.stringify(src.sort()) !== JSON.stringify(vendored.sort())) problems.push('the vendored template list is not node_modules minus the held-back files');
  for (const h of held) {
    const rel = h.path.replace(/^templates\/nsis\//, '');
    if (!all.includes(rel)) {
      problems.push(`held back ${h.path} is not in the package`);
      continue;
    }
    const bytes = readFileSync(join(templates, rel));
    if (h.digest !== `sha256-${createHash('sha256').update(bytes).digest('base64')}` || h.bytes !== bytes.length)
      problems.push(`held back ${h.path}: the recorded digest or size is not the installed file's`);
  }
  for (const rel of src)
    if (existsSync(join(BUNDLE, 'nsis', 'templates', rel)) && !readFileSync(join(templates, rel)).equals(readFileSync(join(BUNDLE, 'nsis', 'templates', rel))))
      problems.push(`templates/${rel} differs`);
  const pinned = spawnSync('git', ['-C', repoRoot, 'show', `${pin}:build/installer.nsh`]);
  if (pinned.status !== 0 || !Buffer.from(pinned.stdout).equals(readFileSync(join(BUNDLE, 'nsis', 'build', 'installer.nsh'))))
    problems.push("build/installer.nsh is not the pin's");
  if (!readFileSync(join(here, 'vault', 'make-local-fixture.mjs')).equals(readFileSync(join(BUNDLE, 'vault', 'make-local-fixture.mjs'))))
    problems.push('the bundle copy of make-local-fixture.mjs differs from the tooling');
  const version = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'app-builder-lib', 'package.json'), 'utf8')).version;
  const locked = JSON.parse(execFileSync('git', ['-C', repoRoot, 'show', `${pin}:package-lock.json`], { encoding: 'utf8', maxBuffer: 64 << 20 })).packages?.[
    'node_modules/app-builder-lib'
  ]?.version;
  if (version !== locked) problems.push(`node_modules has app-builder-lib ${version}, the pin's lockfile ${locked}`);
  return `${src.length} templates identical, ${held.length} held back with a matching digest; installer.nsh and the fixture script identical; app-builder-lib ${version} as the pin locks it`;
});

await check('7 verify.mjs --allow-dirty has no finding under takeover/ but "not in the manifest"', async (problems) => {
  // verify.mjs prints at most a few findings per check, so its full result is read through its own export.
  const { verifyBundle } = await import(pathToFileURL(join(repoRoot, 'scripts', 'oracle', 'verify.mjs')).href);
  const findings = verifyBundle({ out, allowDirty: true })
    .checks.flatMap((c) => c.problems)
    .filter((p) => p.startsWith('takeover/'));
  const manifestOnly = findings.filter((p) => /: not in the manifest$/.test(p));
  for (const p of findings) if (!manifestOnly.includes(p)) problems.push(p);
  return `${manifestOnly.length} files not in the manifest yet, read from verifyBundle untruncated`;
});

const failed = results.filter((s) => s === 'FAIL').length;
console.log(
  failed === 0
    ? `\nM0-T11 checks: ${results.filter((s) => s === 'PASS').length} passed${results.includes('SKIP') ? ', some skipped' : ''}.`
    : `\nM0-T11 checks: ${failed} FAILED.`,
);
process.exitCode = failed === 0 ? 0 : 1;
