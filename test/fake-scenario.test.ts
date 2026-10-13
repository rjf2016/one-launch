import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, 'fake-launchers');
const fixtures = join(__dirname, 'fixtures');
const folders = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

interface RawScenario {
  version: number;
  installed: string[];
  files?: Record<string, string | { inline: string }>;
  seed?: {
    accounts?: { launcher: string; login: string; launcherUid?: string | null; password?: string | null }[];
    sessions?: { login: string; launcher: string; refreshToken?: string }[];
  };
}

const read = (name: string): RawScenario => JSON.parse(readFileSync(join(dir, name, 'scenario.json'), 'utf8')) as RawScenario;
const loginUsers = readFileSync(join(fixtures, 'steam', 'loginusers.vdf'), 'utf8');

describe('fake-launcher scenarios', () => {
  it('has the committed folders', () => {
    expect(folders).toEqual(expect.arrayContaining(['all-four', 'none', 'unowned']));
  });

  it.each(folders)('%s: every fixture reference exists and every seed value is a placeholder', (name) => {
    const s = read(name);
    expect(s.version).toBe(1);
    for (const [rel, spec] of Object.entries(s.files ?? {})) {
      expect(rel.startsWith('/') || rel.includes('..')).toBe(false);
      if (typeof spec === 'string' && spec.startsWith('@fixtures/')) {
        expect(existsSync(join(fixtures, spec.slice('@fixtures/'.length))), `${name}: ${spec}`).toBe(true);
      }
    }
    const accounts = s.seed?.accounts ?? [];
    for (const a of accounts) {
      expect(a.login, `${name}: ${a.login}`).toMatch(/^(user_\d|[a-z0-9]+@example\.com|riot_[a-z]+)$/);
      if (a.launcher === 'steam' && a.launcherUid) expect(loginUsers.includes(`"${a.launcherUid}"`), `${name}: ${a.launcherUid}`).toBe(true);
      if (a.launcherUid)
        expect(a.launcherUid).toMatch(/^(7656119800000000\d|[0-9a-f]{8}|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12})$/);
      if (a.password) expect(a.password).toMatch(/^pw-/);
    }
    for (const session of s.seed?.sessions ?? []) {
      expect(
        accounts.some((a) => a.launcher === session.launcher && a.login === session.login),
        `${name}: session for ${session.login}`,
      ).toBe(true);
      if (session.launcher === 'riot') expect(session.refreshToken, `${name}: ${session.login}`).toMatch(/^placeholder-/);
    }
  });
});
