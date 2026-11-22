// Fill a real room with bot phones that hunt at human-ish speed and send fake photos.
//
//   node test/bots.js CODE [N=4] [ws://localhost:3130/]
//
// Bots join, turn their "cameras" on, and play every round until the room is gone.

import WebSocket from "ws";
import { labToHex, labToRgb, clamp } from "../public/js/color.js";
import { fakePhoto } from "./png.js";

const [code, nArg, url = "ws://localhost:3130/"] = process.argv.slice(2);
if (!code) {
  console.log("usage: node test/bots.js CODE [N] [ws-url]");
  process.exit(1);
}
const NAMES = ["Mika", "Theo", "Rosa", "Kai", "Lena", "Omar", "Pia", "Sol", "Wren", "Yuki"];
const n = Math.max(1, Math.min(10, Number(nArg) || 4));

function bot(i) {
  const name = NAMES[i % NAMES.length];
  const skill = 0.3 + 0.65 * Math.random();
  const ws = new WebSocket(url);
  let pid = null;
  const timers = [];
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  ws.on("open", () => send({ t: "join", code, name }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.t === "joined") {
      pid = m.pid;
      send({ t: "ready", cam: "live" });
      console.log(`${name} joined ${m.code} (skill ${skill.toFixed(2)})`);
    }
    if (m.t === "err") {
      console.log(`${name}: ${m.msg}`);
      ws.close();
    }
    if (m.t === "announce" && m.ids.includes(pid)) {
      const huntIn = Math.max(0, m.huntAt - Date.now());
      const dist = 2 + (1 - skill) * 24 * Math.random();
      const v = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
      const k = Math.hypot(...v) || 1;
      const lab = [clamp(m.target.lab[0] + (v[0] / k) * dist, 2, 98), m.target.lab[1] + (v[1] / k) * dist, m.target.lab[2] + (v[2] / k) * dist].map((x) => +x.toFixed(2));
      const hex = labToHex(lab);
      const at = Math.round(Math.min(m.dur - 600, 2500 + Math.random() * m.dur * (0.75 - skill * 0.45)));
      // live meter wobbling up towards the find
      for (let t = 300; t < at; t += 300) {
        timers.push(setTimeout(() => {
          const p = t / at;
          const near = p > 0.7;
          const mm = near ? 0.4 + 0.5 * p * Math.random() : 0.05 + 0.4 * Math.random();
          send({ t: "live", r: m.r, m: +mm.toFixed(3), c: near ? hex : labToHex([40 + Math.random() * 40, (Math.random() - 0.5) * 80, (Math.random() - 0.5) * 80]) });
        }, huntIn + t));
      }
      timers.push(setTimeout(() => {
        send({ t: "snap", r: m.r, ms: at, lab, hex, auto: false, thumb: fakePhoto(labToRgb(...lab), 120, pid * 131 + m.r) });
      }, huntIn + at));
    }
  });
  ws.on("close", () => {
    for (const t of timers) clearTimeout(t);
    console.log(`${name} left`);
  });
}

for (let i = 0; i < n; i++) setTimeout(() => bot(i), i * 250);
