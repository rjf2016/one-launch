import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repoRoot, resolveOut, writeArtefact } from '../../lib/out.mjs';
import { AREAS } from '../lib/grammar.mjs';
import { collectBlocks, findTarget, firstLine, parseSource, sameModuleCallees, span, SyntaxKind } from './analyse.mjs';
import { executedScript, generatedOffset, paintCounts } from './sourcemap.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const L1 = resolve(HERE, '..');
const SRC_PREFIX = `${repoRoot.replace(/\\/g, '/')}/src/`.toLowerCase();

const option = (argv, name) => {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
};

function generators(area, only) {
  const suffix = area === 'example' ? '.dev.ts' : '.gen.ts';
  const dir = join(L1, area);
  const all = existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map((name) => String(name).replace(/\\/g, '/'))
        .filter((name) => name.endsWith(suffix) && !name.startsWith('coverage/'))
        .sort()
    : [];
  if (!only) return all;
  const wanted = only.split(',').map((name) => name.trim().replace(/\\/g, '/'));
  for (const name of wanted)
    if (!all.includes(name)) throw new Error(`--only: no generator ${name} under scripts/oracle/l1/${area}/ (have ${all.join(', ') || 'none'})`);
  return wanted;
}

function runGenerators(area, files, scratch, override) {
  const include = override ?? (files.length === 1 ? `scripts/oracle/l1/${area}/${files[0]}` : `scripts/oracle/l1/${area}/{${files.join(',')}}`);
  const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  return spawnSync(process.execPath, [vitest, 'run', '--config', 'scripts/oracle/l1/coverage/vitest.config.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORACLE_OUT: join(scratch, 'vectors'),
      ORACLE_GENERATOR: include,
      ORACLE_L1_COVERAGE_DIR: join(scratch, 'raw'),
      ORACLE_L1_COVERAGE_SRC: SRC_PREFIX,
    },
  });
}

function relativeSource(url) {
  const path = decodeURIComponent(url.replace(/^file:\/\/\//, '')).replace(/\\/g, '/');
  return path.toLowerCase().startsWith(SRC_PREFIX) ? `src/${path.slice(SRC_PREFIX.length)}` : null;
}

function loadDumps(dir) {
  const bySource = new Map();
  const problems = [];
  if (!existsSync(dir)) return { bySource, problems: ['no coverage was recorded'] };
  for (const name of readdirSync(dir).sort()) {
    const dump = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    for (const entry of dump.scripts) {
      const path = relativeSource(entry.url);
      if (!path) continue;
      const script = executedScript(entry.source);
      if (!script) {
        problems.push(`${path}: the executed script has no inline source map in the expected wrapper`);
        continue;
      }
      if (!bySource.has(path)) bySource.set(path, []);
      bySource.get(path).push({ script, counts: paintCounts(entry.source.length, entry.functions) });
    }
  }
  return { bySource, problems };
}

function sourceOf(path, cache) {
  if (!cache.has(path)) {
    const text = readFileSync(join(repoRoot, ...path.split('/')), 'utf8');
    cache.set(path, { text, file: parseSource(path, text) });
  }
  return cache.get(path);
}

function countAt(runs, file, node) {
  const { start, end } = span(file, node);
  const text = file.text.slice(node.getStart(file));
  const literal = /^(['"])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(text);
  const tokens = literal ? [`'${literal[2]}'`, `"${literal[2]}"`] : [(/^[A-Za-z_$][\w$]*/.exec(text) ?? [text[0]])[0]];
  let total = 0;
  let mapped = false;
  for (const { script, counts } of runs) {
    const at = generatedOffset(script, start.line, start.character, end.line, end.character, tokens);
    if (at === null || counts[at] < 0) continue;
    mapped = true;
    total += counts[at];
  }
  return mapped ? total : null;
}

function measure(runs, file, root) {
  return collectBlocks(root).map((block) => {
    const where = span(file, block.node);
    const base = {
      kind: block.kind,
      where: where.text,
      line: where.start.line,
      column: where.start.character,
      text: firstLine(file, block.anchor && block.node.kind === SyntaxKind.Block ? block.anchor : block.node),
    };
    if (block.kind === 'default parameter') return { ...base, count: null, why: 'V8 keeps no counter for a default parameter' };
    if (!block.anchor) return { ...base, count: null, why: 'empty, nothing to count' };
    const count = countAt(runs, file, block.anchor);
    if (count === null) return { ...base, count: null, why: 'no mapping from the source to the executed code' };
    if (block.minus) {
      const then = countAt(runs, file, block.minus);
      return then === null ? { ...base, count: null, why: 'no mapping for the arm' } : { ...base, count: count - then };
    }
    return { ...base, count };
  });
}

const contains = (outer, inner) =>
  (outer.startLine < inner.startLine || (outer.startLine === inner.startLine && outer.startCol <= inner.startCol)) &&
  (outer.endLine > inner.endLine || (outer.endLine === inner.endLine && outer.endCol >= inner.endCol));

function summarise(blocks) {
  const parsed = blocks.map((block) => {
    const [, sl, sc, el, ec] = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(block.where).map(Number);
    return { ...block, startLine: sl, startCol: sc, endLine: el, endCol: ec };
  });
  const never = parsed.filter((block) => block.count === 0);
  const top = never.filter(
    (block) =>
      !never.some(
        (other) => other !== block && block.kind !== 'if never false' && other.kind !== 'if never false' && contains(other, block) && !contains(block, other),
      ),
  );
  return {
    total: blocks.filter((block) => block.count !== null).length,
    never: never.length,
    unmeasured: parsed.filter((block) => block.count === null),
    list: top.map((block) => ({
      ...block,
      inside: never.filter((other) => other !== block && block.kind !== 'if never false' && contains(block, other)).length,
    })),
  };
}

function render(area, files, sections, problems) {
  const lines = [
    `# Coverage: ${area}`,
    '',
    `Generators: ${files.map((name) => `\`${name.startsWith('scripts/') ? name : `${area}/${name}`}\``).join(', ')}`,
    '',
  ];
  lines.push('| Export | Source | Blocks | Never run | Not measured |', '| --- | --- | --- | --- | --- |');
  for (const section of sections) {
    const s = section.summary;
    lines.push(`| \`${section.name}\` | \`${section.source}\` | ${s ? s.total : '-'} | ${s ? s.never : '-'} | ${s ? s.unmeasured.length : '-'} |`);
  }
  if (problems.length > 0) lines.push('', '## Problems', '', ...problems.map((problem) => `- ${problem}`));
  const item = (source, block) =>
    `- \`${source}:${block.where}\` ${block.kind}${block.inside ? ` (and ${block.inside} inside it)` : ''}: \`${block.text.replace(/`/g, "'")}\``;
  for (const section of sections) {
    lines.push('', `## ${section.name}`, '');
    if (section.unmapped) lines.push('Taken from its vector file: no `targets.mjs` entry names it yet.', '');
    if (section.note) {
      lines.push(section.note);
      continue;
    }
    lines.push(`\`${section.source}:${section.range}\`, ${section.summary.total} blocks, ${section.summary.never} never run.`);
    if (section.summary.list.length > 0) lines.push('', ...section.summary.list.map((block) => item(section.source, block)));
    for (const block of section.summary.unmeasured)
      lines.push(`- not measured: \`${section.source}:${block.where}\` ${block.kind}, ${block.why}: \`${block.text}\``);
    for (const helper of section.helpers) {
      const s = helper.summary;
      const state = s.list.some((block) => block.kind === 'function') ? 'never entered' : `${s.total} blocks, ${s.never} never run`;
      lines.push('', `Same-module helper \`${helper.name}\` (\`${section.source}:${helper.range}\`): ${state}.`);
      if (s.list.length > 0 && state !== 'never entered') lines.push('', ...s.list.map((block) => item(section.source, block)));
      for (const block of s.unmeasured) lines.push(`- not measured: \`${section.source}:${block.where}\` ${block.kind}, ${block.why}: \`${block.text}\``);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const area = argv.find(
    (arg) =>
      !arg.startsWith('--') &&
      argv[argv.indexOf(arg) - 1] !== '--out' &&
      argv[argv.indexOf(arg) - 1] !== '--scratch' &&
      argv[argv.indexOf(arg) - 1] !== '--only',
  );
  if (!area || (!AREAS.includes(area) && area !== 'example')) {
    console.error(
      `usage: node scripts/oracle/l1/coverage/run.mjs <${AREAS.join('|')}> [--out <folder>] [--only=<generator>,<generator>] [--scratch <dir>] [--keep]`,
    );
    return 2;
  }
  const out = resolveOut(argv);
  const include = option(argv, 'include');
  const files = include ? [include] : generators(area, option(argv, 'only'));
  if (files.length === 0) throw new Error(`no generator under scripts/oracle/l1/${area}/`);
  const targetsFile = join(L1, area, 'targets.mjs');
  const mapping = existsSync(targetsFile) ? (await import(pathToFileURL(targetsFile).href)).default : [];

  const given = option(argv, 'scratch');
  const scratch = given ? resolve(given) : mkdtempSync(join(tmpdir(), 'oracle-l1-coverage-'));
  rmSync(join(scratch, 'raw'), { recursive: true, force: true });
  rmSync(join(scratch, 'vectors'), { recursive: true, force: true });
  const run = runGenerators(area, files, scratch, include);
  if (run.status !== 0) {
    console.error(`${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-25).join('\n'));
    throw new Error(`the generators failed (exit ${run.status})`);
  }
  const { bySource, problems } = loadDumps(join(scratch, 'raw'));

  const cache = new Map();
  const targets = [];
  const seen = new Set();
  for (const entry of mapping)
    for (const target of entry.exports) {
      const key = `${target.export} ${target.source}`;
      if (!seen.has(key)) targets.push(target);
      seen.add(key);
    }
  const written = join(scratch, 'vectors', 'l1', area);
  for (const name of existsSync(written) ? readdirSync(written).sort() : []) {
    if (!name.endsWith('.json')) continue;
    const vector = JSON.parse(readFileSync(join(written, name), 'utf8'));
    const key = `${vector.function} ${vector.source}`;
    if (!seen.has(key)) targets.push({ export: vector.function, source: vector.source, unmapped: true });
    seen.add(key);
  }
  const targetNames = new Set(targets.map((target) => `${target.source} ${target.export}`));
  const sections = [];
  for (const target of targets) {
    const section = { name: target.export, source: target.source, unmapped: Boolean(target.unmapped) };
    sections.push(section);
    if (!existsSync(join(repoRoot, ...target.source.split('/')))) {
      section.note = 'The source module does not exist.';
      continue;
    }
    const { file, text } = sourceOf(target.source, cache);
    const runs = bySource.get(target.source) ?? [];
    for (const { script } of runs) {
      if (script.content !== null && script.content.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) {
        problems.push(`${target.source}: the source map's copy of the module differs from the file on disk`);
        break;
      }
    }
    const found = findTarget(file, target.export);
    if (!found) {
      section.note = 'Not found as a top-level function, class, method or value in its module.';
      continue;
    }
    if (runs.length === 0) {
      section.note = 'No generator of this run loaded its module, so nothing was measured.';
      continue;
    }
    if (found.kind === 'value' && !collectBlocks(found.node).length) {
      section.note = `A value (\`${target.source}:${span(file, found.node).text}\`), no code of its own to cover.`;
      continue;
    }
    section.range = span(file, found.node).text;
    section.summary = summarise(measure(runs, file, found.node));
    section.helpers = sameModuleCallees(file, found.node)
      .filter((helper) => !targetNames.has(`${target.source} ${helper.name}`))
      .map((helper) => ({ name: helper.name, range: span(file, helper.node).text, summary: summarise(measure(runs, file, helper.node)) }));
  }

  const report = render(area, files, sections, [...new Set(problems)]);
  const target = writeArtefact(out, `l1/coverage/${area}.md`, report);
  console.log(`Coverage of ${area} (${files.length} generators) written to ${target}`);
  for (const section of sections) {
    const s = section.summary;
    console.log(`  ${section.name}: ${s ? `${s.total} blocks, ${s.never} never run, ${s.unmeasured.length} not measured` : section.note}`);
  }
  if (given || argv.includes('--keep')) console.log(`Raw coverage and vectors kept in ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`coverage could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
