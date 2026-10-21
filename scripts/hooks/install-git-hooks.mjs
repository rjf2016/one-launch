// postinstall: points git at .githooks/ so every commit runs the secret scan. Does nothing outside a git checkout of
// this repo, and leaves a hooks path someone set on purpose alone.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

let top;
try {
  top = path.resolve(git('rev-parse', '--show-toplevel'));
} catch {
  process.exit(0);
}
if (top.toLowerCase() !== root.toLowerCase()) process.exit(0);

let current = '';
try {
  current = git('config', '--get', 'core.hooksPath');
} catch {
  current = '';
}
if (current === '.githooks') process.exit(0);
if (current) {
  console.warn(`git core.hooksPath is ${current}; the secret scan in .githooks/pre-commit will not run. Set it to .githooks.`);
  process.exit(0);
}
git('config', '--local', 'core.hooksPath', '.githooks');
console.log('git hooks: core.hooksPath set to .githooks (secret scan before every commit)');
