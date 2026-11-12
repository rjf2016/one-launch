import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../lib/out.mjs';

export const CHECKLIST = 'SCREENSHOTS.md';
export const DEFAULT_SIZE = [1280, 800];
export const MIN_SIZE = [960, 600];
export const SHOTS_DIR = 'ui/shots';
export const STATUS_FILE = 'ui/status.json';
export const areaFile = (area) => join(repoRoot, 'scripts', 'scenarios', `oracle-shots-${area}.mjs`);
export const repeatRecord = (area) => `ui/repeat/${area}.json`;

export const AREAS = {
  'shell-library': { title: 'Shell and Library', from: 1, to: 29 },
  accounts: { title: 'Accounts, account detail and the import dialog', from: 30, to: 65 },
  launch: { title: 'Launch dialog and banner', from: 66, to: 100 },
  dialogs: { title: "Confirm, Recovery, Setup guide and What's New", from: 101, to: 120 },
  settings: { title: 'Settings', from: 121, to: 163 },
};

const MIN_ONLY = new Set([9]);

const OWNER = {
  164: 'a native message box, which CDP cannot capture',
  165: 'a native message box, and reaching it needs a throw from main',
  166: 'a native error box of the exe on a broken data folder',
  167: 'a native file picker',
  168: 'a native file picker',
  169: 'the tray icon menu, drawn by Windows',
  170: 'the taskbar and tray with the window hidden: a desktop shot',
  171: 'the installer pages; an installer never runs on this PC',
  172: 'SmartScreen on a freshly downloaded installer',
  173: 'Windows Settings › Apps › Startup, with the installed app',
  174: 'the uninstaller of the installed app',
};

export function areaOf(id) {
  return Object.entries(AREAS).find(([, range]) => id >= range.from && id <= range.to)?.[0] ?? null;
}

export function readRows(out) {
  const rows = [];
  let section = '';
  for (const line of readFileSync(join(out, CHECKLIST), 'utf8').split(/\r?\n/)) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) section = heading[1];
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 6 || !/^\d+$/.test(cells[1])) continue;
    const id = Number(cells[1]);
    const names = [...cells[2].matchAll(/`([a-z0-9-]+)\.png`/g)].map((m) => m[1]);
    if (names.length === 0) throw new Error(`${CHECKLIST}: row ${id} names no file`);
    rows.push({ id, section, names, name: names[0], min: cells[2].includes('`+960`'), state: cells[3], area: areaOf(id), owner: OWNER[id] ?? null });
  }
  rows.forEach((row, i) => {
    if (row.id !== i + 1) throw new Error(`${CHECKLIST}: row ${row.id} is out of order`);
  });
  return rows;
}

export function sizesOf(row) {
  if (MIN_ONLY.has(row.id)) return [{ size: MIN_SIZE, suffix: '' }];
  return [{ size: DEFAULT_SIZE, suffix: '' }, ...(row.min ? [{ size: MIN_SIZE, suffix: '-960' }] : [])];
}

export const stemOf = (row, suffix = '') => `${String(row.id).padStart(3, '0')}-${row.name}${suffix}`;

export function filesOf(row) {
  return sizesOf(row).map(({ size, suffix }) => ({
    size,
    png: `${SHOTS_DIR}/${stemOf(row, suffix)}.png`,
    sidecar: `${SHOTS_DIR}/${stemOf(row, suffix)}.layout.json`,
  }));
}
