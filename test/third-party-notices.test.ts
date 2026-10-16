import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('third-party notices (A11)', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'third-party-notices.mjs')], { cwd: ROOT, encoding: 'utf8' });
  });

  it('name every package that ships: the production dependency, what it needs, and what the renderer bundles', () => {
    const notices = readFileSync(join(ROOT, 'build', 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> };
    for (const name of ['better-sqlite3', 'node-addon-api', 'react', 'react-dom', 'scheduler', 'zustand', 'lucide-react', 'tailwindcss']) {
      expect(notices, name).toContain(`\n${name} ${lock.packages[`node_modules/${name}`]!.version}\n`);
    }
    expect(notices).toContain('LICENSES.chromium.html');
    expect(notices).not.toMatch(/\n(vitest|typescript|eslint|electron-builder) \d/);
  });

  it('feed the installer a licence page that starts with the MIT licence and points at the notices', () => {
    const page = readFileSync(join(ROOT, 'build', 'license.txt'), 'utf8');
    expect(page.startsWith(readFileSync(join(ROOT, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim())).toBe(true);
    expect(page).toContain('THIRD-PARTY-NOTICES.txt');
  });
});
