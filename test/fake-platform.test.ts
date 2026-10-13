import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureFetch, solidPng } from '../src/main/launchers/sim/artwork-fetch';
import { FAKE_REPORT_FILE, FakeReport } from '../src/main/launchers/sim/report';
import { sniffImage } from '../src/main/services/artwork-url';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'onelaunch-fake-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fixtureFetch', () => {
  it('makes a PNG the artwork pipeline accepts', () => {
    expect(sniffImage(solidPng(60, 90, [10, 20, 30]))).toBe('png');
  });

  it('answers Steam search with the term itself, the CDN with an image, and everything else without network', async () => {
    const report = new FakeReport();
    const fetch = fixtureFetch(report);
    const search = await fetch('https://store.steampowered.com/api/storesearch/?term=Rocket%20League&l=english&cc=US');
    const body = (await search.json()) as { items: { id: number; name: string }[] };
    expect(body.items[0]?.name).toBe('Rocket League');
    expect(body.items[0]?.id).toBeGreaterThan(0);
    const image = await fetch('https://cdn.cloudflare.steamstatic.com/steam/apps/252950/library_600x900.jpg');
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(sniffImage(Buffer.from(await image.arrayBuffer()))).toBe('png');
    expect((await fetch('https://www.steamgriddb.com/api/v2/grids/steam/252950')).status).toBe(401);
    expect((await fetch('https://example.com/anything')).status).toBe(404);
    expect(report.data.fetched).toHaveLength(4);
  });
});

describe('FakeReport', () => {
  it('rewrites its file on every change, so a hard kill still leaves the latest state', () => {
    const report = new FakeReport();
    report.attach(root);
    const file = join(root, FAKE_REPORT_FILE);
    expect(existsSync(file)).toBe(true);
    report.opened('steam://rungameid/252950');
    report.processEvent({ kind: 'start', exe: 'steam.exe', args: [] });
    report.registryWrite({ op: 'set', path: 'HKCU\\x', value: 1 });
    report.clipboardWrite();
    const saved = JSON.parse(readFileSync(file, 'utf8')) as FakeReport['data'];
    expect(saved.opened).toEqual(['steam://rungameid/252950']);
    expect(saved.processEvents).toHaveLength(1);
    expect(saved.registryWrites).toHaveLength(1);
    expect(saved.clipboardWrites).toBe(1);
  });
});
