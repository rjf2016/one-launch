// The acceptance checks of ticket M0-T08, measured against the bundle and the source. One PASS or FAIL line per check.
//   node scripts/oracle/assets/check.mjs [--out <bundle>] [--no-app] [--skip-verify]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import ts from 'typescript';
import { repoRoot, resolveOut } from '../lib/out.mjs';
import { scratchBase } from '../ui/kit.mjs';
import { verifyBundle } from '../verify.mjs';
import { captureApp } from './capture.mjs';
import { RUNTIME_FILE } from './runtime-files.mjs';
import { compareToken, readTokens } from './tokens.mjs';

const require = createRequire(join(repoRoot, 'package.json'));
const MAX_LISTED = 12;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const norm = (text) => text.replace(/\s+/g, ' ').trim();

// JSX text as the compiler emits it: lines trimmed where they meet a break, blank lines dropped, the rest joined by one space.
function jsxValue(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  const kept = lines.map((line, i) => {
    let piece = line.replace(/\t/g, ' ');
    if (i !== 0) piece = piece.replace(/^ +/, '');
    if (i !== lines.length - 1) piece = piece.replace(/ +$/, '');
    return piece;
  });
  return kept.filter((piece) => piece !== '').join(' ');
}

const parsed = new Map();
function nodesOnLine(file, line) {
  if (!parsed.has(file)) {
    const full = join(repoRoot, file);
    const byLine = new Map();
    if (existsSync(full)) {
      const sf = ts.createSourceFile(
        full,
        readFileSync(full, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const add = (node, pos) => {
        const at = sf.getLineAndCharacterOfPosition(pos).line + 1;
        if (!byLine.has(at)) byLine.set(at, []);
        byLine.get(at).push(node);
      };
      const visit = (node) => {
        if (ts.isJsxText(node)) {
          const first = node.text.search(/\S/);
          if (first !== -1) add(node, node.pos + first);
        } else add(node, node.getStart());
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    parsed.set(file, byLine);
  }
  return parsed.get(file).get(line) ?? [];
}

const literalOf = (node) => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null);
function plusParts(node) {
  const operands = [];
  const flat = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      flat(n.left);
      flat(n.right);
    } else if (ts.isParenthesizedExpression(n) && ts.isBinaryExpression(n.expression) && n.expression.operatorToken.kind === ts.SyntaxKind.PlusToken)
      flat(n.expression);
    else operands.push(n);
  };
  flat(node);
  const parts = [''];
  for (const operand of operands) {
    const text = literalOf(operand);
    if (text !== null) parts[parts.length - 1] += text;
    else parts.push('');
  }
  return parts;
}

// The cited file holds, at the cited line, a string of the cited kind with exactly this value.
function sourceHolds(entry) {
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  return nodesOnLine(entry.file, entry.line).some((node) => {
    if (entry.kind === 'jsx-text') return ts.isJsxText(node) && jsxValue(node.text) === entry.text;
    if (entry.kind === 'literal' || entry.kind === 'jsx-attr') return literalOf(node) === entry.text;
    if (entry.kind === 'template')
      return ts.isTemplateExpression(node) && same([node.head.text, ...node.templateSpans.map((s) => s.literal.text)], entry.parts);
    if (entry.kind === 'concat')
      return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && same(plusParts(node), entry.parts);
    return false;
  });
}

const fileLines = new Map();
function lineOf(file, line) {
  if (!fileLines.has(file)) fileLines.set(file, existsSync(join(repoRoot, file)) ? readFileSync(join(repoRoot, file), 'utf8').split(/\r?\n/) : []);
  return fileLines.get(file)[line - 1] ?? null;
}
const lineHolds = (text, value) =>
  text !== null && (text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)) || text.includes(value.replace(/\\/g, '\\\\')));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const APP_VERSION = readJson(join(repoRoot, 'package.json')).version;

function dataHolds(value, rec) {
  const o = rec.origin ?? {};
  switch (rec.kind) {
    case 'marker':
      return /^([▸▾•]|\d+\.) $/.test(value) && Boolean(o.browser);
    case 'path':
      return /^[A-Za-z]:[\\/]/.test(value) && /oracle-scratch/i.test(value) && Boolean(o.scratch);
    case 'clock':
      return (
        Boolean(o.clock) &&
        (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/.test(value) ||
          /^[A-Z][a-z]{2} \d{1,2}, \d{4},?( \d{1,2}:\d{2} [AP]M)?$/.test(value) ||
          /^\d{1,2}:\d{2}(:\d{2})? [AP]M$/.test(value) ||
          /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(value))
      );
    case 'relative-time':
      return (
        Boolean(o.clock) &&
        /^(\d+ (second|minute|hour|day|week|month|year)s? ago|in \d+ \w+|yesterday|tomorrow|last (week|month|year)|next (week|month|year))$/.test(value)
      );
    case 'date': {
      const m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(value);
      if (!m || !o.file) return false;
      const iso = `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      return iso === o.value && lineHolds(lineOf(o.file, o.line), iso);
    }
    case 'count':
      return Boolean(o.computed) && /^-?\d+(\.\d+)?%?$/.test(value);
    case 'fingerprint':
      return Boolean(o.computed) && /^[0-9a-f]{8}$/.test(value);
    case 'version':
      if (o.file === 'package.json') return value === APP_VERSION;
      if (o.runtime) return /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(value);
      return Boolean(o.file) && lineHolds(lineOf(o.file, o.line), value);
    default: {
      if (!o.file) return false;
      const text = lineOf(o.file, o.line);
      if (text === null) return false;
      if (o.masked) {
        const re = new RegExp(
          norm(value)
            .split('…')
            .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^\'"\\s]+'),
        );
        return re.test(text);
      }
      if (o.tailOf) return [...text.matchAll(/[0-9A-Za-z]+/g)].some((m) => m[0].length === o.tailOf && m[0].endsWith(value));
      return lineHolds(text, norm(value)) || lineHolds(text, value);
    }
  }
}

// A string literal's value read straight from the source text after its opening quote: up to `n` characters, or to the
// closing quote or the end of the line, whichever comes first.
function decodeLiteral(raw, quote, n) {
  let out = '';
  for (let i = 0; i < raw.length && out.length < n; i += 1) {
    const ch = raw[i];
    if (ch === quote) return { text: out, closed: true };
    if (quote === '`' && ch === '$' && raw[i + 1] === '{') return { text: out, closed: true };
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === '0') out += '\0';
    else if (next === 'x') {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (next === 'u' && raw[i + 1] === '{') {
      const end = raw.indexOf('}', i);
      out += String.fromCodePoint(Number.parseInt(raw.slice(i + 2, end), 16));
      i = end;
    } else if (next === 'u') {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (next !== undefined) out += next;
  }
  return { text: out, closed: false };
}

const PREFIX = 10;

// The cited line and column, read as plain text, hold the start of the string: JSX text's first visible characters, or the
// opening quote or backtick followed by the value's first characters as written (a slot's expression where a template starts with one).
function plainTextHolds(entry) {
  const line = lineOf(entry.file, entry.line);
  if (line === null || entry.col < 1) return false;
  const following = [1, 2, 3, 4, 5].map((k) => lineOf(entry.file, entry.line + k) ?? '');
  const rest = [line.slice(entry.col - 1), ...following].join('\n');
  const expressionAt = (from, expression) => {
    const want = expression.slice(0, PREFIX);
    return want !== '' && from.replace(/\s+/g, ' ').trimStart().startsWith(want);
  };
  const literalAt = (from, value) => {
    const quote = from[0];
    if (quote !== "'" && quote !== '"' && quote !== '`') return false;
    const read = decodeLiteral(from.slice(1), quote, Math.min(PREFIX, value.length));
    return value.startsWith(read.text) && (read.text.length === Math.min(PREFIX, value.length) || read.closed);
  };
  if (entry.kind === 'jsx-text') {
    const want = entry.text.trimStart();
    const have = rest.split('\n')[0].trimEnd();
    const k = Math.min(PREFIX, want.length, have.length);
    return k > 0 && have.slice(0, k) === want.slice(0, k);
  }
  if (entry.kind === 'literal' || entry.kind === 'jsx-attr') return literalAt(rest, entry.text);
  if (entry.kind === 'template') {
    if (rest[0] !== '`') return false;
    if (entry.parts[0] !== '') return literalAt(rest, entry.parts[0]);
    return rest.startsWith('`${') && expressionAt(rest.slice(3), entry.slots[0]);
  }
  if (entry.kind === 'concat') return entry.parts[0] !== '' ? literalAt(rest, entry.parts[0]) : expressionAt(rest, entry.slots[0]);
  return false;
}

function buildChecker(copy) {
  const byId = new Map(copy.strings.map((s) => [s.id, s]));
  const held = new Map();
  const problems = [];
  const cited = (source) => {
    const entry = byId.get(source.id);
    if (!entry) return null;
    if (entry.file !== source.file || entry.line !== source.line) return null;
    if (!held.has(entry.id)) held.set(entry.id, sourceHolds(entry));
    return held.get(entry.id) ? entry : null;
  };
  const fill = (entry, slots) => entry.parts.map((part, k) => (k === 0 ? part : `${slots[k - 1]?.value ?? '\u0000'}${part}`)).join('');
  function slotHolds(slot) {
    if (slot.class === 'empty') return slot.value === '';
    if (slot.class === 'data') return dataHolds(slot.value, slot);
    if (slot.class !== 'copy') return false;
    return copyHolds(slot.value, slot);
  }
  function copyHolds(text, rec) {
    const sources = (rec.sources ?? []).map(cited);
    if (rec.match === 'join' && rec.pieces) {
      const joined = rec.pieces.map((p) => p.value).join(rec.separator ?? ' ');
      return norm(joined) === norm(text) && rec.pieces.every((piece) => slotHolds(piece));
    }
    if (sources.length === 0 || sources.some((s) => s === null)) return false;
    switch (rec.match) {
      case 'exact':
        return sources.some((s) => s.text === text || norm(s.text) === norm(text));
      case 'transform':
        return sources.some((s) =>
          rec.transform === 'uppercase' ? norm(s.text).toUpperCase() === norm(text) : `${norm(s.text)[0].toUpperCase()}${norm(s.text).slice(1)}` === norm(text),
        );
      case 'template':
      case 'join':
        return sources.some((s) => s.parts && fill(s, rec.slots ?? []) === text) && (rec.slots ?? []).every(slotHolds);
      default:
        return false;
    }
  }
  return { copyHolds, problems, held };
}

function runsOfGroup(runs, i, item) {
  const first = i - item.line[0] + 1;
  return runs.slice(first, first + item.line[1]).map((run) => run.t);
}

async function main(argv) {
  const out = resolveOut(argv);
  const noApp = argv.includes('--no-app');
  const skipVerify = argv.includes('--skip-verify');
  // The kit empties the slot folders it is given; another ticket's captures use the shared default.
  process.env.ORACLE_SCRATCH ??= join(repoRoot, '..', 'oracle-scratch', 't08');
  const results = [];
  const check = async (name, run) => {
    const problems = [];
    let summary = '';
    try {
      summary = await run(problems);
    } catch (err) {
      problems.push(`threw: ${err.message}`);
    }
    const r = { name, ok: problems.length === 0, summary, problems };
    results.push(r);
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.summary}`);
    for (const p of r.problems.slice(0, MAX_LISTED)) console.log(`      ${p}`);
    if (r.problems.length > MAX_LISTED) console.log(`      … and ${r.problems.length - MAX_LISTED} more`);
  };

  await check('every text run observed in a sidecar maps to a source string with file and line, or is data with its kind and origin', (problems) => {
    const copy = readJson(join(out, 'assets', 'copy.json'));
    const map = readJson(join(out, 'assets', 'copy-map.json'));
    const { copyHolds } = buildChecker(copy);
    const shots = readdirSync(join(out, 'ui', 'shots'))
      .filter((n) => n.endsWith('.layout.json'))
      .sort();
    const mapped = new Map(map.sidecars.map((s) => [s.sidecar, s.runs]));
    const tally = { copy: 0, data: 0 };
    const byMatch = {};
    const byKind = {};
    for (const name of shots) {
      const path = `ui/shots/${name}`;
      const runs = readJson(join(out, path)).text;
      const items = mapped.get(path);
      if (!items) {
        problems.push(`${path}: not in the mapping`);
        continue;
      }
      if (items.length !== runs.length) problems.push(`${path}: ${runs.length} runs, ${items.length} mapped`);
      runs.forEach((run, i) => {
        const item = items[i];
        if (!item || item.t !== run.t || item.i !== i) {
          problems.push(`${path} run ${i}: the mapping does not hold this run`);
          return;
        }
        let whole = run.t;
        if (item.line) {
          whole = item.whole;
          const pieces = runsOfGroup(runs, i, item);
          if (pieces.join('').replace(/\s/g, '') !== whole.replace(/\s/g, '') || !whole.includes(run.t.trim())) {
            problems.push(`${path} run ${i}: its group does not make ${JSON.stringify(whole.slice(0, 60))}`);
            return;
          }
        }
        if (item.class === 'data') {
          tally.data += 1;
          byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
          if (!dataHolds(whole, item)) problems.push(`${path} run ${i}: data ${item.kind} not borne out by its origin: ${JSON.stringify(whole.slice(0, 60))}`);
          return;
        }
        if (item.class !== 'copy') {
          problems.push(`${path} run ${i}: ${item.class} ${JSON.stringify(run.t.slice(0, 60))}`);
          return;
        }
        tally.copy += 1;
        byMatch[item.match] = (byMatch[item.match] ?? 0) + 1;
        const rec = item.line ? { ...item, match: item.of } : item;
        if (!copyHolds(whole, rec)) problems.push(`${path} run ${i}: the cited source does not give ${JSON.stringify(whole.slice(0, 60))}`);
      });
    }
    for (const step of copy.stepTitles) {
      if (step.class === 'copy' ? !copyHolds(step.title, step) : step.class === 'data' ? !dataHolds(step.title, step) : true)
        problems.push(`step title ${JSON.stringify(step.title)}: not borne out by its source`);
    }
    const fmt = (o) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
    return `${shots.length} sidecars, ${tally.copy + tally.data} runs: ${tally.copy} copy (${fmt(byMatch)}), ${tally.data} data (${fmt(byKind)}); ${copy.stepTitles.length} step titles`;
  });

  await check('every cited string starts at its cited line and column, read as plain text without the compiler', (problems) => {
    const copy = readJson(join(out, 'assets', 'copy.json'));
    const map = readJson(join(out, 'assets', 'copy-map.json'));
    const byId = new Map(copy.strings.map((s) => [s.id, s]));
    const verdict = new Map();
    const holds = (entry) => {
      if (!verdict.has(entry.id)) verdict.set(entry.id, plainTextHolds(entry));
      return verdict.get(entry.id);
    };
    for (const entry of copy.strings)
      if (!holds(entry))
        problems.push(`${entry.id} ${entry.file}:${entry.line}:${entry.col} does not start ${JSON.stringify((entry.text ?? '').slice(0, 40))}`);
    let citations = 0;
    const visit = (rec, where) => {
      for (const source of rec.sources ?? []) {
        citations += 1;
        const entry = byId.get(source.id);
        if (!entry || entry.file !== source.file || entry.line !== source.line)
          problems.push(`${where}: cites ${source.id} at ${source.file}:${source.line}, which copy.json does not hold`);
        else if (!holds(entry)) problems.push(`${where}: ${source.id} is not at ${source.file}:${source.line}`);
      }
      for (const slot of rec.slots ?? []) visit(slot, where);
      for (const piece of rec.pieces ?? []) visit(piece, where);
    };
    for (const { sidecar, runs } of map.sidecars) for (const run of runs) visit(run, `${sidecar} run ${run.i}`);
    for (const step of copy.stepTitles) visit(step, `step title ${JSON.stringify(step.title)}`);
    return `${copy.strings.length} strings in copy.json and ${citations} citations in copy-map.json and the step titles tested, ${[...verdict.values()].filter(Boolean).length} distinct strings hold`;
  });

  await check('one icon SVG per distinct Lucide import in src/, each named as imported', (problems) => {
    const names = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          const sf = ts.createSourceFile(
            full,
            readFileSync(full, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            entry.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
          );
          for (const st of sf.statements) {
            if (!ts.isImportDeclaration(st) || st.moduleSpecifier.text !== 'lucide-react' || st.importClause?.isTypeOnly) continue;
            const bindings = st.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings))
              for (const spec of bindings.elements) if (!spec.isTypeOnly) names.add((spec.propertyName ?? spec.name).text);
          }
        }
      }
    };
    walk(join(repoRoot, 'src'));
    const dir = join(out, 'assets', 'icons', 'lucide');
    const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.svg')) : [];
    const have = new Set(files.map((n) => n.replace(/\.svg$/, '')));
    for (const name of names) if (!have.has(name)) problems.push(`no SVG for ${name}`);
    for (const name of have) if (!names.has(name)) problems.push(`${name}.svg is not imported anywhere in src/`);
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const lucide = require('lucide-react');
    for (const name of [...names].filter((n) => have.has(n))) {
      const expected = `${renderToStaticMarkup(React.createElement(lucide[name]))}\n`;
      if (readFileSync(join(dir, `${name}.svg`), 'utf8') !== expected) problems.push(`${name}.svg differs from lucide-react's render`);
    }
    const version = readJson(require.resolve('lucide-react/package.json')).version;
    return `${names.size} distinct imports, ${files.length} SVGs, rendered from lucide-react ${version}${names.size === 54 ? '' : ' (the design says 54)'}`;
  });

  await check(
    `tokens.json values equal runtime getComputedStyle values (${noApp ? 'recorded at capture time, --no-app' : 'read from the app started now'})`,
    async (problems) => {
      const stored = readJson(join(out, 'assets', 'tokens.json'));
      const now = readTokens();
      const storedByName = new Map(stored.tokens.map((t) => [t.name, t]));
      for (const token of now.tokens) {
        const s = storedByName.get(token.name);
        if (!s) problems.push(`${token.name}: in index.css, not in tokens.json`);
        else if (s.value !== token.value) problems.push(`${token.name}: tokens.json says ${s.value}, index.css ${token.value}`);
      }
      if (stored.tokens.length !== now.tokens.length) problems.push(`tokens.json has ${stored.tokens.length} tokens, index.css ${now.tokens.length}`);
      let runtime;
      if (noApp) runtime = readJson(join(out, RUNTIME_FILE));
      else {
        ({ tokens: runtime } = await captureApp({ primitives: [], slot: 'assets-check' }));
      }
      const seen = new Map(runtime.tokens.map((t) => [t.name, t]));
      const hows = new Set();
      for (const token of now.tokens) {
        const result = compareToken(token, seen.get(token.name));
        hows.add(token.kind);
        if (!result.equal)
          problems.push(`${token.name}: ${token.value} is not what the page gives (${seen.get(token.name)?.computed ?? 'nothing'}; ${result.how})`);
      }
      return `${now.tokens.length} tokens (${[...hows].join(', ')}) compared value by value`;
    },
  );

  await check('a second run of the static generator gives byte-identical files', (problems) => {
    const scratch = join(scratchBase(), 'assets-regen');
    rmSync(scratch, { recursive: true, force: true });
    for (const dir of ['ui/shots', 'l2/expected']) {
      mkdirSync(join(scratch, dir), { recursive: true });
      for (const name of readdirSync(join(out, dir)).filter((n) => n.endsWith('.json'))) copyFileSync(join(out, dir, name), join(scratch, dir, name));
    }
    mkdirSync(join(scratch, 'assets'), { recursive: true });
    copyFileSync(join(out, RUNTIME_FILE), join(scratch, RUNTIME_FILE));
    const run = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'oracle', 'generate.mjs'), 'assets', '--out', scratch], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (run.status !== 0) {
      problems.push(`the generator failed: ${(run.stdout + run.stderr).slice(-400)}`);
      return 'not run';
    }
    const list = (base, rel = '') =>
      readdirSync(join(base, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(base, `${rel}${e.name}/`) : [`${rel}${e.name}`]));
    const made = list(join(scratch, 'assets')).filter((f) => f !== 'runtime.json');
    for (const file of made) {
      const bundled = join(out, 'assets', file);
      if (!existsSync(bundled)) problems.push(`assets/${file}: made by the generator, not in the bundle`);
      else if (!readFileSync(bundled).equals(readFileSync(join(scratch, 'assets', file)))) problems.push(`assets/${file}: differs on a second run`);
    }
    rmSync(scratch, { recursive: true, force: true });
    return `${made.length} files compared`;
  });

  if (skipVerify) console.log('SKIP  verify.mjs --allow-dirty: left out by --skip-verify');
  else
    await check('verify.mjs --allow-dirty finds nothing under assets/ but "not in the manifest"', (problems) => {
      const result = verifyBundle({ out, allowDirty: true });
      let total = 0;
      let manifest = 0;
      for (const item of result.checks) {
        for (const problem of item.problems) {
          if (!/^assets\//.test(problem)) continue;
          total += 1;
          if (/^assets\/\S+: not in the manifest$/.test(problem)) manifest += 1;
          else problems.push(`${item.name}: ${problem}`);
        }
      }
      return `${total} findings on assets/, ${manifest} of them "not in the manifest"`;
    });

  return results.every((r) => r.ok) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err.stack ?? err.message);
    process.exitCode = 1;
  },
);
