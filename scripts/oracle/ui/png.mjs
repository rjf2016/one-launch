import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function chunks(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const out = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    out.push({ type: png.toString('latin1', at + 4, at + 8), body: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

export function pngSize(png) {
  const header = chunks(png).find((chunk) => chunk.type === 'IHDR');
  if (!header) throw new Error('a PNG without a header');
  return [header.body.readUInt32BE(0), header.body.readUInt32BE(4)];
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function pngStats(png) {
  const parts = chunks(png);
  const header = parts.find((chunk) => chunk.type === 'IHDR').body;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = CHANNELS[header[9]];
  if (header[8] !== 8 || channels === undefined || channels < 3 || header[12] !== 0) throw new Error('only 8-bit RGB and RGBA PNGs without interlace are read');
  const raw = inflateSync(Buffer.concat(parts.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.body)));
  const stride = width * channels;
  const counts = new Map();
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      const add = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : 0;
      row[x] = (row[x] + add) & 0xff;
    }
    for (let x = 0; x < stride; x += channels) {
      const colour = (row[x] << 16) | (row[x + 1] << 8) | row[x + 2];
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
    prev = row;
  }
  const top = Math.max(...counts.values());
  return { width, height, colours: counts.size, dominant: top / (width * height) };
}
