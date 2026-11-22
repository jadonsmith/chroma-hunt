// The camera: the back camera's live feed, the colour under the scope, and the
// photo thumbnail. All colour reading happens here on the phone.
//
// The view shows the feed with object-fit: cover, centred, so the scope in the
// middle of the screen sits over the middle of the frame. geometry() converts the
// scope's on-screen hole into source pixels; sampleAt() reads that disc.

import { LIN, linToLab, fromLinear, rgbToHex } from "./color.js";

export const cam = {
  mode: "",              // "" | "live" | "photo" | "sim"
  stream: null,
  video: null,
  facing: "environment",
  mirrored: false,
  hasTorch: false,
  torch: false,
  multi: false,
  source: null,          // what gets sampled: the <video>, the dev sim canvas, or a photo
  onEnded: null,
};

const N = 40; // the scope's disc is read as an N×N grid
const sc = document.createElement("canvas");
sc.width = sc.height = N;
const sx = sc.getContext("2d", { willReadFrequently: true });

export function srcSize(src = cam.source) {
  if (!src) return null;
  if (src.readyState !== undefined && src.readyState < 2) return null; // video not decoding yet
  const w = src.videoWidth || src.naturalWidth || src.width || 0;
  const h = src.videoHeight || src.naturalHeight || src.height || 0;
  return w && h ? { w, h } : null;
}

// Where the scope sits on the source, in source pixels.
export function geometry(boxW, boxH, holeR, src = cam.source) {
  const s0 = srcSize(src);
  if (!s0 || !boxW || !boxH) return null;
  const k = Math.max(boxW / s0.w, boxH / s0.h);
  return { cx: s0.w / 2, cy: s0.h / 2, r: holeR / k, visW: Math.min(s0.w, boxW / k), visH: Math.min(s0.h, boxH / k), w: s0.w, h: s0.h };
}

// A still photo from the camera app: there was no scope, so read a central disc.
export function photoGeometry(src) {
  const s0 = srcSize(src);
  if (!s0) return null;
  const m = Math.min(s0.w, s0.h);
  return { cx: s0.w / 2, cy: s0.h / 2, r: m * 0.13, visW: s0.w, visH: s0.h, w: s0.w, h: s0.h };
}

function meanOf(px, idx) {
  let r = 0, g = 0, b = 0;
  for (const k of idx) { r += px[k * 3]; g += px[k * 3 + 1]; b += px[k * 3 + 2]; }
  const n = idx.length || 1;
  return [r / n, g / n, b / n];
}

function closest(px, n, c, keep) {
  const d = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = px[k * 3] - c[0], b = px[k * 3 + 1] - c[1], e = px[k * 3 + 2] - c[2];
    d[k] = a * a + b * b + e * e;
  }
  const cut = d.slice().sort()[Math.max(0, Math.floor(n * keep) - 1)];
  const idx = [];
  for (let k = 0; k < n; k++) if (d[k] <= cut) idx.push(k);
  return { idx, d };
}

// The colour inside the scope. It starts from what's right under the crosshair,
// then averages (in linear light) the 60% of the disc that's most like it, twice,
// so an edge, a glint or a shadow at the rim doesn't drag the colour away.
export function sampleAt(g, src = cam.source) {
  if (!g || !src) return null;
  try {
    sx.clearRect(0, 0, N, N);
    sx.drawImage(src, g.cx - g.r, g.cy - g.r, g.r * 2, g.r * 2, 0, 0, N, N);
  } catch {
    return null;
  }
  const d = sx.getImageData(0, 0, N, N).data;
  const R = N / 2;
  const px = [];
  const centre = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - R, dy = y + 0.5 - R;
      const rr = dx * dx + dy * dy;
      if (rr > R * R) continue;
      const i = (y * N + x) * 4;
      if (rr <= 6.5) centre.push(px.length / 3);
      px.push(LIN[d[i]], LIN[d[i + 1]], LIN[d[i + 2]]);
    }
  }
  const n = px.length / 3;
  if (!n) return null;
  let c = meanOf(px, centre);
  let pick = closest(px, n, c, 0.6);
  c = meanOf(px, pick.idx);
  pick = closest(px, n, c, 0.6);
  c = meanOf(px, pick.idx);
  // How mixed is the patch? Share of pixels clearly unlike the reading.
  let far = 0;
  for (let k = 0; k < n; k++) {
    const a = px[k * 3] - c[0], b = px[k * 3 + 1] - c[1], e = px[k * 3 + 2] - c[2];
    const ref = 0.012 + 0.08 * (c[0] + c[1] + c[2]);
    if (a * a + b * b + e * e > ref * ref) far++;
  }
  const rgb = [fromLinear(c[0]), fromLinear(c[1]), fromLinear(c[2])];
  return { lab: linToLab(c[0], c[1], c[2]), hex: rgbToHex(...rgb), rgb, mixed: far / n };
}

// A square thumbnail around the scope (with some context, so you can see what it
// was), as a small JPEG. ring = the sampled disc's diameter as a share of the side.
export function thumbAt(g, src = cam.source, { size = 240, mirror = false } = {}) {
  if (!g || !src) return null;
  const side = Math.min(g.w, g.h, Math.max(Math.min(g.visW, g.visH) * 0.82, g.r * 2 * 2.6));
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  if (mirror) {
    x.translate(size, 0);
    x.scale(-1, 1);
  }
  try {
    x.drawImage(src, g.cx - side / 2, g.cy - side / 2, side, side, 0, 0, size, size);
  } catch {
    return null;
  }
  let q = 0.74;
  let url = c.toDataURL("image/jpeg", q);
  while (url.length > 52000 && q > 0.3) {
    q -= 0.12;
    url = c.toDataURL("image/jpeg", q);
  }
  if (!url.startsWith("data:image/jpeg")) return null;
  return { src: url, ring: (g.r * 2) / side };
}

// ---------- the live camera ----------
function stopTracks() {
  if (cam.stream) for (const t of cam.stream.getTracks()) t.stop();
  cam.stream = null;
}

export function camAlive() {
  return !!(cam.stream && cam.stream.getVideoTracks().some((t) => t.readyState === "live"));
}

export function camError(e) {
  const n = e && e.name;
  if (e && e.code === "nocam") return "This browser can't open a camera here. Try your phone's own browser (Safari or Chrome), or use your camera app instead.";
  if (n === "NotAllowedError" || n === "SecurityError") return "Camera access was blocked. Allow it for this site in your browser settings, or use your camera app instead.";
  if (n === "NotFoundError" || n === "OverconstrainedError") return "No camera found on this device.";
  if (n === "NotReadableError" || n === "AbortError") return "The camera is busy in another app. Close it and try again.";
  return "The camera didn't start. Try again, or use your camera app instead.";
}

export async function startCamera(video, facing = cam.facing || "environment") {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) throw Object.assign(new Error("nocam"), { code: "nocam" });
  stopTracks();
  let stream;
  const want = { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  try {
    stream = await md.getUserMedia({ audio: false, video: want });
  } catch (e) {
    if (e && (e.name === "OverconstrainedError" || e.name === "NotReadableError" || e.name === "TypeError")) {
      stream = await md.getUserMedia({ audio: false, video: { facingMode: facing } }).catch(() => md.getUserMedia({ audio: false, video: true }));
    } else throw e;
  }
  cam.stream = stream;
  cam.video = video;
  video.muted = true;
  video.setAttribute("playsinline", "");
  video.srcObject = stream;
  try { await video.play(); } catch {}
  const track = stream.getVideoTracks()[0];
  const s = track && track.getSettings ? track.getSettings() : {};
  cam.facing = s.facingMode || facing;
  cam.mirrored = s.facingMode === "user";
  let caps = {};
  try { caps = track && track.getCapabilities ? track.getCapabilities() : {}; } catch {}
  cam.hasTorch = !!(caps && caps.torch);
  cam.torch = false;
  cam.source = video;
  cam.mode = "live";
  try {
    const devs = await md.enumerateDevices();
    cam.multi = devs.filter((d) => d.kind === "videoinput").length > 1;
  } catch {
    cam.multi = false;
  }
  if (track) track.addEventListener("ended", () => { if (cam.stream === stream && cam.onEnded) cam.onEnded(); });
  await waitFrame(video, 2500);
  return cam;
}

export function waitFrame(video, ms = 2500) {
  return new Promise((res) => {
    const t0 = performance.now();
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth) return res(true);
      if (performance.now() - t0 > ms) return res(false);
      setTimeout(check, 60);
    };
    check();
  });
}

export async function flipCamera() {
  if (!cam.video) return cam;
  return startCamera(cam.video, cam.facing === "user" ? "environment" : "user");
}

export async function setTorch(on) {
  const t = cam.stream && cam.stream.getVideoTracks()[0];
  if (!t || !cam.hasTorch) return false;
  try {
    await t.applyConstraints({ advanced: [{ torch: !!on }] });
    cam.torch = !!on;
    return true;
  } catch {
    return false;
  }
}

export function stopCamera() {
  stopTracks();
  if (cam.video) cam.video.srcObject = null;
  if (cam.mode === "live") {
    cam.mode = "";
    cam.source = null;
  }
}

// ---------- the camera-app fallback ----------
// A photo taken with the phone's own camera app (for browsers that won't open the
// camera in the page). Normalised into a canvas no bigger than 1280 px.
export async function loadPhoto(file) {
  let bmp = null;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bmp = await new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("That photo couldn't be opened.")); };
      img.src = url;
    });
  }
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, 1280 / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w0 * k));
  c.height = Math.max(1, Math.round(h0 * k));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}
