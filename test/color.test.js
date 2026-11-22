// CIEDE2000 against the 34 reference pairs in Sharma, Wu & Dalal (2005),
// plus sRGB -> Lab spot checks and the scoring curve.
import { deltaE00, rgbToLab, labToRgb, hexToLab, labToHex, matchOf, scoreSnap, inkFor } from "../public/js/color.js";

const PAIRS = [
  [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
  [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
  [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
  [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
  [50, -1.1848, -84.8006, 50, 0, -82.7485, 1.0],
  [50, -0.9009, -85.5211, 50, 0, -82.7485, 1.0],
  [50, 0, 0, 50, -1, 2, 2.3669],
  [50, -1, 2, 50, 0, 0, 2.3669],
  [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
  [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
  [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
  [50, 2.5, 0, 50, 0, -2.5, 4.3065],
  [50, 2.5, 0, 73, 25, -18, 27.1492],
  [50, 2.5, 0, 61, -5, 29, 22.8977],
  [50, 2.5, 0, 56, -27, -3, 31.903],
  [50, 2.5, 0, 58, 24, 15, 19.4535],
  [50, 2.5, 0, 50, 3.1736, 0.5854, 1.0],
  [50, 2.5, 0, 50, 3.2972, 0, 1.0],
  [50, 2.5, 0, 50, 1.8634, 0.5757, 1.0],
  [50, 2.5, 0, 50, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

let fails = 0;
PAIRS.forEach((p, i) => {
  const d1 = deltaE00(p.slice(0, 3), p.slice(3, 6));
  const d2 = deltaE00(p.slice(3, 6), p.slice(0, 3));
  if (Math.abs(d1 - p[6]) > 1e-4 || Math.abs(d2 - p[6]) > 1e-4) {
    fails++;
    console.log(`pair ${i + 1}: got ${d1.toFixed(4)} / ${d2.toFixed(4)}, want ${p[6]}`);
  }
});
console.log(`CIEDE2000: ${PAIRS.length - fails}/${PAIRS.length} reference pairs match (±1e-4, both orders)`);

const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const LAB = [
  [[255, 255, 255], [100, 0, 0]],
  [[0, 0, 0], [0, 0, 0]],
  [[255, 0, 0], [53.24, 80.09, 67.2]],
  [[0, 255, 0], [87.73, -86.18, 83.18]],
  [[0, 0, 255], [32.3, 79.19, -107.86]],
  [[128, 128, 128], [53.59, 0, 0]],
];
for (const [rgb, want] of LAB) {
  const got = rgbToLab(...rgb);
  if (!near(got, want, 0.05)) { fails++; console.log(`rgbToLab(${rgb}) = ${got.map((v) => v.toFixed(2))}, want ${want}`); }
  const back = labToRgb(...got);
  if (!near(back, rgb, 0)) { fails++; console.log(`round trip ${rgb} -> ${back}`); }
}
for (let i = 0; i < 2000; i++) {
  const rgb = [0, 0, 0].map(() => Math.floor(Math.random() * 256));
  const back = labToRgb(...rgbToLab(...rgb));
  if (!near(back, rgb, 0)) { fails++; console.log(`round trip ${rgb} -> ${back}`); break; }
}
if (labToHex(hexToLab("#e8662a")) !== "#e8662a") { fails++; console.log("hex round trip"); }
console.log("sRGB <-> Lab: checked");

const m = [0, 4, 8, 12, 16, 24].map((d) => Math.round(matchOf(d) * 100));
console.log("match% at ΔE 0/4/8/12/16/24:", m.join(" / "));
const s1 = scoreSnap({ de: 0, t: 0, dur: 45000 });
const s2 = scoreSnap({ de: 8, t: 22500, dur: 45000 });
const s3 = scoreSnap({ de: 8, t: 45000, dur: 45000, auto: true });
const s4 = scoreSnap({ de: 8, t: 22500, dur: 45000, mult: 2 });
console.log("perfect+instant", s1.pts, "| ΔE8 half time", s2.pts, `(${s2.matchPts}+${s2.speedPts})`, "| ΔE8 auto", s3.pts, "| ΔE8 double", s4.pts);
if (s1.pts !== 1300 || s3.speedPts !== 0 || s4.pts !== s2.pts * 2) { fails++; console.log("scoring off"); }
if (inkFor("#ffffff") !== "#111113" || inkFor("#000000") !== "#ffffff") { fails++; console.log("inkFor off"); }
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log("color: all good");
