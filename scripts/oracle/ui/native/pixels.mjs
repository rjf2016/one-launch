import { inflateSync } from 'node:zlib';

const CHANNELS = { 2: 3, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png) {
  let at = 8;
  let header = null;
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = body;
    if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = CHANNELS[header[9]];
  if (header[8] !== 8 || channels === undefined || header[12] !== 0) throw new Error('only 8-bit RGB and RGBA PNGs without interlace are read');
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rgb = Buffer.alloc(width * height * 3);
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
    for (let x = 0; x < width; x += 1) row.copy(rgb, (y * width + x) * 3, x * channels, x * channels + 3);
    prev = row;
  }
  return { width, height, rgb };
}

export function pixelDiff(a, b) {
  const one = decodePng(a);
  const two = decodePng(b);
  if (one.width !== two.width || one.height !== two.height) return null;
  let count = 0;
  let box = null;
  for (let i = 0; i < one.width * one.height; i += 1) {
    const o = i * 3;
    if (one.rgb[o] === two.rgb[o] && one.rgb[o + 1] === two.rgb[o + 1] && one.rgb[o + 2] === two.rgb[o + 2]) continue;
    count += 1;
    const x = i % one.width;
    const y = Math.floor(i / one.width);
    box = box === null ? [x, y, x, y] : [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  }
  return { count, box };
}
