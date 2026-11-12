import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot } from './paths.mjs';

export const KINDS = ['pure', 'stateful', 'adapter-flow', 'renderer', 'live', 'tooling'];
export const ADAPTER_SUITES = ['test/battlenet-adapter.test.ts', 'test/epic-adapter.test.ts', 'test/riot-adapter.test.ts', 'test/steam-adapter.test.ts'];
const LIVE_FILE = /^test\/[^/]+-live\.test\.ts$/;

const TOOLING_FILES = [
  'test/drive-args.test.ts',
  'test/drive-refusals.test.ts',
  'test/fake-scenario.test.ts',
  'test/no-secrets.test.ts',
  'test/third-party-notices.test.ts',
];

const PURE_FILES = [
  'test/artwork-url.test.ts',
  'test/battlenet-files.test.ts',
  'test/battlenet-product-state.test.ts',
  'test/epic-files.test.ts',
  'test/fs-path.test.ts',
  'test/ipc-contract.test.ts',
  'test/logger.test.ts',
  'test/phases.test.ts',
  'test/platform.test.ts',
  'test/recovery-copy.test.ts',
  'test/refusals.test.ts',
  'test/registry-dump.test.ts',
  'test/riot-client-log.test.ts',
  'test/riot-session.test.ts',
  'test/steam-bootstrap-log.test.ts',
  'test/steam-files.test.ts',
  'test/steam-login-log.test.ts',
  'test/steam-vdf.test.ts',
  'test/update-availability.test.ts',
  'test/update-manifest.test.ts',
  'test/wait.test.ts',
  'test/whats-new-markdown.test.ts',
  'test/whats-new.test.ts',
  'test/window-guard.test.ts',
];

// Within a pure file, the suites (and single tests) that write a folder, hold an object across calls, or run a timer.
const STATEFUL_PARTS = [
  { file: 'test/battlenet-files.test.ts', suite: ['client log', 'log files'] },
  { file: 'test/epic-files.test.ts', suite: ['launcher log', 'reading only what the launcher appends, across log rotation'] },
  { file: 'test/logger.test.ts', suite: ['account names'] },
  { file: 'test/logger.test.ts', suite: ['FileSink'] },
  { file: 'test/platform.test.ts', suite: ['static fakes'] },
  { file: 'test/platform.test.ts', suite: ['Phase 4 additions'] },
  { file: 'test/platform.test.ts', suite: ['isRunning, close and kill without WMI (S2)'] },
  { file: 'test/platform.test.ts', suite: ['output encoding (B5)'] },
  { file: 'test/platform.test.ts', suite: ['process listing without opening a process (S1)'] },
  { file: 'test/registry-dump.test.ts', name: /reg\.exe|static registry/ },
  { file: 'test/riot-client-log.test.ts', suite: ['Riot client log parser', 'log files'] },
  { file: 'test/steam-bootstrap-log.test.ts', suite: ['reading only what the updater appends'] },
  { file: 'test/steam-login-log.test.ts', suite: ['reading only what Steam appends'] },
  { file: 'test/update-manifest.test.ts', suite: ['installer hashing'] },
  { file: 'test/wait.test.ts', suite: ['sleep'] },
  { file: 'test/wait.test.ts', suite: ['waitUntil'] },
];

const PURE_PARTS = [{ file: 'test/update-service.test.ts', suite: ['describeUpdateError'] }];

const NATIVE = 'native-platform';
const WEB = 'web-only';
const TOOLING = 'tooling';

export const WAIVER_RULES = [
  { file: 'test/preload.test.ts', category: WEB, reason: 'The Electron preload bridge (contextBridge and ipcRenderer) has no counterpart in a native app.' },
  {
    file: 'test/renderer/use-ipc-query.test.tsx',
    category: WEB,
    reason: "The renderer's IPC client and React query hook exist only because the UI is a web page talking to the main process.",
  },
  {
    file: 'test/drive-args.test.ts',
    category: TOOLING,
    reason: "Tests the CDP driver's argument splitting (scripts/drive.mjs), repo tooling that does not ship.",
  },
  {
    file: 'test/drive-refusals.test.ts',
    category: TOOLING,
    reason: 'Tests what the CDP driver refuses to run (scripts/drive.mjs), repo tooling that does not ship.',
  },
  {
    file: 'test/no-secrets.test.ts',
    category: TOOLING,
    reason: "Tests this repo's secret-scan hook and its git-hook installer, which do not ship; the Rust repo carries its own gate.",
  },
  {
    file: 'test/third-party-notices.test.ts',
    category: TOOLING,
    reason: 'Tests the npm-specific notices script and the NSIS licence page, which the Rust build replaces.',
  },
  {
    file: 'test/fake-scenario.test.ts',
    category: TOOLING,
    reason: "Checks this repo's committed fake-launcher scenario folders for placeholders, a hygiene check on test data rather than app behaviour.",
  },
  {
    file: 'test/platform.test.ts',
    suite: ['parseRegQueryOutput'],
    category: NATIVE,
    reason: 'Parses reg.exe output, which a native registry layer never reads.',
  },
  {
    file: 'test/platform.test.ts',
    suite: ['parseDword'],
    category: NATIVE,
    reason: 'Parses a reg.exe REG_DWORD string, which a native registry layer never reads.',
  },
  {
    file: 'test/platform.test.ts',
    suite: ['parseProcessNames'],
    category: NATIVE,
    reason: 'Parses PowerShell process-list output, which a native process layer never reads.',
  },
  {
    file: 'test/platform.test.ts',
    suite: ['parseProcessControlResult'],
    category: NATIVE,
    reason: "Parses the PowerShell close and kill script's output, which a native process layer never reads.",
  },
  {
    file: 'test/platform.test.ts',
    suite: ['Phase 4 additions'],
    name: /reg\.exe|\/ve/,
    category: NATIVE,
    reason: 'Checks reg.exe command lines and output parsing, which a native registry layer replaces.',
  },
  {
    file: 'test/platform.test.ts',
    suite: ['isRunning, close and kill without WMI (S2)'],
    category: NATIVE,
    reason: 'Checks the PowerShell scripts and their output for process checks, close and kill, which a native process layer replaces.',
  },
  {
    file: 'test/platform.test.ts',
    suite: ['output encoding (B5)'],
    category: NATIVE,
    reason: 'Checks how reg.exe and PowerShell output is decoded from the console code page, which a native layer never meets.',
  },
  {
    file: 'test/platform.test.ts',
    suite: ['process listing without opening a process (S1)'],
    category: NATIVE,
    reason: 'Checks the PowerShell process-listing script, which a native process layer replaces.',
  },
  {
    file: 'test/registry-dump.test.ts',
    name: /^(?!the static registry)/,
    category: NATIVE,
    reason: 'Parses reg query dumps and checks reg.exe command lines, which a native registry layer replaces.',
  },
  {
    file: 'test/platform-write.test.ts',
    category: NATIVE,
    reason:
      'Checks the reg.exe and PowerShell command lines of registry writes and process starts, and the PowerShell JSON parser, which a native layer replaces.',
  },
  {
    file: 'test/clipboard-private.test.ts',
    category: NATIVE,
    reason: 'Checks the PowerShell child that writes the clipboard privately, which a native clipboard call replaces.',
  },
];

const startsWith = (suite, prefix) => prefix.every((title, i) => suite[i] === title);
const matches = (rule, test) =>
  rule.file === test.file && (rule.suite === undefined || startsWith(test.suite, rule.suite)) && (rule.name === undefined || rule.name.test(test.name));

export function environmentOf(file) {
  const head = readFileSync(join(repoRoot, file), 'utf8');
  const match = /@vitest-environment\s+([\w-]+)/.exec(head);
  const environment = match ? match[1] : 'node';
  if (environment !== 'node' && environment !== 'jsdom') throw new Error(`${file}: environment ${environment} is neither node nor jsdom`);
  return environment;
}

export function kindOf(test) {
  if (LIVE_FILE.test(test.file)) return 'live';
  if (test.environment === 'jsdom') return 'renderer';
  if (ADAPTER_SUITES.includes(test.file)) return 'adapter-flow';
  if (TOOLING_FILES.includes(test.file)) return 'tooling';
  if (PURE_FILES.includes(test.file)) return STATEFUL_PARTS.some((rule) => matches(rule, test)) ? 'stateful' : 'pure';
  return PURE_PARTS.some((rule) => matches(rule, test)) ? 'pure' : 'stateful';
}

export function waiverOf(test) {
  const rule = WAIVER_RULES.find((item) => matches(item, test));
  return rule ? { category: rule.category, reason: rule.reason } : null;
}

const slug = (file) =>
  file
    .replace(/^test\//, '')
    .replace(/\.test\.tsx?$/, '')
    .replace(/\//g, '.');

export const testKey = (test) => JSON.stringify([test.file, test.suite, test.name]);

export const testId = (test) => `T-${slug(test.file)}-${createHash('sha256').update(testKey(test), 'utf8').digest('hex').slice(0, 10)}`;

const STATUS = { passed: 'passed', skipped: 'skipped', pending: 'skipped', todo: 'todo' };

export function testsOf(report) {
  const files = report.testResults
    .map((result) => ({ file: relative(repoRoot, result.name).replace(/\\/g, '/'), result }))
    .sort((a, b) => (a.file < b.file ? -1 : 1));
  const tests = [];
  for (const { file, result } of files) {
    const environment = environmentOf(file);
    for (const item of result.assertionResults) {
      const status = STATUS[item.status];
      if (!status) throw new Error(`${file} › ${item.fullName}: status ${item.status}; a capture run must be green`);
      tests.push({ file, suite: item.ancestorTitles, name: item.title, environment, status });
    }
  }
  return tests;
}

export function duplicates(tests) {
  const seen = new Map();
  for (const test of tests) seen.set(testKey(test), (seen.get(testKey(test)) ?? 0) + 1);
  return [...seen].filter(([, count]) => count > 1).map(([key, count]) => `${key} x${count}`);
}
