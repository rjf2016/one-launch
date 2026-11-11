// Prints what the bundle's normalisation reports add up to: per script, how many paths differed between the recordings
// and how many a rule changed, then every rule with its paths, and the two lists that must be empty or `enc` only.
//   node scripts/oracle/l2/report.mjs [--out <folder>]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveOut } from '../lib/out.mjs';

const dir = join(resolveOut(), 'l2', 'normalisation');
const reports = readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));

const byRule = new Map();
const agreed = new Map();
let failed = false;

console.log('script                 recordings  differed  normalised  differed-not-normalised  normalised-not-differed');
for (const r of reports) {
  const paths = new Set(r.normalised.map((f) => f.path));
  const extra = r.normalisedNotVolatile.filter((f) => f.rule !== 'enc');
  if (r.volatileNotNormalised.length > 0 || extra.length > 0) failed = true;
  console.log(
    `${r.script.padEnd(22)} ${String(r.recordings).padStart(10)} ${String(r.volatile.length).padStart(9)} ${String(paths.size).padStart(11)} ${String(r.volatileNotNormalised.length).padStart(24)} ${String(r.normalisedNotVolatile.length).padStart(24)}`,
  );
  for (const f of r.normalised) byRule.set(f.rule, (byRule.get(f.rule) ?? new Set()).add(f.path));
  for (const f of r.normalisedNotVolatile) agreed.set(`${f.rule}  ${f.path}`, (agreed.get(`${f.rule}  ${f.path}`) ?? 0) + 1);
  for (const t of r.transient ?? []) console.log(`  transient state left out: ${t.step} ${t.status} "${t.detail}"`);
}

console.log('\nrules and the paths they changed, over all scripts');
for (const [rule, paths] of [...byRule].sort()) {
  console.log(`  ${rule} (${paths.size})`);
  for (const path of [...paths].sort()) console.log(`    ${path}`);
}
console.log('\nchanged by a rule although the recordings agreed there');
for (const [what, count] of [...agreed].sort()) console.log(`  ${what}  (${count} scripts)`);
console.log(
  failed
    ? '\nFAILED: a path differed with no rule, or a rule other than enc changed a path the recordings agreed on.'
    : '\nEvery path that differed was changed by a rule, and the only rule that changed a path the recordings agreed on is enc.',
);
process.exitCode = failed ? 1 : 0;
