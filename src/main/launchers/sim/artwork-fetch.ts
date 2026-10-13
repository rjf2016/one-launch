import { deflateSync } from 'node:zlib';
import type { FetchLike } from '../../services/artwork';
import { RIOT_PRODUCTS } from '../riot/products';
import type { FakeReport } from './report';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** A valid 8-bit RGB PNG of one colour, so the artwork pipeline (sniffing, storing, serving) runs on real image bytes. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A valid Windows icon file with one 32-bit frame: a disc of the colour on a transparent square, so the
 * stand-in path of the artwork pipeline (sniffing, storing, serving an .ico) runs on a real icon.
 */
export function solidIco(size: number, rgb: [number, number, number]): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - size / 2;
      const dy = y + 0.5 - size / 2;
      const at = (y * size + x) * 4;
      pixels[at] = rgb[2];
      pixels[at + 1] = rgb[1];
      pixels[at + 2] = rgb[0];
      pixels[at + 3] = dx * dx + dy * dy <= radius * radius ? 255 : 0;
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(pixels.length + mask.length, 20);
  const image = Buffer.concat([header, pixels, mask]);
  const dir = Buffer.alloc(22);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(1, 4);
  dir[6] = size >= 256 ? 0 : size;
  dir[7] = size >= 256 ? 0 : size;
  dir.writeUInt16LE(1, 10);
  dir.writeUInt16LE(32, 12);
  dir.writeUInt32LE(image.length, 14);
  dir.writeUInt32LE(22, 18);
  return Buffer.concat([dir, image]);
}

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Riot's games are not on Steam, so the fake store finds nothing for their names, as the real one does. */
const NOT_ON_STEAM: ReadonlySet<string> = new Set(Object.values(RIOT_PRODUCTS).map((p) => p.name.toLowerCase()));

/**
 * Stands in for the network in fake-launcher runs. Steam's store search answers with the term itself as an
 * app, so every game resolves (except Riot's, which are not on Steam); the Steam CDN answers every image
 * with a solid PNG whose colour comes from the URL; SteamGridDB rejects the key; anything else is a 404.
 * No request leaves the process.
 */
export function fixtureFetch(report?: FakeReport): FetchLike {
  return async (url) => {
    report?.fetched(url);
    const u = new URL(url);
    if (u.hostname === 'store.steampowered.com' || u.hostname === 'steamcommunity.com') {
      const term = decodeURIComponent(u.searchParams.get('term') ?? u.pathname.split('/').pop() ?? '');
      if (NOT_ON_STEAM.has(term.toLowerCase())) return json(200, { items: [] });
      const id = 100000 + (hash(term) % 900000);
      return json(200, { items: [{ type: 'app', id, name: term }] });
    }
    if (u.hostname.endsWith('steamstatic.com')) {
      const h = hash(url);
      const png = solidPng(60, 90, [40 + (h % 120), 40 + ((h >>> 8) % 120), 60 + ((h >>> 16) % 140)]);
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    }
    if (u.hostname === 'www.steamgriddb.com') return json(401, { success: false, errors: ['fake platform: no SteamGridDB'] });
    return new Response(null, { status: 404 });
  };
}
