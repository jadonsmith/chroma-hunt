// DOM helpers shared by the phone and big-screen views.

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function avatar(p, extra = "") {
  const ch = (p && p.name ? p.name.trim()[0] : "?") || "?";
  return `<span class="av ${extra}" style="--pc:${p ? p.color : "#9a968f"}">${esc(ch.toUpperCase())}</span>`;
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function showScreen(el) {
  const parent = el.parentElement;
  for (const s of parent.children) {
    if (s.classList.contains("screen") || s.classList.contains("tv-screen")) {
      const on = s === el;
      s.classList.toggle("on", on);
      if (s.classList.contains("tv-screen")) s.hidden = !on;
    }
  }
}

export function restartAnim(el, cls) {
  if (cls) el.classList.remove(cls);
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  if (cls) el.classList.add(cls);
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function fmtPts(n) {
  return Math.round(n || 0).toLocaleString("en-US");
}

export function fmtSecs(ms) {
  return (Math.max(0, ms) / 1000).toFixed(1) + " s";
}

export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function joinUrl(code) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  return code ? `${base}?room=${code}` : base;
}

export function qrSvg(text) {
  if (!window.qrcode) return "";
  const q = window.qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const pad = 1;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  }
  const s = n + pad * 2;
  return `<svg viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="QR code to join"><rect width="${s}" height="${s}" fill="#f4f0e8"/><path d="${d}" fill="#1b1a17"/></svg>`;
}

// A photo tile: the thumbnail (or a striped placeholder) with the sampling ring drawn on.
export function photoTile(src, ring = 0.3, label = "no photo") {
  const el = document.createElement("div");
  el.className = "ph";
  if (src) {
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.src = src; // data: URL from this room's reveal, set as a property, never as HTML
    el.appendChild(img);
    const r = document.createElement("span");
    r.className = "ring";
    r.style.setProperty("--ring", `${Math.round(Math.min(0.9, Math.max(0.08, ring)) * 100)}%`);
    el.appendChild(r);
  } else {
    el.classList.add("none");
    el.dataset.l = label;
  }
  return el;
}

export function setPhoto(el, src, ring = 0.3) {
  const fresh = photoTile(src, ring);
  el.className = fresh.className;
  el.dataset.l = fresh.dataset.l || "";
  el.replaceChildren(...fresh.childNodes);
}

// Bursting confetti on a full-screen canvas; returns a stop function.
export function confetti(canvas, colors = ["#d64a5a", "#e8762a", "#e6c84a", "#5fb36a", "#5ea4e0", "#7b4fb0", "#f4f0e8"]) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = 0, h = 0;
  const fit = () => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  };
  fit();
  const ps = [];
  const spawn = (n) => {
    for (let i = 0; i < n; i++) {
      ps.push({
        x: Math.random() * w, y: -20 - Math.random() * h * 0.5,
        vx: (Math.random() - 0.5) * 120, vy: 120 + Math.random() * 220,
        r: 5 + Math.random() * 7, a: Math.random() * 6, va: (Math.random() - 0.5) * 10,
        c: colors[(Math.random() * colors.length) | 0],
      });
    }
  };
  spawn(150);
  let last = performance.now();
  const t0 = last;
  let stopped = false;
  // Physics on a timer, drawing on animation frames (which hidden tabs throttle).
  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (now - t0 < 2400 && ps.length < 380) spawn(3);
    for (const p of ps) {
      p.vy += 40 * dt;
      p.x += (p.vx + Math.sin(p.a) * 40) * dt;
      p.y += p.vy * dt;
      p.a += p.va * dt;
    }
    for (let i = ps.length - 1; i >= 0; i--) if (ps[i].y > h + 30) ps.splice(i, 1);
    if (!ps.length && now - t0 > 2400) stop();
  };
  const timer = setInterval(step, 1000 / 60);
  let raf = 0;
  const draw = () => {
    if (stopped) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const p of ps) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r, -p.r * 0.42, p.r * 2, p.r * 0.84);
      ctx.restore();
    }
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
  window.addEventListener("resize", fit);
  function stop() {
    stopped = true;
    clearInterval(timer);
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", fit);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  return stop;
}
