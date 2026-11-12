import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../app-driver.mjs';
import { resolveOut } from '../lib/out.mjs';
import { verifyBundle } from '../verify.mjs';

const FOLDER = 'l2/updates';
const CORE = ['up-to-date', 'update-ready', 'unsigned', 'wrong-key', 'hash-mismatch', 'network-failure'];
const RUNS = 3;

const out = resolveOut(process.argv.slice(2));
const dir = join(out, FOLDER);
const results = [];
const report = (name, problems, detail = '') => {
  results.push(problems.length === 0);
  console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
  for (const p of problems.slice(0, 20)) console.log(`      ${p}`);
  if (problems.length > 20) console.log(`      and ${problems.length - 20} more`);
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
  : [];
const load = (name) => {
  const bytes = readFileSync(join(dir, `${name}.json`));
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
};
const steps = (t) => t.recorded.steps;
const finalState = (t, step) => {
  const s = steps(t).find((x) => x.step === step);
  return s?.states[s.states.length - 1] ?? null;
};

function repeatProblems(name) {
  const problems = [];
  const file = join(dir, 'normalisation', `${name}.json`);
  if (!existsSync(join(dir, `${name}.json`))) return [`${name}: no transcript`];
  if (!existsSync(file)) return [`${name}: no normalisation report`];
  const { bytes } = load(name);
  const norm = JSON.parse(readFileSync(file, 'utf8'));
  const digest = sha256(bytes);
  if (!Array.isArray(norm.digests) || norm.digests.length < RUNS || norm.runs !== norm.digests.length)
    problems.push(`${name}: ${norm.digests?.length ?? 0} recordings, not ${RUNS}`);
  else if (norm.digests.some((d) => d !== digest)) problems.push(`${name}: a recording normalised to something other than the transcript in the bundle`);
  return problems;
}

const OUTCOME = {
  'up-to-date': (t) => finalState(t, 'timer')?.state === 'up-to-date' && finalState(t, 'manual')?.state === 'up-to-date',
  'update-ready': (t) =>
    finalState(t, 'timer')?.state === 'ready' && steps(t).some((s) => s.requests.some((r) => r.path.endsWith('.exe') && r.answer.status === 200)),
  unsigned: (t) => finalState(t, 'timer')?.message === 'the release is not signed',
  'wrong-key': (t) => finalState(t, 'timer')?.message?.startsWith('the release is signed with a key this build does not trust'),
  'hash-mismatch': (t) => finalState(t, 'timer')?.state === 'failed' && finalState(t, 'timer').step === 'download',
  'network-failure': (t) => finalState(t, 'timer')?.message === 'the update server could not be reached' && steps(t).every((s) => s.requests.length === 0),
};

{
  const problems = [];
  const seen = [];
  for (const name of CORE) {
    const p = repeatProblems(name);
    problems.push(...p);
    if (p.length) continue;
    const t = load(name).value;
    if (!OUTCOME[name](t)) problems.push(`${name}: the recorded outcome is not that condition's (${JSON.stringify(finalState(t, 'timer'))})`);
    else
      seen.push(
        `${name} ${steps(t)
          .map((s) => s.states.map((x) => x.state).join('>') || '-')
          .join(' | ')}`,
      );
  }
  report(
    `six feed conditions recorded, each ${RUNS} times with identical normalised output`,
    problems,
    seen.length === CORE.length ? `${CORE.length} of ${CORE.length}` : '',
  );
}

{
  const problems = names.flatMap(repeatProblems);
  report(`every condition in ${FOLDER} recorded ${RUNS} times with identical normalised output`, problems, `${names.length} conditions`);
}

function refusals() {
  const source = readFileSync(join(repoRoot, 'src', 'main', 'updates', 'manifest.ts'), 'utf8');
  const body = source.slice(source.indexOf('export function verifyManifest'));
  const end = body.indexOf('\n}\n');
  const found = [];
  const re = /refuse\(\s*'([a-z-]+)'\s*,\s*(?:'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)\s*\)/g;
  for (const m of body.slice(0, end).matchAll(re)) {
    const text = m[2] ?? m[3];
    const parts = text.split(/\$\{[^}]+\}/);
    const pattern = new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')}$`);
    found.push({ reason: m[1], text, pattern });
  }
  return found;
}

{
  const list = refusals();
  const problems = [];
  const where = [];
  if (list.length === 0) problems.push('no refuse(...) call found in verifyManifest');
  for (const { reason, text, pattern } of list) {
    const hits = [];
    for (const name of names) {
      const t = load(name).value;
      const viaEngine = steps(t).some(
        (s) =>
          s.states.some((x) => x.state === 'failed' && x.step === 'verify' && pattern.test(x.message)) &&
          s.log.some((l) => l.exact && l.message === 'update verify failed' && l.meta?.reason === reason && pattern.test(l.meta?.message ?? '')),
      );
      if (viaEngine) hits.push(name);
      else if (t.direct && t.direct.verdict?.reason === reason && pattern.test(t.direct.verdict.detail)) hits.push(`${name} (verifyManifest called directly)`);
    }
    if (hits.length === 0) problems.push(`${reason}: "${text}" appears in no transcript`);
    else where.push(`${reason} "${text}" in ${hits.join(', ')}`);
  }
  report('every refusal reason of verifyManifest appears with its exact text', problems, `${list.length - problems.length} of ${list.length}`);
  for (const w of where) console.log(`      ${w}`);
}

{
  const problems = [];
  const name = 'auto-off-in-flight';
  if (!names.includes(name)) problems.push(`no ${name} transcript`);
  else {
    const t = load(name).value;
    const step = steps(t).find((s) => s.step === 'timer');
    const off = step?.actions?.find((a) => a.invoke === 'settings:set' && a.req.key === 'updates.auto' && a.req.value === 'false');
    if (!off) problems.push('the background check has no switch-off while it is in flight');
    if (!step?.log.some((l) => l.exact && l.message === 'update check' && l.meta?.origin === 'background'))
      problems.push('the check is not the background one');
    const manifest = step?.requests.find((r) => r.path === '/latest.yml');
    if (!manifest || manifest.answer.status !== 200) problems.push('the check did not complete its request for latest.yml');
    if (step?.requests.some((r) => r.path.endsWith('.exe'))) problems.push('the background check went on to download');
    const states = step?.states.map((s) => s.state).join('>');
    if (states !== 'checking>idle') problems.push(`the background check went ${states}, not checking>idle`);
    problems.push(...repeatProblems(name));
  }
  report('spec 12.2: switching automatic updates off does not cancel a background check in flight', problems);
}

{
  const result = verifyBundle({ out, allowDirty: true });
  const mine = result.checks.flatMap((c) => c.problems.map((p) => ({ check: c.name, p }))).filter(({ p }) => p.includes(`${FOLDER}/`));
  const other = mine.filter(({ p }) => !/: not in the manifest$/.test(p));
  report(
    `verify.mjs --allow-dirty: no finding under ${FOLDER}/ but "not in the manifest"`,
    other.map(({ check, p }) => `${check}: ${p}`),
    `${mine.length - other.length} not in the manifest`,
  );
}

{
  const problems = [];
  const forbidden = [
    [/127\.0\.0\.1:\d/, 'a loopback port'],
    [/oracle-scratch/i, 'the scratch folder'],
    [/[A-Za-z]:[\\/]+Users[\\/]/i, 'a user folder'],
    [/[A-Za-z]:\\\\?Coding/i, 'an absolute path of this machine'],
  ];
  const keyIds = new Set();
  for (const name of names) {
    const text = readFileSync(join(dir, `${name}.json`), 'utf8');
    for (const [re, what] of forbidden) if (re.test(text)) problems.push(`${name}: holds ${what}`);
    const t = JSON.parse(text);
    for (const id of t.feed.keys) keyIds.add(id);
  }
  const throwaway = JSON.parse(readFileSync(join(out, 'fixtures', 'updates', 'README-keys.json'), 'utf8')).keyId;
  for (const id of keyIds) if (id !== throwaway) problems.push(`a transcript trusts key ${id}, not the throwaway fixture key`);
  report('no port, scratch path, user folder or key other than the throwaway one in a transcript', problems);
}

process.exitCode = results.every(Boolean) ? 0 : 1;
