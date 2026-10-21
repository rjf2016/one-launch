import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'hooks', 'no-secrets.mjs');
const MODULE = pathToFileURL(SCRIPT).href;

/** scripts/hooks/no-secrets.mjs is plain JavaScript outside the typed tree, so a child Node scans the lines and reports the rule ids only. */
function rules(lines: string[], { allow = [] as string[], username = 'nobody-in-particular' } = {}): string[][] {
  const script = [
    `import { createScanner } from ${JSON.stringify(MODULE)};`,
    'const [lines, allow, username] = JSON.parse(process.argv[1]);',
    'const scan = createScanner({ allow: new Set(allow), username });',
    'console.log(JSON.stringify(lines.map((line) => scan(line).map((hit) => hit.rule))));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([lines, allow, username])], { encoding: 'utf8' });
  return JSON.parse(out) as string[][];
}

// Built at run time from a counter so no literal in this file trips the tree scan, and the same on every run.
let seed = 0;
const digest = () =>
  createHash('sha512')
    .update(`no-secrets ${(seed += 1)}`)
    .digest();
const hex = (bytes: number) => digest().subarray(0, bytes).toString('hex');
const b64 = (bytes: number) => digest().subarray(0, bytes).toString('base64url');
const uuid = () => hex(16).replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
const at = (local: string, domain: string) => [local, domain].join('@');
const users = (drive: string, sep: string, name: string) => [drive, 'Users', name, 'AppData'].join(sep);
const quote = (prefix: string, mark: string, value: string) => [prefix, mark, value, mark].join('');
const steamId = () => ['7656119', '8047193526'].join('');
const jwt = () =>
  [
    Buffer.from('{"alg":"RS256","kid":"s1"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: uuid(), exp: 1_900_000_000 })).toString('base64url'),
    b64(64),
  ].join('.');

describe('no-secrets: the rules', () => {
  it('flag real-looking ids, tokens, keys, emails and user folders', () => {
    const lines = [
      `"accountId": "${hex(16)}"`,
      `sha = ${hex(32)}`,
      `id: ${uuid()}`,
      `SteamID ${steamId()}`,
      `token ${jwt()}`,
      `refresh_token=${b64(30)}`,
      `"password": "${b64(18)}"`,
      `Authorization: Bearer ${b64(30)}`,
      quote('"password": ', '"', [b64(6), b64(6), b64(6)].join('!$') + '#'),
      quote('password = ', "'", ["pa\\'ss", b64(9), b64(6)].join('!')),
      quote('"Authorization": ', '"', ['Bearer ', b64(15), '!#'].join('')),
      ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
      `mail ${at('jordan.lee', 'gmail.com')}`,
      `dir ${users('C:', '\\', 'Jordan')}`,
      `dir ${users('C:', '\\\\', 'Jordan')}`,
      `dir ${users('/c', '/', 'jordan')}`,
      `signed in as Quinlan`,
    ];
    expect(rules(lines, { username: 'Quinlan' })).toEqual([
      ['hex32'],
      ['hex64'],
      ['uuid'],
      ['steamid64'],
      ['jwt'],
      ['token-key'],
      ['token-key'],
      ['token-key'],
      ['token-key'],
      ['token-key'],
      ['token-key'],
      ['private-key'],
      ['email'],
      ['user-folder'],
      ['user-folder'],
      ['user-folder'],
      ['username'],
    ]);
  });

  it('let placeholders through: runs, repeats, few distinct characters, placeholder words, reserved domains, template folders', () => {
    const lines = [
      `"accountId": "${'0'.repeat(31)}a"`,
      `"accountId": "${'ab12cd34'.repeat(4)}"`,
      `"accountId": "${hex(16)
        .replace(/[^0-9]/g, '7')
        .replace(/[2-9]/g, '1')}"`,
      `fake id ${hex(16)}`,
      `const placeholderId = '${uuid()}';`,
      `SteamID 7656119${'8000000001'}`,
      `refresh_token=placeholder${b64(20)}`,
      `refresh_token=${b64(10)}`,
      `const password = expectNullableString(body['password'], 'password', 64);`,
      `password: 'Saved encrypted with Windows DPAPI, never shown again!',`,
      `"password": "${b64(6)}!#$"`,
      `mail ${at('some.one+tag', 'example.co.uk')} ${at('a', 'example.com')} ${at('dev', 'host.invalid')}`,
      `author ${at('12345+someone', 'users.noreply.github.com')} remote ${at('git', 'github.com')}:o/r.git`,
      `dir ${users('C:', '\\', 'someone')} ${users('C:', '\\', 'Public')} ${users('C:', '/', '<you>')} ${users('C:', '\\', '%USERNAME%')}`,
      `dir ${users('C:', '\\', '[USER]')} ${users('C:', '\\', 'Default')}`,
      'react@18.3.1 and @scope/pkg@1.2.3',
      'signed in as Quinlan',
    ];
    expect(rules(lines, { username: 'admin' })).toEqual(lines.map(() => []));
  });

  it('let an allowlisted value through and nothing else on the line', () => {
    const listed = hex(16);
    expect(rules([`${listed} ${hex(16)}`], { allow: [listed] })).toEqual([['hex32']]);
    expect(rules([`dir ${users('C:', '\\', 'jo')}`], { allow: ['jo'] })).toEqual([[]]);
  });

  it('ignore a running user name that is short or generic', () => {
    expect(rules(['Bob ran the admin tool as runneradmin'], { username: 'Bob' })).toEqual([[]]);
    expect(rules(['the runneradmin user'], { username: 'runneradmin' })).toEqual([[]]);
  });
});

describe('no-secrets: the tree and the hooks', () => {
  const repo = mkdtempSync(join(tmpdir(), 'onelaunch-no-secrets-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', `user.email=${at('t', 'example.com')}`, ...args], { cwd: repo, encoding: 'utf8' });
  const run = (args: string[], input = '') => {
    const out = spawnSync(process.execPath, [join(repo, 'scripts', 'hooks', 'no-secrets.mjs'), ...args], { cwd: repo, input, encoding: 'utf8' });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  };
  const pretool = (command: string) => run(['--pretool'], JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));

  mkdirSync(join(repo, 'scripts', 'hooks'), { recursive: true });
  copyFileSync(SCRIPT, join(repo, 'scripts', 'hooks', 'no-secrets.mjs'));
  git('init', '-q');
  writeFileSync(join(repo, 'notes.txt'), 'nothing here\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  it('passes on every tracked file of this repo', () => {
    const out = spawnSync(process.execPath, [SCRIPT, '--all'], { cwd: ROOT, encoding: 'utf8' });
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
  });

  it('--staged refuses a staged secret and names the file, line and rule with the value masked', () => {
    const secret = hex(16);
    writeFileSync(join(repo, 'staged.txt'), `ok\naccount ${secret}\n`);
    git('add', 'staged.txt');
    const out = run(['--staged']);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(`staged.txt:2  hex32  ${secret.slice(0, 4)}…${secret.slice(-2)}`);
    expect(out.stderr + out.stdout).not.toContain(secret);
    git('reset', '-q', 'staged.txt');
    rmSync(join(repo, 'staged.txt'));
    expect(run(['--staged']).status).toBe(0);
  });

  it('--staged reads an added line that starts with "++ " as content, not as a file header', () => {
    const first = hex(16);
    const second = hex(16);
    writeFileSync(join(repo, 'plus.txt'), `++ ${first}\naccount ${second}\n`);
    git('add', 'plus.txt');
    const out = run(['--staged']);
    expect(out.stderr).toContain('plus.txt:1  hex32');
    expect(out.stderr).toContain('plus.txt:2  hex32');
    expect(out.stderr + out.stdout).not.toContain(first);
    git('reset', '-q', 'plus.txt');
    rmSync(join(repo, 'plus.txt'));
  });

  it('--pretool lets a clean commit and other commands through, and bad JSON', () => {
    expect(pretool('git commit -m "x"').status).toBe(0);
    writeFileSync(join(repo, 'notes.txt'), `nothing here\n${uuid()}\n`);
    expect(pretool('git status').status).toBe(0);
    expect(run(['--pretool'], 'not json').status).toBe(0);
    git('checkout', '-q', '--', 'notes.txt');
  });

  it('--pretool blocks with exit 2 whatever the commit could pick up: staged, changed, or untracked and added in the same command', () => {
    const changed = uuid();
    writeFileSync(join(repo, 'notes.txt'), `nothing here\n${changed}\n`);
    const pathspec = pretool('git commit --no-verify -m "x" -- notes.txt');
    expect(pathspec.status).toBe(2);
    expect(pathspec.stderr).toContain('notes.txt:2  uuid');
    expect(pathspec.stderr).not.toContain(changed);
    git('add', 'notes.txt');
    expect(pretool('git commit -m "x"').status).toBe(2);
    git('reset', '-q', '--hard');

    const fresh = hex(16);
    writeFileSync(join(repo, 'fresh.txt'), `id ${fresh}\n`);
    const added = pretool('git add fresh.txt && git commit --no-verify -m "x"');
    expect(added.status).toBe(2);
    expect(added.stderr).toContain('fresh.txt:1  hex32');
    expect(added.stderr).not.toContain(fresh);
    rmSync(join(repo, 'fresh.txt'));
    expect(pretool('git commit -m "x"').status).toBe(0);
  });
});

describe('install-git-hooks (postinstall)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onelaunch-hooks-path-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function checkout(name: string, globalConfig: string) {
    const repo = join(dir, name);
    mkdirSync(join(repo, 'scripts', 'hooks'), { recursive: true });
    copyFileSync(join(ROOT, 'scripts', 'hooks', 'install-git-hooks.mjs'), join(repo, 'scripts', 'hooks', 'install-git-hooks.mjs'));
    const global = join(dir, `${name}.gitconfig`);
    writeFileSync(global, globalConfig);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    const install = () => spawnSync(process.execPath, [join(repo, 'scripts', 'hooks', 'install-git-hooks.mjs')], { cwd: repo, env, encoding: 'utf8' });
    const local = () => spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo, env, encoding: 'utf8' }).stdout.trim();
    return { install, local };
  }

  it('sets core.hooksPath=.githooks locally when no scope sets a hooks path', () => {
    const { install, local } = checkout('plain', '');
    expect(install().status).toBe(0);
    expect(local()).toBe('.githooks');
  });

  it('leaves a hooks path set in the global config alone and says so', () => {
    const { install, local } = checkout('global', '[core]\n\thooksPath = elsewhere\n');
    const out = install();
    expect(out.status).toBe(0);
    expect(out.stderr).toContain('core.hooksPath is elsewhere');
    expect(local()).toBe('');
  });
});
