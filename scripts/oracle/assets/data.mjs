import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot } from '../lib/out.mjs';

const rel = (file) => relative(repoRoot, file).replace(/\\/g, '/');

function filesUnder(dir, test) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return filesUnder(full, test);
      return test(entry.name) ? [full] : [];
    })
    .sort((a, b) => (rel(a) < rel(b) ? -1 : rel(a) > rel(b) ? 1 : 0));
}

// Where a value on screen can come from when it is not copy, in the order a value is looked for: the fake launchers' own
// files first (what a real launcher would hold), then what the simulator writes, then what a capture typed or injected.
export const ORIGIN_GROUPS = [
  { kind: 'fixture', what: 'the fake-launcher scenario', files: () => filesUnder(join(repoRoot, 'test', 'fake-launchers'), (n) => n === 'scenario.json') },
  {
    kind: 'fixture',
    what: 'a fixture file the scenario lays out',
    files: () => filesUnder(join(repoRoot, 'test', 'fixtures'), (n) => !/\.(png|jpe?g|webp|db)$/i.test(n)),
  },
  {
    kind: 'fixture',
    what: 'a capture-only scenario',
    files: () => filesUnder(join(repoRoot, 'scripts', 'oracle', 'ui', 'scenarios'), (n) => n === 'scenario.json'),
  },
  {
    kind: 'launcher-output',
    what: 'what the fake launcher writes or answers',
    files: () => filesUnder(join(repoRoot, 'src', 'main', 'launchers', 'sim'), (n) => n.endsWith('.ts')),
  },
  {
    kind: 'capture-input',
    what: 'typed, chosen or injected by the capture',
    files: () => filesUnder(join(repoRoot, 'scripts', 'scenarios'), (n) => /^oracle-shots-.+\.mjs$/.test(n) || n === 'lib.mjs'),
  },
];

const QUOTED = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$\n]|\\.)*)`/g;
const unescape = (text) =>
  text
    .replace(/\\(["'`\\])/g, '$1')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n');

// Whole values only: a quoted string, or what follows `=` or `: ` on a line. A value that is only part of a path or a sentence is not one.
function valuesOfLine(line) {
  const out = [];
  for (const match of line.matchAll(QUOTED)) {
    const value = unescape(match[1] ?? match[2] ?? match[3] ?? '');
    if (value.trim() !== '') out.push(value);
    if (value.includes(',')) for (const item of value.split(',')) if (item.trim() !== '' && item.trim() !== value) out.push(item.trim());
  }
  const assigned = /^\s*[\w.\-[\]]+\s*(?:=|:\s)\s*([^"'`{[].*?)\s*$/.exec(line);
  if (assigned && assigned[1] !== '') out.push(assigned[1]);
  return out;
}

export function loadOrigins() {
  const values = new Map();
  const texts = new Map();
  const groupOf = new Map();
  for (const group of ORIGIN_GROUPS) {
    for (const full of group.files()) {
      const file = rel(full);
      const text = readFileSync(full, 'utf8');
      texts.set(file, text);
      groupOf.set(file, group);
      text.split(/\r?\n/).forEach((line, i) => {
        for (const value of valuesOfLine(line)) if (!values.has(value)) values.set(value, { kind: group.kind, what: group.what, file, line: i + 1 });
      });
    }
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return { values, texts, groupOf, appVersion: pkg.version };
}

export function originHolds(file, line, value) {
  const full = join(repoRoot, file);
  if (!existsSync(full)) return false;
  const text = readFileSync(full, 'utf8').split(/\r?\n/)[line - 1] ?? '';
  return text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)) || text.includes(value.replace(/\\/g, '\\\\'));
}
