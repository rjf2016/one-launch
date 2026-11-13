import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveOut } from '../../lib/out.mjs';
import { createUserPathScanner } from '../../lib/user-paths.mjs';
import { pngSize, pngStats } from '../png.mjs';
import { STATUS_FILE } from '../rows.mjs';
import { NOT_PRODUCED, WAIVED } from './waived.mjs';

const OWNER_DIR = join('ui', 'owner');
const EXPECTED = {
  'window-chrome.png': { row: null, build: 'unpackaged', title: /^One Launch$/ },
  'native-file-picker-locate.png': { row: 167, build: 'unpackaged', title: /^Locate steam\.exe$/, buttons: ['Open', 'Cancel'] },
  'native-file-picker-image.png': { row: 168, build: 'unpackaged', title: /^Choose an image$/, buttons: ['Open', 'Cancel'] },
  'settings-updates-unavailable-custom-folder.png': { row: 131, build: 'packaged', title: /^One Launch$/, size: [1280, 800] },
  'native-startup-error.png': { row: 166, build: 'packaged', title: /^Error$/, buttons: ['OK'], message: /^One Launch could not start$/ },
  'native-quit-during-switch.png': { row: 164, build: 'unpackaged', title: /^A switch is still running$/, buttons: ['Keep running', 'Quit anyway'] },
  'native-crash-dialog.png': { row: 165, build: 'unpackaged', title: /^One Launch hit an unexpected error$/, buttons: ['Relaunch', 'Keep running'] },
};

function main(argv) {
  const folder = join(resolveOut(argv), OWNER_DIR);
  const results = [];
  const check = (name, run) => {
    const problems = [];
    run(problems);
    results.push({ name, problems });
  };
  let index = null;

  check('each of the seven PNGs exists, is a PNG, and is not one flat colour', (problems) => {
    for (const file of Object.keys(EXPECTED)) {
      const path = join(folder, file);
      if (!existsSync(path)) {
        problems.push(`${file}: missing`);
        continue;
      }
      try {
        const stats = pngStats(readFileSync(path));
        if (stats.colours < 4 || stats.dominant > 0.995) problems.push(`${file}: blank (${stats.colours} colours)`);
      } catch (err) {
        problems.push(`${file}: ${err.message}`);
      }
    }
  });

  check('captures.json parses and has one entry per PNG, each with its row, build, title and size', (problems) => {
    const path = join(folder, 'captures.json');
    try {
      index = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      problems.push(`captures.json: ${err.message}`);
      return;
    }
    const pngs = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith('.png')) : [];
    const entries = index.captures ?? [];
    for (const png of pngs) if (entries.filter((e) => e.file === png).length !== 1) problems.push(`${png}: not exactly one entry`);
    for (const entry of entries) {
      const want = EXPECTED[entry.file];
      if (!want) {
        problems.push(`${entry.file}: not one of the seven`);
        continue;
      }
      if (entry.row !== want.row) problems.push(`${entry.file}: row ${entry.row}, not ${want.row}`);
      if (entry.build !== want.build) problems.push(`${entry.file}: build ${entry.build}, not ${want.build}`);
      if (entry.capturedBy !== 'agent') problems.push(`${entry.file}: capturedBy ${entry.capturedBy}`);
      if (typeof entry.how !== 'string' || entry.how.length < 20) problems.push(`${entry.file}: no account of how the state was reached`);
      if (!want.title.test(entry.title ?? '')) problems.push(`${entry.file}: title ${JSON.stringify(entry.title)}`);
      if (want.buttons && JSON.stringify(entry.text?.buttons) !== JSON.stringify(want.buttons))
        problems.push(`${entry.file}: buttons ${JSON.stringify(entry.text?.buttons)}`);
      if (want.message && !want.message.test(entry.text?.message?.[0] ?? ''))
        problems.push(`${entry.file}: message ${JSON.stringify(entry.text?.message?.[0])}`);
      const path = join(folder, entry.file);
      if (!existsSync(path)) continue;
      const [width, height] = pngSize(readFileSync(path));
      if (entry.width !== width || entry.height !== height)
        problems.push(`${entry.file}: recorded ${entry.width}x${entry.height}, the PNG is ${width}x${height}`);
      if (want.size && (width !== want.size[0] || height !== want.size[1])) problems.push(`${entry.file}: ${width}x${height}, not ${want.size.join('x')}`);
    }
  });

  check('captures.json holds no absolute path, user folder, user name or host name', (problems) => {
    if (index === null) {
      problems.push('captures.json did not parse');
      return;
    }
    const text = JSON.stringify(index);
    for (const hit of createUserPathScanner().scanText(text)) problems.push(`${hit.kind} ${hit.masked}`);
    for (const match of text.matchAll(/\b[A-Za-z]:\\\\/g)) problems.push(`an absolute path at ${match.index}`);
  });

  check('each owner row of ui/status.json is captured here or waived by the owner, never both', (problems) => {
    if (index === null) {
      problems.push('captures.json did not parse');
      return;
    }
    const status = JSON.parse(readFileSync(join(resolveOut(argv), STATUS_FILE), 'utf8'));
    const owner = status.rows.filter((row) => row.status === 'owner').map((row) => row.id);
    const captured = (index.captures ?? []).map((entry) => entry.row).filter((row) => row !== null);
    const waived = index.waived ?? [];
    if (JSON.stringify(waived) !== JSON.stringify(WAIVED)) problems.push('the waived list is not the one in waived.mjs');
    if (JSON.stringify(index.notProduced ?? []) !== JSON.stringify(NOT_PRODUCED)) problems.push('the notProduced list is not the one in waived.mjs');
    for (const id of owner) {
      const hits = captured.filter((row) => row === id).length + waived.filter((entry) => entry.row === id).length;
      if (hits !== 1) problems.push(`row ${id}: ${hits === 0 ? 'neither captured nor waived' : 'both captured and waived'}`);
    }
    for (const id of [...captured, ...waived.map((entry) => entry.row)]) if (!owner.includes(id)) problems.push(`row ${id} is not an owner row`);
    for (const entry of waived)
      if (entry.waivedBy !== 'owner' || !entry.category || !entry.reason) problems.push(`row ${entry.row}: no owner, category or reason`);
    for (const entry of NOT_PRODUCED) if (existsSync(join(resolveOut(argv), entry.file))) problems.push(`${entry.file} exists`);
  });

  for (const { name, problems } of results) {
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${name}`);
    for (const problem of problems) console.log(`      ${problem}`);
  }
  return results.every((r) => r.problems.length === 0) ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
