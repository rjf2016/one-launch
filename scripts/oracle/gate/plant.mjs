// Plants one difference per layer in a scratch worktree of this checkout and shows that the comparison with the bundle catches it.
//   node scripts/oracle/gate/plant.mjs [--only=<name>,<name>] [--keep] [--out <bundle>]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { jsonText, resolveOut } from '../lib/out.mjs';
import { PASSING, compareTrees, describe } from './compare.mjs';
import { HOME, buildApp, gateScratch, headOf, isUntouchedSeed, option, runStep, seed } from './run.mjs';

const GENERATE = 'scripts/oracle/generate.mjs';
const LINKED = ['node_modules'];
// Inputs of the assets generator that git ignores.
const COPIED = ['build/license.txt', 'build/THIRD-PARTY-NOTICES.txt', 'dist/.icon-ico/icon.ico'];
const SHOT = { label: 'the empty Library shot', script: 'scripts/oracle/ui/capture.mjs', args: ['shell-library', '--only=no-games', '--no-build'], app: true };
const EMPTY_LIBRARY = 'ui/shots/013-library-no-games.layout.json';

function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`expected exactly one ${JSON.stringify(from)}`);
  return text.replace(from, () => to);
}

function swapRegistryWrites(text) {
  const user = "          mark(STEP.registryUser, 'running');\n";
  const remember = "          mark(STEP.registryRemember, 'running');\n";
  const after = '        }\n\n        let previous = ';
  for (const marker of [user, remember, after]) if (text.split(marker).length !== 2) throw new Error(`expected exactly one ${JSON.stringify(marker)}`);
  const [a, b, end] = [text.indexOf(user), text.indexOf(remember), text.indexOf(after)];
  if (!(a < b && b < end)) throw new Error('the two registry writes are not where they were');
  const first = text.slice(a, b).replace(/\n\n$/, '\n');
  return `${text.slice(0, a)}${text.slice(b, end)}\n${first}${text.slice(end)}`;
}

const PLANTS = [
  {
    name: 'vector',
    what: 'one changed vector output: compareVersions ranks a release below its own pre-release',
    file: 'src/shared/whats-new.ts',
    change: (text) => replaceOnce(text, 'return pa.pre.length === 0 ? 1 : -1;', 'return pa.pre.length === 0 ? -1 : 1;'),
    steps: [{ label: 'core vectors', script: GENERATE, args: ['l1/core'] }],
    expect: ['l1/core/compareVersions.json'],
  },
  {
    name: 'platform-order',
    what: 'one reordered platform operation: the Steam switch writes RememberPassword before AutoLoginUser',
    file: 'src/main/launchers/steam/adapter.ts',
    change: swapRegistryWrites,
    steps: [
      { label: 'replay of play-steam', script: GENERATE, args: ['l2/replay/play-steam'] },
      { label: 'replay of play-all', script: GENERATE, args: ['l2/replay/play-all'] },
    ],
    expect: ['l2/expected/play-steam.json', 'l2/expected/play-all.json'],
    electron: 'play-all',
  },
  {
    name: 'moved-box',
    what: 'one moved box: the sidebar links start 8 px lower',
    file: 'src/renderer/src/components/Sidebar.tsx',
    change: (text) => replaceOnce(text, 'flex flex-col gap-1.5 px-2 pt-5', 'flex flex-col gap-1.5 px-2 pt-7'),
    seeds: ['SCREENSHOTS.md'],
    steps: [SHOT],
    expect: [EMPTY_LIBRARY],
  },
  {
    name: 'string',
    what: 'one changed string: the empty Library says "after a rescan" for "after a scan"',
    file: 'src/renderer/src/views/LibraryView.tsx',
    change: (text) => replaceOnce(text, 'games appear here after a scan.', 'games appear here after a rescan.'),
    seeds: ['SCREENSHOTS.md', 'ui/shots', 'l2/expected', 'assets/runtime.json'],
    steps: [SHOT, { label: 'copy inventory', script: GENERATE, args: ['assets'] }],
    expect: [EMPTY_LIBRARY, 'assets/copy.json'],
  },
];

const git = (cwd, ...args) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.trim()}`);
  return run.stdout.trim();
};

// A junction is taken off with rmdir, which never follows it; a recursive delete of the worktree would empty its target.
function unlink(tree) {
  for (const name of LINKED) {
    const at = join(tree, name);
    if (!existsSync(at)) continue;
    if (!lstatSync(at).isSymbolicLink()) throw new Error(`${at} is not a link; remove the worktree by hand`);
    rmdirSync(at);
    if (existsSync(at)) throw new Error(`${at} is still there`);
  }
}

function removeTree(tree) {
  if (!existsSync(tree)) return;
  unlink(tree);
  git(HOME, 'worktree', 'remove', '--force', tree);
}

function makeTree(tree) {
  removeTree(tree);
  git(HOME, 'worktree', 'prune');
  git(HOME, 'worktree', 'add', '--detach', tree, 'HEAD');
  for (const name of LINKED) symlinkSync(join(HOME, name), join(tree, name), 'junction');
  for (const path of COPIED) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    copyFileSync(join(HOME, path), join(tree, path));
  }
}

function electronReplay({ tree, bundle, out, name, logFile }) {
  rmSync(out, { recursive: true, force: true });
  seed(bundle, out, ['l2/scripts', 'l2/expected', 'l2/normalisation'], {});
  const step = { script: 'scripts/oracle/l2/cross-check.mjs', args: ['--no-build'], env: { ORACLE_L2_ONLY: name } };
  const done = runStep({ repo: tree, bundle, out, step, logFile });
  const counted = /(\d+) differences; not compared/.exec(readFileSync(logFile, 'utf8'));
  return { exit: done.exit, seconds: done.seconds, differences: counted ? Number(counted[1]) : null, log: logFile };
}

function phase({ tree, bundle, scratch, plant, kind }) {
  const out = join(scratch, 'planted', `${plant.name}-${kind}`);
  rmSync(out, { recursive: true, force: true });
  const seeds = {};
  seed(bundle, out, plant.seeds ?? [], seeds);
  const steps = [];
  for (const [i, step] of plant.steps.entries()) {
    const done = runStep({ repo: tree, bundle, out, step, logFile: join(scratch, 'logs', `plant-${plant.name}-${kind}-${i + 1}.log`) });
    steps.push({ label: step.label, ...done });
    console.log(`  ${done.exit === 0 ? 'RAN   ' : 'FAILED'}  ${kind}: ${step.label}  ${done.seconds} s`);
  }
  const { results } = compareTrees(bundle, out, { skip: isUntouchedSeed(out, seeds) });
  const differing = results.filter((result) => !PASSING.has(result.verdict));
  const electron = plant.electron
    ? electronReplay({
        tree,
        bundle,
        out: join(scratch, 'planted', `${plant.name}-${kind}-electron`),
        name: plant.electron,
        logFile: join(scratch, 'logs', `plant-${plant.name}-${kind}-electron.log`),
      })
    : null;
  if (electron)
    console.log(
      `  RAN     ${kind}: ${plant.electron} through Electron  ${electron.seconds} s  exit ${electron.exit}, ${electron.differences ?? 'unknown'} differences`,
    );
  return {
    steps,
    compared: results.length,
    differing: differing.map((result) => ({ path: result.path, verdict: result.verdict, detail: describe(result) })),
    electron,
  };
}

function main(argv) {
  const bundle = resolveOut(argv);
  const scratch = gateScratch();
  const tree = join(scratch, 'wt');
  const only = option(argv, 'only')?.split(',');
  const plants = PLANTS.filter((plant) => !only || only.includes(plant.name));
  if (only && plants.length !== only.length) throw new Error(`the plants are ${PLANTS.map((plant) => plant.name).join(', ')}`);
  console.log(`Planted differences against ${bundle}\nWorktree of ${headOf().slice(0, 7)}: ${tree}`);
  makeTree(tree);
  const report = [];
  let ok = true;
  try {
    let built = null;
    const build = (label) => {
      if (built === label) return;
      const made = buildApp({ repo: tree, logFile: join(scratch, 'logs', `plant-build-${label}.log`) });
      console.log(`  ${made.exit === 0 ? 'RAN   ' : 'FAILED'}  build (${label})  ${made.seconds} s`);
      if (made.exit !== 0) throw new Error(`the build failed; see ${made.log}`);
      built = label;
    };
    const needsApp = (plant) => Boolean(plant.electron) || plant.steps.some((step) => step.app);

    for (const plant of plants) {
      console.log(`\n${plant.name}: ${plant.what}`);
      if (needsApp(plant)) build('as committed');
      const control = phase({ tree, bundle, scratch, plant, kind: 'control' });
      const controlClean =
        control.steps.every((step) => step.exit === 0) &&
        control.differing.length === 0 &&
        (!control.electron || (control.electron.exit === 0 && control.electron.differences === 0));

      const file = join(tree, plant.file);
      const original = readFileSync(file, 'utf8');
      const changed = plant.change(original);
      if (changed === original) throw new Error(`${plant.name}: the change left ${plant.file} as it was`);
      let planted;
      try {
        writeFileSync(file, changed);
        if (needsApp(plant)) build(plant.name);
        planted = phase({ tree, bundle, scratch, plant, kind: 'planted' });
      } finally {
        writeFileSync(file, original);
      }
      if (git(tree, 'status', '--porcelain', '--', 'src') !== '') throw new Error(`${plant.name}: src/ of the worktree was not restored`);

      const found = new Set(planted.differing.map((item) => item.path));
      const missed = plant.expect.filter((path) => !found.has(path));
      const electronCaught = !planted.electron || (planted.electron.exit !== 0 && (planted.electron.differences ?? 0) > 0);
      const caught = missed.length === 0 && electronCaught;
      ok &&= controlClean && caught;
      report.push({ name: plant.name, what: plant.what, file: plant.file, expect: plant.expect, controlClean, caught, missed, control, planted });
      console.log(`  ${controlClean ? 'PASS' : 'FAIL'}  control: the worktree as committed differs nowhere (${control.compared} files compared)`);
      for (const item of control.differing) console.log(`        ${item.path}: ${item.detail.split('\n')[0]}`);
      console.log(`  ${caught ? 'PASS' : 'FAIL'}  planted: caught in ${planted.differing.length} of ${planted.compared} files`);
      for (const item of planted.differing) console.log(`        ${item.path}\n          ${item.detail.split('\n').join('\n          ')}`);
      for (const path of missed) console.log(`        NOT caught: ${path}`);
      if (planted.electron)
        console.log(
          `  ${electronCaught ? 'PASS' : 'FAIL'}  planted: ${plant.electron} through Electron no longer diffs to zero (${planted.electron.differences ?? 'unknown'} differences)`,
        );
    }
  } finally {
    writeFileSync(join(scratch, 'plant-report.json'), jsonText({ tooling: headOf(), bundle, plants: report }));
    if (!argv.includes('--keep')) removeTree(tree);
  }
  console.log(ok ? '\nevery planted difference was caught.' : '\na planted difference was NOT caught, or a control differed.');
  return ok ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`plant could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
