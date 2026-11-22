// The palette card: your game as one shareable image, drawn on this phone from
// your own photos. Nothing is uploaded to make it.

import { pct, heat } from "./color.js";

const INK = "#0f0f11", PAPER = "#f4f0e8", PINK = "#1b1a17", DIM = "#77716a";
const SPECTRUM = ["#d64a5a", "#e8762a", "#e6c84a", "#a3c43c", "#5fb36a", "#2fa39a", "#5ea4e0", "#3e5fb8", "#7b4fb0", "#d64a8a"];

function img(src) {
  return new Promise((res) => {
    if (!src) return res(null);
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = src;
  });
}

function rr(x, X, Y, W, H, R) {
  x.beginPath();
  x.roundRect(X, Y, W, H, R);
}

export async function makeCard({ name, history, total, place, label }) {
  try {
    await Promise.all([
      document.fonts.load('800 80px "Bricolage Grotesque"'),
      document.fonts.load('600 30px "Bricolage Grotesque"'),
      document.fonts.load('500 26px "DM Mono"'),
    ]);
  } catch {}
  const W = 1080, PAD = 64, ROW = 200, HEAD = 330, FOOT = 120;
  const H = HEAD + history.length * ROW + FOOT;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  x.fillStyle = INK;
  x.fillRect(0, 0, W, H);
  // spectrum bar
  const bw = W / SPECTRUM.length;
  SPECTRUM.forEach((s, i) => { x.fillStyle = s; x.fillRect(i * bw, 0, bw + 1, 14); });
  // title
  x.textBaseline = "alphabetic";
  x.font = '800 104px "Bricolage Grotesque", sans-serif';
  const letters = [["c", "#d64a5a"], ["h", "#e8762a"], ["r", "#e6c84a"], ["o", PAPER], ["m", "#5fb36a"], ["a", "#5ea4e0"]];
  let tx = PAD;
  for (const [ch, col] of letters) {
    x.fillStyle = col;
    x.fillText(ch, tx, 150);
    tx += x.measureText(ch).width - 4;
  }
  x.fillStyle = PAPER;
  x.font = '700 104px "Bricolage Grotesque", sans-serif';
  x.fillText(" hunt", tx, 150);
  x.font = '500 28px "DM Mono", monospace';
  x.fillStyle = "#a7a39c";
  x.fillText([label, new Date().toLocaleDateString()].filter(Boolean).join(" · ").toUpperCase(), PAD, 210);
  x.font = '700 46px "Bricolage Grotesque", sans-serif';
  x.fillStyle = PAPER;
  x.fillText(`${name || "Me"}: ${Math.round(total).toLocaleString("en-US")} pts${place ? ` · ${place}` : ""}`, PAD, 280);

  const photos = await Promise.all(history.map((h) => img(h.photo && h.photo.src)));
  history.forEach((h, i) => {
    const y = HEAD + i * ROW;
    // paint chip of the target
    x.fillStyle = PAPER;
    rr(x, PAD, y, 300, ROW - 30, 18);
    x.fill();
    x.fillStyle = h.target.hex;
    rr(x, PAD + 12, y + 12, 276, 92, 12);
    x.fill();
    x.fillStyle = PINK;
    x.font = '800 32px "Bricolage Grotesque", sans-serif';
    x.fillText(h.target.name, PAD + 16, y + 140);
    x.fillStyle = DIM;
    x.font = '500 20px "DM Mono", monospace';
    x.fillText(h.target.hex.toUpperCase(), PAD + 16, y + 162);
    // the photo
    const px = PAD + 330, ps = ROW - 30;
    x.save();
    rr(x, px, y, ps, ps, 18);
    x.clip();
    if (photos[i]) x.drawImage(photos[i], px, y, ps, ps);
    else {
      x.fillStyle = "#1c1c20";
      x.fillRect(px, y, ps, ps);
    }
    x.restore();
    if (photos[i] && h.photo && h.photo.ring) {
      x.strokeStyle = "#fff";
      x.lineWidth = 3;
      x.beginPath();
      x.arc(px + ps / 2, y + ps / 2, (ps * h.photo.ring) / 2, 0, Math.PI * 2);
      x.stroke();
    }
    // found colour + score
    const fx = px + ps + 30;
    const row = h.row;
    if (row && !row.miss) {
      x.fillStyle = row.hex;
      x.beginPath();
      x.arc(fx + 34, y + 44, 34, 0, Math.PI * 2);
      x.fill();
      x.strokeStyle = PAPER;
      x.lineWidth = 4;
      x.stroke();
      x.fillStyle = PAPER;
      x.font = '800 76px "Bricolage Grotesque", sans-serif';
      x.fillText(`${pct(row.match)}%`, fx + 86, y + 72);
      x.font = '600 28px "Bricolage Grotesque", sans-serif';
      x.fillStyle = "#a7a39c";
      x.fillText(`${heat(row.match)} · +${Math.round(row.pts).toLocaleString("en-US")}`, fx, y + 128);
      x.font = '500 22px "DM Mono", monospace';
      x.fillText(`ΔE ${Number(row.de).toFixed(1)} · looks like ${row.look || ""}`, fx, y + 162);
    } else {
      x.fillStyle = "#a7a39c";
      x.font = '700 40px "Bricolage Grotesque", sans-serif';
      x.fillText("No snap", fx, y + 90);
    }
  });
  x.fillStyle = "#6f6c67";
  x.font = '500 26px "DM Mono", monospace';
  x.fillText("play.jadon.me/chroma", PAD, H - 56);
  return c;
}

export async function saveCard(canvas, filename) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("no blob");
  const file = new File([blob], filename, { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Chroma Hunt" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
