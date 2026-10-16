import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, isVersionString, latestWhatsNew, pickWhatsNew, type WhatsNewRelease } from '../src/shared/whats-new';
import { WHATS_NEW } from '../src/shared/whats-new-releases';

const release = (version: string): WhatsNewRelease => ({ version, date: '2026-10-01', items: [{ lead: 'Something changed.' }] });

describe('isVersionString', () => {
  it('accepts a semver core with an optional prerelease and refuses the rest', () => {
    for (const ok of ['1.0.0', '1.0.0-beta.2', '0.0.0-test', '10.20.30-rc.1.x-y']) expect(isVersionString(ok), ok).toBe(true);
    for (const bad of ['', '1.0', 'v1.0.0', '1.0.0 ', 'latest', '1.0.0-', `1.0.0-${'a'.repeat(70)}`, 1, null])
      expect(isVersionString(bad), String(bad)).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders the numeric core, then a prerelease before its release, then prerelease ids numerically or alphabetically', () => {
    const ordered = [
      '0.9.0',
      '1.0.0-alpha',
      '1.0.0-beta.2',
      '1.0.0-beta.2.1',
      '1.0.0-beta.10',
      '1.0.0-rc.1',
      '1.0.0-test',
      '1.0.0',
      '1.0.1',
      '1.10.0',
      '2.0.0',
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(compareVersions(ordered[i]!, ordered[j]!), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j));
      }
    }
  });
});

describe('pickWhatsNew', () => {
  const releases = [release('1.0.0-beta.5'), release('1.0.0-beta.3'), release('1.0.0-beta.1')];

  it('returns the newest unseen entry at or below the running version', () => {
    expect(pickWhatsNew(releases, '1.0.0-beta.5', '1.0.0-beta.3')?.version).toBe('1.0.0-beta.5');
    expect(pickWhatsNew(releases, '1.0.0-beta.6', '1.0.0-beta.3')?.version).toBe('1.0.0-beta.5');
    expect(pickWhatsNew(releases, '1.0.0-beta.4', '1.0.0-beta.3')).toBeNull();
    expect(pickWhatsNew(releases, '1.0.0-beta.5', '1.0.0-beta.5')).toBeNull();
    expect(pickWhatsNew(releases, '1.0.0-beta.3', '1.0.0-beta.5')).toBeNull();
  });

  it('treats nothing seen, or something that is not a version, as older than every entry', () => {
    expect(pickWhatsNew(releases, '1.0.0-beta.5', null)?.version).toBe('1.0.0-beta.5');
    expect(pickWhatsNew(releases, '1.0.0-beta.2', null)?.version).toBe('1.0.0-beta.1');
    expect(pickWhatsNew(releases, '1.0.0-beta.3', 'garbage')?.version).toBe('1.0.0-beta.3');
    expect(pickWhatsNew(releases, 'not a version', null)).toBeNull();
    expect(pickWhatsNew([], '1.0.0-beta.5', null)).toBeNull();
  });

  it('latestWhatsNew ignores what was seen', () => {
    expect(latestWhatsNew(releases, '1.0.0-beta.5')?.version).toBe('1.0.0-beta.5');
    expect(latestWhatsNew(releases, '1.0.0-beta.4')?.version).toBe('1.0.0-beta.3');
    expect(latestWhatsNew(releases, '1.0.0-beta.0')).toBeNull();
  });
});

describe('WHATS_NEW', () => {
  it('is newest first, unique, dated, filled in, and never ahead of package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    const versions = WHATS_NEW.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const r of WHATS_NEW) {
      expect(isVersionString(r.version), r.version).toBe(true);
      expect(compareVersions(r.version, pkg.version), `${r.version} is newer than package.json`).toBeLessThanOrEqual(0);
      expect(r.date, r.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const [year, month, day] = r.date.split('-').map(Number);
      const parsed = new Date(Date.UTC(year!, month! - 1, day!));
      expect([parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate()], r.date).toEqual([year, month, day]);
      expect(r.items.length, r.version).toBeGreaterThan(0);
      for (const item of r.items) expect(item.lead.trim().length, r.version).toBeGreaterThan(0);
    }
    for (let i = 1; i < WHATS_NEW.length; i++) expect(compareVersions(WHATS_NEW[i - 1]!.version, WHATS_NEW[i]!.version)).toBe(1);
  });
});
