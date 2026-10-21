import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const outside = mkdtempSync(join(tmpdir(), 'onelaunch-drive-refusal-'));
const marker = join(outside, 'ran.txt');
const planted = join(outside, 'planted.mjs');
writeFileSync(planted, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default async () => {};\n`);

afterAll(() => rmSync(outside, { recursive: true, force: true }));

function run(script: string, ...args: string[]): { status: number | null; stderr: string } {
  const out = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: out.status, stderr: out.stderr };
}

describe('the driver commands the local Claude settings pre-approve (H11)', () => {
  it('drive.mjs refuses a module outside scripts/scenarios without importing it', () => {
    const out = run('drive.mjs', planted);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('is not a scenario file directly in scripts/scenarios/');
    expect(existsSync(marker)).toBe(false);
  });

  it('drive.mjs refuses a path that starts in scripts/scenarios and resolves somewhere else', () => {
    for (const path of ['scripts/scenarios/../app-driver.mjs', 'scripts/scenarios/../../package.json']) {
      const out = run('drive.mjs', path);
      expect(out.status, path).toBe(2);
      expect(out.stderr, path).toContain('is not a scenario file directly in scripts/scenarios/');
    }
  });

  it('neither drive.mjs nor smoke-packaged.mjs takes --exe', () => {
    for (const out of [
      run('drive.mjs', 'scripts/scenarios/views.mjs', '--exe=C:/Windows/System32/notepad.exe'),
      run('smoke-packaged.mjs', '--exe=C:/Windows/System32/notepad.exe'),
    ]) {
      expect(out.status).toBe(2);
      expect(out.stderr).toContain('--exe is not supported');
    }
  });
});
