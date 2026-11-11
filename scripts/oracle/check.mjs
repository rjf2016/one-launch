import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORACLE_CLOCK } from './lib/clock.mjs';
import { repoRoot } from './lib/out.mjs';

const MIRRORS = 'npm run typecheck && npm run lint && vitest run';
const CONFIG = 'scripts/oracle/check.vitest.config.ts';

function main() {
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (scripts.check !== MIRRORS) {
    console.error(`package.json's check script is no longer "${MIRRORS}". Bring check.mjs in line with it first.`);
    return 2;
  }
  const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const steps = [
    ['typecheck', () => spawnSync('npm run typecheck', { cwd: repoRoot, stdio: 'inherit', shell: true })],
    ['lint', () => spawnSync('npm run lint', { cwd: repoRoot, stdio: 'inherit', shell: true })],
    ['tests', () => spawnSync(process.execPath, [vitest, 'run', '--config', CONFIG], { cwd: repoRoot, stdio: 'inherit' })],
  ];
  console.log(`npm run check, with the test clock started at ${ORACLE_CLOCK}`);
  for (const [name, run] of steps) {
    const status = run().status ?? 1;
    if (status !== 0) {
      console.error(`check failed at: ${name}`);
      return status;
    }
  }
  console.log(`check passed with the oracle clock at ${ORACLE_CLOCK}.`);
  return 0;
}

process.exitCode = main();
