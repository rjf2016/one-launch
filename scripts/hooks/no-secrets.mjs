// Refuses commits that would put a secret, a real account id, an email, or a user folder name into git history.
// --staged scans the lines a commit adds (the git pre-commit hook), --all every tracked text file (CI), and --pretool
// reads a Claude PreToolUse hook's JSON from stdin and runs the staged scan before a `git commit`, exiting 2 to block it.
// Findings name the rule, file and line with the value masked; this script never prints a whole match.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const ALLOW_FILE = 'scripts/hooks/no-secrets.allow';

const PLACEHOLDER_WORD = /placeholder|fake|dummy|example|sample|(?<![a-z])test(?![a-z])/i;
const SAFE_EMAIL_DOMAIN = /(?:^|\.)(?:example(?:\.[a-z]+)+|users\.noreply\.github\.com|[^.]+\.(?:example|invalid|test|localhost))$/i;
const SAFE_USER_FOLDERS = new Set(['someone', 'placeholder', 'public', 'default']);
const GENERIC_USERNAMES = new Set(['user', 'admin', 'administrator', 'runneradmin', 'runner', 'someone', 'public', 'default']);
const STEAM_BASE = '7656119';

function isPeriodic(value) {
  for (let p = 1; p <= Math.min(16, value.length / 2); p += 1) {
    if (value.slice(p) === value.slice(0, value.length - p)) return true;
  }
  return false;
}

export function isSynthetic(value, line = '') {
  if (/(.)\1{5}/.test(value) || isPeriodic(value.toLowerCase())) return true;
  if (new Set(value.replace(/-/g, '').toLowerCase()).size <= 3) return true;
  return PLACEHOLDER_WORD.test(value) || PLACEHOLDER_WORD.test(line);
}

export function mask(value) {
  return value.length >= 12 ? `${value.slice(0, 4)}…${value.slice(-2)}` : `${value[0]}…(${value.length} chars)`;
}

const RULES = [
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    value: (m) => m[0],
  },
  {
    id: 'jwt',
    pattern: /eyJ[\w-]{10,}\.[\w-]{10,}(?:\.[\w-]*)?/g,
    value: (m) => m[0],
  },
  {
    id: 'token-key',
    pattern:
      /(?<![\w-])(refresh_token|access_token|id_token|ssid|clid|web_token|authorization|password)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?([\w.~+/=-]{20,})/gi,
    value: (m, line) => (line[m.index + m[0].length] === '(' || isSynthetic(m[2], line) ? null : m[2]),
  },
  {
    id: 'email',
    pattern: /[\w.%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![\w-])/g,
    value: (m) => (m[0] === 'git@github.com' || SAFE_EMAIL_DOMAIN.test(m[1]) ? null : m[0]),
  },
  {
    id: 'steamid64',
    pattern: new RegExp(`(?<!\\d)${STEAM_BASE}(\\d{10})(?!\\d)`, 'g'),
    value: (m, line) => (isSynthetic(m[1], line) ? null : m[0]),
  },
  {
    id: 'uuid',
    pattern: /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/gi,
    value: (m, line) => (isSynthetic(m[0], line) ? null : m[0]),
  },
  {
    id: 'hex64',
    pattern: /(?<![0-9A-Za-z])[0-9a-f]{64}(?![0-9A-Za-z])/gi,
    value: (m, line) => (isSynthetic(m[0], line) ? null : m[0]),
  },
  {
    id: 'hex32',
    pattern: /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/gi,
    value: (m, line) => (isSynthetic(m[0], line) ? null : m[0]),
  },
  {
    id: 'user-folder',
    pattern: /(?:\b[A-Za-z]:|(?<![\w.])\/[a-z])[\\/]{1,2}Users[\\/]{1,2}([^\\/\s"'`*?|:;,)\]]+)/gi,
    value: (m) => {
      const name = m[1];
      if (/^[<%${[]/.test(name) || SAFE_USER_FOLDERS.has(name.toLowerCase())) return null;
      return name;
    },
  },
];

function usernameRule(username) {
  if (!username || username.length < 4 || GENERIC_USERNAMES.has(username.toLowerCase())) return null;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { id: 'username', pattern: new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi'), value: (m) => m[0] };
}

function currentUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? '';
  }
}

export function loadAllowlist(file = path.join(root, ALLOW_FILE)) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

export function createScanner({ allow = loadAllowlist(), username = currentUsername() } = {}) {
  const rules = [...RULES];
  const own = usernameRule(username);
  if (own) rules.push(own);
  return function scanLine(text) {
    const found = [];
    const taken = [];
    for (const rule of rules) {
      for (const m of text.matchAll(rule.pattern)) {
        const start = m.index;
        const end = start + m[0].length;
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        const value = rule.value(m, text);
        if (value === null) {
          if (rule.id !== 'email' && rule.id !== 'user-folder') taken.push([start, end]);
          continue;
        }
        taken.push([start, end]);
        if (!allow.has(value)) found.push({ rule: rule.id, value });
      }
    }
    return found;
  };
}

export function isExcluded(file) {
  const f = file.replace(/\\/g, '/');
  if (f === 'package-lock.json' || f.endsWith('/package-lock.json')) return true;
  if (/^test\/fixtures\/(?:.*\/)?[^/]*\.real\.[^/]*$/.test(f)) return true;
  return /\.(?:png|ico|jpe?g|gif|webp|bmp|icns|woff2?|ttf|otf|zip|7z|exe|dll|node|db|sqlite)$/i.test(f);
}

function git(args) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function addedLines(diff) {
  const out = [];
  let file = null;
  let line = 0;
  let inHeader = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (raw.startsWith('+++ ')) {
        const target = raw.slice(4).trim();
        file = target === '/dev/null' ? null : target.replace(/^b\//, '');
        continue;
      }
      if (!raw.startsWith('@@ ')) continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      inHeader = false;
      continue;
    }
    if (file && raw.startsWith('+')) {
      out.push({ file, line, text: raw.slice(1).replace(/\r$/, '') });
      line += 1;
    }
  }
  return out;
}

export function scanEntries(entries, scanLine = createScanner()) {
  const findings = [];
  for (const { file, line, text } of entries) {
    if (isExcluded(file)) continue;
    for (const hit of scanLine(text)) findings.push({ file, line, ...hit });
  }
  return findings;
}

const DIFF = ['--no-color', '--no-ext-diff', '-U0', '--diff-filter=ACMR'];

export function scanStaged({ includeWorkingTree = false } = {}) {
  let entries = addedLines(git(['diff', '--cached', ...DIFF]));
  if (includeWorkingTree) entries = entries.concat(addedLines(git(['diff', ...DIFF])));
  return scanEntries(entries);
}

export function scanTracked() {
  const scanLine = createScanner();
  const findings = [];
  for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    if (isExcluded(file)) continue;
    let buf;
    try {
      buf = readFileSync(path.join(root, file));
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const entries = buf
      .toString('utf8')
      .split('\n')
      .map((text, i) => ({ file, line: i + 1, text: text.replace(/\r$/, '') }));
    findings.push(...scanEntries(entries, scanLine));
  }
  return findings;
}

export function report(findings) {
  const lines = findings.map((f) => `  ${f.file}:${f.line}  ${f.rule}  ${mask(f.value)}`);
  return [
    `no-secrets: ${findings.length} value(s) that look like a secret, a real id, an email or a user name:`,
    ...lines,
    'Replace each with a placeholder of the same shape. If one already is a placeholder on purpose, add the exact',
    `value to ${ALLOW_FILE} under a comment saying what it is; that is the moment to ask whether it is real.`,
  ].join('\n');
}

function wantsWorkingTree(command) {
  const after = command.slice(command.search(/\bcommit\b/));
  return /(?:^|\s)(?:-[A-Za-z]*a[A-Za-z]*|--all)(?=\s|$)/.test(after);
}

function main(argv) {
  const mode = argv[0];
  if (mode === '--pretool') {
    let command;
    try {
      command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command;
    } catch {
      return 0;
    }
    if (typeof command !== 'string' || !/\bgit\b[\s\S]*\bcommit\b/.test(command)) return 0;
    let findings;
    try {
      findings = scanStaged({ includeWorkingTree: wantsWorkingTree(command) });
    } catch (error) {
      console.error(`no-secrets could not read the staged changes: ${String(error?.message ?? error).split(/\r?\n/)[0]}`);
      return 2;
    }
    if (findings.length === 0) return 0;
    console.error(`Commit blocked.\n${report(findings)}`);
    return 2;
  }
  if (mode !== '--staged' && mode !== '--all') {
    console.error('usage: node scripts/hooks/no-secrets.mjs --staged | --all | --pretool');
    return 2;
  }
  const findings = mode === '--all' ? scanTracked() : scanStaged();
  if (findings.length === 0) return 0;
  console.error(report(findings));
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
