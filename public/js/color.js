// Colour science shared by the phones, the big screen and the server (it is
// imported by server.js too, so the score a phone shows is the score it gets).
//
// Colours are compared in CIELAB with CIEDE2000, the perceptual difference
// formula paint and textile labs use. Lightness counts at half weight (the
// 2:1:1 "acceptability" variant), because a phone camera guesses exposure and
// the same red mug reads lighter or darker depending on what else is in frame.

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);

// ---------- sRGB <-> linear light ----------
export const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function toLinear(c255) {
  const c = clamp(c255 / 255);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function fromLinear(l) {
  const v = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(Math.max(0, l), 1 / 2.4) - 0.055;
  return clamp(v) * 255;
}

// ---------- linear sRGB <-> XYZ (D65) <-> Lab ----------
const XN = 0.95047, YN = 1.0, ZN = 1.08883;
const E3 = Math.pow(6 / 29, 3);
const K3 = 3 * Math.pow(6 / 29, 2);

function f(t) {
  return t > E3 ? Math.cbrt(t) : t / K3 + 4 / 29;
}
function finv(t) {
  return t > 6 / 29 ? t * t * t : K3 * (t - 4 / 29);
}

// Linear-light RGB (0..1 each) -> [L, a, b]
export function linToLab(r, g, b) {
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const fx = f(X / XN), fy = f(Y / YN), fz = f(Z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// sRGB bytes (0..255) -> [L, a, b]
export function rgbToLab(r, g, b) {
  return linToLab(toLinear(r), toLinear(g), toLinear(b));
}

// [L, a, b] -> sRGB bytes, clipped into gamut
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const X = XN * finv(fy + a / 500);
  const Y = YN * finv(fy);
  const Z = ZN * finv(fy - b / 200);
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const bl = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [Math.round(fromLinear(r)), Math.round(fromLinear(g)), Math.round(fromLinear(bl))];
}

// ---------- hex ----------
export function hexToRgb(hex) {
  const h = String(hex).replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const x = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  return "#" + x(r) + x(g) + x(b);
}

export function hexToLab(hex) {
  return rgbToLab(...hexToRgb(hex));
}

export function labToHex(lab) {
  return rgbToHex(...labToRgb(lab[0], lab[1], lab[2]));
}

export function isHex(s) {
  return typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);
}

// ---------- CIEDE2000 ----------
const RAD = Math.PI / 180;
const P25_7 = Math.pow(25, 7);

export function deltaE00(lab1, lab2, kL = 1, kC = 1, kH = 1) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar7 = Math.pow((C1 + C2) / 2, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + P25_7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b, ap) => {
    if (b === 0 && ap === 0) return 0;
    const h = Math.atan2(b, ap) / RAD;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);

  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2;
  else hbp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * RAD) +
    0.24 * Math.cos(2 * hbp * RAD) +
    0.32 * Math.cos((3 * hbp + 6) * RAD) -
    0.2 * Math.cos((4 * hbp - 63) * RAD);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const RC = 2 * Math.sqrt(Cbp7 / (Cbp7 + P25_7));
  const l50 = (Lbp - 50) * (Lbp - 50);
  const SL = 1 + (0.015 * l50) / Math.sqrt(20 + l50);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * RAD) * RC;

  const tL = dLp / (kL * SL);
  const tC = dCp / (kC * SC);
  const tH = dHp / (kH * SH);
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

// ---------- the game's yardstick ----------
export const KL = 2;             // lightness weight halved (CIEDE2000 2:1:1)
export const MATCH_SIGMA = 16;   // ΔE where the match falls to 37%
export const MATCH_PTS = 1000;   // a perfect colour
export const SPEED_PTS = 300;    // a perfect colour, snapped the instant the hunt opens
export const AUTO_FACTOR = 0.5;  // time ran out and the phone snapped for you

export function distance(target, sample) {
  return deltaE00(target, sample, KL, 1, 1);
}

// ΔE -> match 0..1. ΔE 4 ≈ 94%, 8 ≈ 78%, 12 ≈ 57%, 16 ≈ 37%, 24 ≈ 11%.
export function matchOf(de) {
  return Math.exp(-Math.pow(de / MATCH_SIGMA, 2));
}

export function scoreSnap({ de, t, dur, auto = false, mult = 1 }) {
  const match = matchOf(de);
  const sf = auto ? 0 : clamp(1 - t / dur);
  const matchPts = Math.round(MATCH_PTS * match * (auto ? AUTO_FACTOR : 1)) * mult;
  const speedPts = Math.round(SPEED_PTS * sf * match * match) * mult;
  return { match, matchPts, speedPts, pts: matchPts + speedPts };
}

// The hot/cold word for a match.
export function heat(match) {
  if (match >= 0.95) return "Perfect";
  if (match >= 0.88) return "Spot on";
  if (match >= 0.75) return "Hot";
  if (match >= 0.55) return "Warm";
  if (match >= 0.3) return "Cool";
  return "Cold";
}

// Black or white text, whichever reads better on this background.
export function inkFor(hex) {
  const [r, g, b] = hexToRgb(hex);
  const Y = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  const onWhite = 1.05 / (Y + 0.05);
  const onBlack = (Y + 0.05) / 0.05;
  return onBlack >= onWhite ? "#111113" : "#ffffff";
}

export function pct(match) {
  return Math.round(clamp(match) * 100);
}
