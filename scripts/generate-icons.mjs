// Generates icons/icon-{16,32,48,128}.png with no dependencies.
// Design: rounded indigo→cyan square, white lens ring with handle, three "stack" bars inside.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(x, y, ax, ay, bx, by) {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = clamp((px * dx + py * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - dx * t, py - dy * t);
}

// Shape in a 0..1 unit square. Returns [r,g,b,a] in 0..1.
function shade(u, v) {
  const bgD = sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.22);
  if (bgD > 0) return [0, 0, 0, 0];
  let col = mix([0.31, 0.27, 0.9], [0.02, 0.71, 0.83], clamp((u + v) / 2));

  const white = [1, 1, 1];
  const cx = 0.44, cy = 0.43, R = 0.235, stroke = 0.065;
  const ring = Math.abs(Math.hypot(u - cx, v - cy) - R) - stroke / 2;
  const handle = sdSegment(u, v, cx + R * 0.74, cy + R * 0.74, 0.8, 0.8) - 0.055;
  let d = Math.min(ring, handle);
  // Stack bars inside the lens
  for (const [by, w] of [[-0.085, 0.1], [0, 0.13], [0.085, 0.08]]) {
    d = Math.min(d, sdRoundRect(u, v, cx, cy + by, w, 0.022, 0.022));
  }
  return [...col, 1, d];
}

function render(size) {
  const SS = 4; // supersampling
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const [cr, cg, cb, ca, d] = shade(u, v);
          if (!ca) continue;
          const [fr, fg, fb] = d !== undefined && d < 0 ? [1, 1, 1] : [cr, cg, cb];
          r += fr; g += fg; b += fb; a += 1;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = Math.round((r / a) * 255);
        px[i + 1] = Math.round((g / a) * 255);
        px[i + 2] = Math.round((b / a) * 255);
      }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePNG(size, size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, hgt, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hgt, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * hgt);
  for (let y = 0; y < hgt; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon-${size}.png`), render(size));
  console.log(`icons/icon-${size}.png`);
}
