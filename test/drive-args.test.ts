import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DRIVER = pathToFileURL(join(ROOT, 'scripts', 'app-driver.mjs')).href;

/** scripts/app-driver.mjs is plain JavaScript outside the typed tree, so a child Node runs the splitter and reports JSON. */
function split(...texts: string[]): { results: string[][]; error: string } {
  const script = [
    `import { splitSwitches } from ${JSON.stringify(DRIVER)};`,
    'const out = [];',
    'for (const text of process.argv.slice(1)) {',
    '  try { out.push(splitSwitches(text)); } catch (err) { console.error(err.message); process.exit(1); }',
    '}',
    'console.log(JSON.stringify(out));',
  ].join('\n');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', ...texts], { cwd: ROOT, encoding: 'utf8' });
  return { results: out.status === 0 ? (JSON.parse(out.stdout) as string[][]) : [], error: out.stderr.trim() };
}

describe('--args splitting (splitSwitches)', () => {
  it('separates switches on whitespace and leaves Windows paths as typed', () => {
    const { results } = split(
      '--trace-startup=devtools.timeline,v8 --trace-startup-file=C:\\traces\\startup.json',
      '  --trace-startup-duration=2\t--no-sandbox  ',
    );
    expect(results).toEqual([
      ['--trace-startup=devtools.timeline,v8', '--trace-startup-file=C:\\traces\\startup.json'],
      ['--trace-startup-duration=2', '--no-sandbox'],
    ]);
  });

  it('keeps a quoted path with spaces in one switch and drops the quotes', () => {
    const { results } = split(
      '--trace-startup-file="C:\\trace files\\startup.json" --trace-startup-duration=2',
      "--trace-startup-file='C:\\trace files\\startup.json'",
      '"--trace-startup-file=C:\\trace files\\startup.json"',
      '--a="" --b',
    );
    expect(results).toEqual([
      ['--trace-startup-file=C:\\trace files\\startup.json', '--trace-startup-duration=2'],
      ['--trace-startup-file=C:\\trace files\\startup.json'],
      ['--trace-startup-file=C:\\trace files\\startup.json'],
      ['--a=', '--b'],
    ]);
  });

  it('rejects an unclosed quote', () => {
    const { results, error } = split('--trace-startup-file="C:\\trace files\\startup.json');
    expect(results).toEqual([]);
    expect(error).toContain('--args has an unclosed " quote');
  });

  it('drive.mjs refuses an unclosed quote before it starts anything', () => {
    const out = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'drive.mjs'), 'scripts/scenarios/views.mjs', '--args=--trace-startup-file="C:\\trace files'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    );
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('--args has an unclosed " quote');
  });
});
