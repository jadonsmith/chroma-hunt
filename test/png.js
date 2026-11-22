// A tiny PNG encoder so bots can send real (if dull) thumbnails: a blob of the
// colour they "found" on a darker, noisy background, like a close-up photo.
import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function pngDataUrl(w, h, pixel) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * stride + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const png = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return "data:image/png;base64," + png.toString("base64");
}

// A fake close-up photo of something the colour [r, g, b].
export function fakePhoto([r, g, b], size = 96, seed = 1) {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const cx = size * (0.42 + rnd() * 0.16), cy = size * (0.42 + rnd() * 0.16);
  const rad = size * (0.36 + rnd() * 0.12);
  const bg = [40 + rnd() * 60, 40 + rnd() * 60, 40 + rnd() * 60];
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return pngDataUrl(size, size, (x, y) => {
    const d = Math.hypot(x - cx, y - cy) / rad;
    const k = d < 1 ? 1 : Math.max(0, 1 - (d - 1) * 6);
    const shade = 1.12 - 0.3 * ((y / size) * 0.7 + d * 0.3);
    const n = (rnd() - 0.5) * 14;
    return [cl((r * shade * k + bg[0] * (1 - k)) + n), cl((g * shade * k + bg[1] * (1 - k)) + n), cl((b * shade * k + bg[2] * (1 - k)) + n)];
  });
}
