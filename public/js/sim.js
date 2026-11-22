// ?dev: a stand-in for the back camera, for testing on a desktop.
//
// A procedurally painted room (walls, a floor, ~50 objects in real-world colours)
// that you pan across with the arrow keys / WASD or by dragging. It's rendered
// into a canvas with hand shake, sensor noise and drifting exposure, and the real
// sampler reads that canvas exactly as it reads the camera feed. The autopilot
// knows where everything is and hunts like a (fallible) person.

import { PALETTE, mulberry32 } from "./palette.js";
import { hexToRgb, labToRgb, rgbToHex, distance } from "./color.js";

const WORLD = 2600;

export function createSim(seed = 1) {
  const rand = mulberry32(seed);
  const world = document.createElement("canvas");
  world.width = world.height = WORLD;
  const w = world.getContext("2d");
  const objects = paintWorld(w, rand);

  // the "camera": a portrait window onto the room
  const view = document.createElement("canvas");
  view.width = 405;
  view.height = 720;
  view.className = "sim-cam";
  const v = view.getContext("2d");
  const noise = makeNoise(rand);

  const sim = {
    canvas: view,
    objects,
    aim: { x: WORLD / 2, y: WORLD / 2 },
    goal: null,
    keys: new Set(),
    zoom: 1.35, // world px per view px
    shake: 1,
    exposure: 1,
    frames: 0,
  };

  let wb = [1, 1, 1];
  let drift = 0;
  const frame = () => {
    sim.frames++;
    const dt = 1 / 30;
    // keys pan, at a speed that suits browsing a room
    let kx = 0, ky = 0;
    const k = sim.keys;
    if (k.has("arrowleft") || k.has("a")) kx -= 1;
    if (k.has("arrowright") || k.has("d")) kx += 1;
    if (k.has("arrowup") || k.has("w")) ky -= 1;
    if (k.has("arrowdown") || k.has("s")) ky += 1;
    if (kx || ky) {
      sim.goal = null;
      sim.aim.x += kx * 700 * dt;
      sim.aim.y += ky * 700 * dt;
    }
    if (sim.goal) {
      const g = sim.goal;
      const p = Math.min(1, (performance.now() - g.t0) / g.dur);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      sim.aim.x = g.x0 + (g.x - g.x0) * e;
      sim.aim.y = g.y0 + (g.y - g.y0) * e;
      if (p >= 1) sim.goal = null;
    }
    // the aim can reach every object, even at the room's edges (beyond is dark)
    sim.aim.x = Math.max(0, Math.min(WORLD, sim.aim.x));
    sim.aim.y = Math.max(0, Math.min(WORLD, sim.aim.y));
    drift += dt;
    sim.exposure = 1 + 0.05 * Math.sin(drift * 0.7) + 0.02 * Math.sin(drift * 2.3);
    wb = [1 + 0.02 * Math.sin(drift * 0.4), 1, 1 - 0.02 * Math.sin(drift * 0.4)];
    const jx = (rand() - 0.5) * 3 * sim.shake;
    const jy = (rand() - 0.5) * 3 * sim.shake;
    const sw = view.width * sim.zoom, sh = view.height * sim.zoom;
    v.globalCompositeOperation = "source-over";
    v.globalAlpha = 1;
    v.fillStyle = "#151417";
    v.fillRect(0, 0, view.width, view.height);
    // draw only the part of the window that lies inside the room
    const sx0 = sim.aim.x - sw / 2 + jx, sy0 = sim.aim.y - sh / 2 + jy;
    const cx0 = Math.max(0, sx0), cy0 = Math.max(0, sy0);
    const cx1 = Math.min(WORLD, sx0 + sw), cy1 = Math.min(WORLD, sy0 + sh);
    if (cx1 > cx0 && cy1 > cy0) {
      const k = view.width / sw;
      v.drawImage(world, cx0, cy0, cx1 - cx0, cy1 - cy0, (cx0 - sx0) * k, (cy0 - sy0) * k, (cx1 - cx0) * k, (cy1 - cy0) * k);
    }
    // white balance / exposure drift
    v.globalCompositeOperation = "multiply";
    v.fillStyle = rgbToHex(255 * Math.min(1, wb[0] * sim.exposure), 255 * Math.min(1, wb[1] * sim.exposure), 255 * Math.min(1, wb[2] * sim.exposure));
    v.fillRect(0, 0, view.width, view.height);
    // sensor noise
    v.globalCompositeOperation = "overlay";
    v.globalAlpha = 0.16;
    v.drawImage(noise, -Math.floor(rand() * 64), -Math.floor(rand() * 64));
    v.globalAlpha = 1;
    v.globalCompositeOperation = "source-over";
  };
  frame();
  sim.timer = setInterval(frame, 1000 / 30);

  // drag to pan (touch or mouse), like moving the phone
  let drag = null;
  view.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; sim.goal = null; });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const r = view.getBoundingClientRect();
    const k2 = (view.width * sim.zoom) / Math.max(1, r.width);
    sim.aim.x -= (e.clientX - drag.x) * k2;
    sim.aim.y -= (e.clientY - drag.y) * k2;
    drag = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("pointerup", () => { drag = null; });
  window.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT")) return;
    sim.keys.add(e.key.toLowerCase());
  });
  window.addEventListener("keyup", (e) => sim.keys.delete(e.key.toLowerCase()));

  sim.lookAt = (x, y, dur = 0) => {
    if (!dur) { sim.aim.x = x; sim.aim.y = y; sim.goal = null; return; }
    sim.goal = { x0: sim.aim.x, y0: sim.aim.y, x, y, t0: performance.now(), dur };
  };
  // Objects ranked by how well they match a target (game distance).
  sim.rank = (lab) => objects.map((o) => ({ o, de: distance(lab, o.lab) })).sort((a, b) => a.de - b.de);
  sim.stop = () => clearInterval(sim.timer);
  return sim;
}

function makeNoise(rand) {
  const c = document.createElement("canvas");
  c.width = 470;
  c.height = 790;
  const x = c.getContext("2d");
  const img = x.createImageData(c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 128 + (rand() - 0.5) * 120;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
    img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

function shade(rgb, k) {
  return rgbToHex(rgb[0] * k, rgb[1] * k, rgb[2] * k);
}

function paintWorld(w, rand) {
  // wall and floor
  const wall = [196 + rand() * 30, 188 + rand() * 26, 172 + rand() * 30];
  const floorY = WORLD * (0.62 + rand() * 0.08);
  let g = w.createLinearGradient(0, 0, 0, floorY);
  g.addColorStop(0, shade(wall, 1.0));
  g.addColorStop(1, shade(wall, 0.78));
  w.fillStyle = g;
  w.fillRect(0, 0, WORLD, floorY);
  const wood = [120 + rand() * 40, 82 + rand() * 30, 52 + rand() * 20];
  g = w.createLinearGradient(0, floorY, 0, WORLD);
  g.addColorStop(0, shade(wood, 0.8));
  g.addColorStop(1, shade(wood, 1.05));
  w.fillStyle = g;
  w.fillRect(0, floorY, WORLD, WORLD - floorY);
  w.globalAlpha = 0.18;
  for (let i = 0; i < 26; i++) {
    w.fillStyle = shade(wood, 0.7 + rand() * 0.5);
    w.fillRect(0, floorY + i * 46 + rand() * 10, WORLD, 2 + rand() * 4);
  }
  w.globalAlpha = 1;
  // a soft window light
  const lx = WORLD * (0.2 + rand() * 0.6);
  g = w.createRadialGradient(lx, WORLD * 0.2, 50, lx, WORLD * 0.3, WORLD * 0.75);
  g.addColorStop(0, "rgba(255,250,235,0.28)");
  g.addColorStop(1, "rgba(255,250,235,0)");
  w.fillStyle = g;
  w.fillRect(0, 0, WORLD, WORLD);

  // objects on a jittered grid
  const objects = [];
  const cols = 7, rows = 7;
  const cw = WORLD / cols, ch = WORLD / rows;
  const targets = PALETTE.slice().sort(() => rand() - 0.5);
  let t = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rand() < 0.08) continue;
      const kind = rand();
      let lab;
      if (kind < 0.62) {
        // something close-ish to a palette colour (real things are never exact)
        const p = targets[t++ % targets.length];
        const off = 2 + rand() * 13;
        const v = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
        const m = Math.hypot(...v) || 1;
        lab = [p.lab[0] + (v[0] / m) * off, p.lab[1] + (v[1] / m) * off, p.lab[2] + (v[2] / m) * off];
      } else if (kind < 0.86) {
        lab = [30 + rand() * 55, (rand() - 0.5) * 90, (rand() - 0.5) * 90];
      } else {
        lab = [20 + rand() * 70, (rand() - 0.5) * 6, (rand() - 0.5) * 8];
      }
      const rgb = labToRgb(...lab);
      const bw = cw * (0.42 + rand() * 0.38), bh = ch * (0.36 + rand() * 0.42);
      const x = c * cw + (cw - bw) * rand(), y = r * ch + (ch - bh) * rand();
      const round = rand() < 0.35;
      // shadow
      w.fillStyle = "rgba(0,0,0,0.22)";
      w.beginPath();
      if (round) w.ellipse(x + bw / 2 + 14, y + bh / 2 + 18, bw / 2, bh / 2, 0, 0, Math.PI * 2);
      else w.roundRect(x + 14, y + 18, bw, bh, 18);
      w.fill();
      // body with a top light
      const gg = w.createLinearGradient(0, y, 0, y + bh);
      gg.addColorStop(0, shade(rgb, 1.1));
      gg.addColorStop(0.55, shade(rgb, 1.0));
      gg.addColorStop(1, shade(rgb, 0.84));
      w.fillStyle = gg;
      w.beginPath();
      if (round) w.ellipse(x + bw / 2, y + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
      else w.roundRect(x, y, bw, bh, 18);
      w.fill();
      // a glint, a label or a stripe now and then
      if (rand() < 0.3) {
        w.fillStyle = "rgba(255,255,255,0.35)";
        w.beginPath();
        w.ellipse(x + bw * 0.3, y + bh * 0.22, bw * 0.12, bh * 0.05, -0.4, 0, Math.PI * 2);
        w.fill();
      }
      if (!round && rand() < 0.3) {
        w.fillStyle = rgbToHex(...hexToRgb(rgbToHex(...rgb)).map((v2) => 255 - v2 * 0.6));
        w.fillRect(x + bw * 0.12, y + bh * 0.62, bw * 0.76, Math.max(10, bh * 0.08));
      }
      // what the middle of it actually looks like (lighting included)
      const mid = labToRgb(...lab);
      objects.push({ x: x + bw / 2, y: y + bh * 0.42, w: bw, h: bh, lab, hex: rgbToHex(...mid) });
    }
  }
  return objects;
}

// The autopilot: picks something good (not always the best), walks the aim
// there in a human-ish way, then presses the shutter.
export function createAutopilot(sim, { skill = 0.7, snap, match }) {
  let timers = [];
  const clear = () => { for (const t of timers) clearTimeout(t); timers = []; };
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  return {
    skill,
    hunt(targetLab, durMs) {
      clear();
      const t0 = performance.now();
      const left = () => durMs - (performance.now() - t0);
      const ranked = sim.rank(targetLab);
      // a sharper eye goes for the best candidates; everyone wanders a bit first
      const first = Math.min(ranked.length - 1, Math.floor(Math.pow(Math.random(), 1 + skill * 4) * 4));
      const wander = ranked[Math.min(ranked.length - 1, 6 + Math.floor(Math.random() * 10))].o;
      const t1 = 400 + Math.random() * 900;
      sim.lookAt(wander.x, wander.y, t1);
      const visit = (k, tries) => {
        const o = ranked[Math.min(ranked.length - 1, k)].o;
        const travel = 700 + (1 - skill) * 2200 * Math.random();
        sim.lookAt(o.x + (Math.random() - 0.5) * o.w * 0.16, o.y + (Math.random() - 0.5) * o.h * 0.1, travel);
        later(travel + 350, () => {
          const m = match ? match() : 1;
          const dither = (1 - skill) * Math.random() * Math.min(9000, durMs * 0.3);
          if (m < 0.55 && tries < 3 && left() > 5000) visit(k + 1, tries + 1);
          else later(Math.min(Math.max(0, left() - 500), 250 + dither), () => snap && snap());
        });
      };
      later(t1 + 120, () => visit(first, 0));
    },
    stop: clear,
  };
}
