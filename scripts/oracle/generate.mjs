import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_ENV, repoRoot, resolveOut } from './lib/out.mjs';

function main(argv) {
  const out = resolveOut(argv);
  const skip = argv.indexOf('--out');
  const names = argv.filter((arg, i) => !arg.startsWith('--') && (skip === -1 || i !== skip + 1));
  if (names.length !== 1) {
    console.error('usage: node scripts/oracle/generate.mjs <folder or generator under scripts/oracle> [--out <folder>]');
    return 2;
  }
  const target = names[0].replace(/\\/g, '/').replace(/\/+$/, '');
  if (target.split('/').some((part) => part === '..' || part === '')) {
    console.error(`Not a path under scripts/oracle: ${names[0]}`);
    return 2;
  }
  const base = join(repoRoot, 'scripts', 'oracle', target);
  let include;
  if (existsSync(`${base}.gen.ts`)) include = `scripts/oracle/${target}.gen.ts`;
  else if (existsSync(base) && statSync(base).isDirectory()) include = `scripts/oracle/${target}/**/*.gen.ts`;
  else {
    console.error(`No generator at scripts/oracle/${target}.gen.ts and no folder scripts/oracle/${target}.`);
    return 2;
  }
  console.log(`Generating ${include} into ${out}`);
  const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(process.execPath, [vitest, 'run', '--config', 'scripts/oracle/vitest.config.ts'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, [OUT_ENV]: out, ORACLE_GENERATOR: include },
  });
  return run.status ?? 1;
}

process.exitCode = main(process.argv.slice(2));
