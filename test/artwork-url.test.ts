import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artworkRelPath, artworkUrl, resolveArtworkPath, sniffIcon, sniffImage } from '../src/main/services/artwork-url';

const DIR = 'D:\\data\\OneLaunch\\artwork';
const ID = '3f2c9b1e-6d4a-4f0b-9c1d-2a7e8b5c4d3f';

describe('artwork urls', () => {
  it('builds a versioned url from a relative cache path', () => {
    expect(artworkRelPath(ID, 'grid', 'jpg')).toBe(`${ID}/grid.jpg`);
    expect(artworkUrl(`${ID}/grid.jpg`, '2026-09-12T10:00:00.000Z')).toBe(`onelaunch-art://art/${ID}/grid.jpg?v=2026-09-12T10%3A00%3A00.000Z`);
    expect(artworkUrl(`${ID}/logo.png`, null)).toBe(`onelaunch-art://art/${ID}/logo.png`);
  });

  it('resolves only <uuid>/<kind>.<ext> inside the artwork folder', () => {
    expect(resolveArtworkPath(`onelaunch-art://art/${ID}/grid.jpg?v=1`, DIR)).toBe(resolve(DIR, ID, 'grid.jpg'));
    expect(resolveArtworkPath(`onelaunch-art://art/${ID}/hero.webp`, DIR)).toBe(resolve(DIR, ID, 'hero.webp'));
    expect(resolveArtworkPath(`onelaunch-art://art/${ID}/logo.png`, DIR)).toBe(resolve(DIR, ID, 'logo.png'));
    expect(resolveArtworkPath(`onelaunch-art://art/${ID}/grid.ico?v=2`, DIR)).toBe(resolve(DIR, ID, 'grid.ico'));
  });

  it('rejects traversal, other schemes, other hosts, and anything not on the allowlist', () => {
    const bad = [
      `onelaunch-art://art/../onelaunch.db`,
      `onelaunch-art://art/${ID}/../../onelaunch.db`,
      `onelaunch-art://art/${ID}/..%2F..%2Fonelaunch.db`,
      `onelaunch-art://art/%2E%2E/%2E%2E/onelaunch.db`,
      `onelaunch-art://art/${ID}/grid.jpg/extra`,
      `onelaunch-art://art/${ID}/grid.exe`,
      `onelaunch-art://art/${ID}/grid.jpg.tmp`,
      `onelaunch-art://art/${ID}/GRID.JPG`,
      `onelaunch-art://art/${ID}`,
      `onelaunch-art://art/not-a-uuid/grid.jpg`,
      `onelaunch-art://art/C:/Windows/grid.jpg`,
      `onelaunch-art://other/${ID}/grid.jpg`,
      `file:///${ID}/grid.jpg`,
      `https://art/${ID}/grid.jpg`,
      'not a url',
    ];
    for (const url of bad) expect(resolveArtworkPath(url, DIR), url).toBeNull();
  });
});

describe('sniffImage', () => {
  it('recognises jpeg, png, and webp and nothing else', () => {
    const pad = (head: number[]) => new Uint8Array([...head, ...new Array(16).fill(0)]);
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffImage(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 '), 0, 0, 0, 0]))).toBe('webp');
    expect(sniffImage(pad([0x47, 0x49, 0x46, 0x38]))).toBeNull();
    expect(sniffImage(new Uint8Array(Buffer.from('<!doctype html><html></html>')))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it('tells a Windows icon file by its header, which sniffImage never accepts', () => {
    const ico = (type: number, count: number): Uint8Array => new Uint8Array([0, 0, type, 0, count, 0, ...new Array(16).fill(0)]);
    expect(sniffIcon(ico(1, 1))).toBe(true);
    expect(sniffIcon(ico(1, 5))).toBe(true);
    expect(sniffIcon(ico(2, 1))).toBe(false);
    expect(sniffIcon(ico(1, 0))).toBe(false);
    expect(sniffIcon(new Uint8Array([0, 0, 1, 0, 1, 0]))).toBe(false);
    expect(sniffImage(ico(1, 1))).toBeNull();
  });
});
