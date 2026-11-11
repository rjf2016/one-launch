// Replays five scripts through the real Electron app and diffs them against the expectations in the bundle.
//   node scripts/oracle/l2/cross-check.mjs [--out <folder>] [--no-build]
// Windows of the app open while it runs. It starts only the repo's own unpackaged build, on fake launchers and a scratch
// data folder, and ends each start by the process it spawned, never by image name.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { OUT_ENV, repoRoot, resolveOut } from '../lib/out.mjs';

function main(argv) {
  const out = resolveOut(argv);
  if (!argv.includes('--no-build')) {
    console.log('Building the unpackaged app (npx electron-vite build)');
    const build = spawnSync('npx electron-vite build', { cwd: repoRoot, stdio: 'inherit', shell: true });
    if (build.status !== 0) return build.status ?? 1;
  }
  const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(process.execPath, [vitest, 'run', '--config', 'scripts/oracle/vitest.config.ts', '--reporter', 'verbose'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, [OUT_ENV]: out, ORACLE_GENERATOR: 'scripts/oracle/l2/electron/cross-check.check.ts' },
  });
  return run.status ?? 1;
}

process.exitCode = main(process.argv.slice(2));
