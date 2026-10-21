// PostToolUse hook (.claude/settings.local.json): formats the file an Edit or Write just touched, so `npm run lint` never
// fails on formatting alone. Reads the hook's JSON from stdin, formats only a file inside this repo, and always exits 0.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const prettier = path.join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs');

let file;
try {
  file = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.file_path;
} catch {
  process.exit(0);
}
if (typeof file !== 'string' || !existsSync(prettier)) process.exit(0);

const target = path.resolve(file);
const inside = target.toLowerCase().startsWith((root + path.sep).toLowerCase());
if (!inside || !existsSync(target)) process.exit(0);

const shown = path.relative(root, target);
try {
  const out = execFileSync(process.execPath, [prettier, '--write', '--ignore-unknown', target], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  if (out.trim() && !out.includes('(unchanged)')) console.log(`prettier: ${shown}`);
} catch (error) {
  console.error(`prettier skipped ${shown}: ${String(error?.message ?? error).split(/\r?\n/)[0]}`);
}
