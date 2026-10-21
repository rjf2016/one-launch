// Pushes PR screenshots to the orphan branch pr-assets (one folder per PR branch) and prints the raw URLs for the PR body.
//   node scripts/pr-assets.mjs [--folder=<name>] <png> [<png>...]      (the folder defaults to the current branch)
// gh cannot upload attachments, so the repo keeps this branch; the body can embed the images before the PR number exists.
// Delete the folder once the PR lands. Works in a scratch repo, so the working tree and the current checkout are untouched.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BRANCH = 'pr-assets';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const args = process.argv.slice(2);
const unknown = args.find((a) => a.startsWith('--') && !a.startsWith('--folder='));
if (unknown) fail(`Unknown option ${unknown}. Usage: node scripts/pr-assets.mjs [--folder=<name>] <png>...`);
const folderArg = args.find((a) => a.startsWith('--folder='))?.slice('--folder='.length);
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) fail('Name at least one .png file.');
for (const file of files) {
  if (path.extname(file).toLowerCase() !== '.png') fail(`${file} is not a .png file.`);
  try {
    statSync(file);
  } catch {
    fail(`${file} does not exist.`);
  }
}

const root = process.cwd();
const folder = folderArg || git(['branch', '--show-current'], root);
if (!folder || folder === 'master' || folder === BRANCH) fail(`Run this on the PR branch, or pass --folder=<name> (the branch is "${folder}").`);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(folder)) fail(`Folder name "${folder}" must be letters, digits, dot, underscore or dash.`);
const remote = git(['remote', 'get-url', 'origin'], root);
const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
if (!match) fail(`origin is not a GitHub remote: ${remote}`);
const [, owner, repo] = match;
// The scratch repo commits as this repo does (a local user.email can be the GitHub noreply address that the push guard wants).
for (const [key, name] of [
  ['GIT_AUTHOR_NAME', 'user.name'],
  ['GIT_AUTHOR_EMAIL', 'user.email'],
  ['GIT_COMMITTER_NAME', 'user.name'],
  ['GIT_COMMITTER_EMAIL', 'user.email'],
]) {
  process.env[key] = git(['config', name], root);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'pr-assets-'));
try {
  git(['init', '-q', '-b', BRANCH], scratch);
  let exists = true;
  try {
    git(['fetch', '-q', remote, BRANCH], scratch);
  } catch {
    exists = false;
  }
  if (exists) git(['reset', '-q', '--hard', 'FETCH_HEAD'], scratch);
  const dest = path.join(scratch, folder);
  mkdirSync(dest, { recursive: true });
  const names = files.map((file) => {
    const name = path.basename(file);
    copyFileSync(file, path.join(dest, name));
    return name;
  });
  git(['add', '--', folder], scratch);
  if (!git(['status', '--porcelain'], scratch)) fail(`${BRANCH}/${folder} already holds these files unchanged.`);
  git(['commit', '-q', '-m', `${folder}: ${names.length} screenshot${names.length === 1 ? '' : 's'}`], scratch);
  git(['push', '-q', remote, `${BRANCH}:${BRANCH}`], scratch);
  for (const name of names) console.log(`https://github.com/${owner}/${repo}/blob/${BRANCH}/${folder}/${name}?raw=true`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
