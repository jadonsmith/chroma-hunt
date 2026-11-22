/*
 * Chroma Hunt: static file server + WebSocket game server in one Node process.
 *
 * A room is a party of up to 10 phones, plus any number of big screens (?tv) that
 * only watch. The server owns the clock and the colours: it announces each round's
 * target with the time the hunt opens, phones measure their own snap time from that
 * moment (clock synced over the socket, so lag never decides who was quicker), and
 * the server scores every snap itself from the colour the phone sampled, using the
 * same colour maths the phones use (public/js/color.js).
 *
 * Photos: a phone sends one small thumbnail per round, and only when someone else
 * (another player or a big screen) will see it. Thumbnails live in this process's
 * memory, go out once in the round's reveal, and are deleted as soon as the reveal
 * ends. They are never written anywhere.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WebSocketServer, WebSocket } from "ws";
import { distance, scoreSnap, isHex, clamp } from "./public/js/color.js";
import { pickTargets, tiersFor, mulberry32, hashString, nameOf } from "./public/js/palette.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PORT = Number(process.env.PORT) || 3130;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const TEST_DIR = path.join(__dirname, "test");
// Local only: serves test/ pages (the party harness) at /__test/. The production
// image sets NODE_ENV=production and doesn't contain test/ at all.
const DEV = process.env.CH_DEV === "1" || (process.env.NODE_ENV !== "production" && fs.existsSync(TEST_DIR));
const TEST = process.env.CH_TEST === "1"; // enables the "stats" message for test/sim.js
const QR_JS = require.resolve("qrcode-generator/qrcode.js");

const MAX_PLAYERS = 10;
const MAX_DISPLAYS = 4;
const MAX_ROOMS = 300;
const NAME_MAX = 14;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const COLORS = ["#f4f1ea", "#ffd166", "#7bdff2", "#f7a1c4", "#b8f2a0", "#c3b5ff", "#ffb38a", "#9ae6d8", "#ff8f8f", "#d6e66a", "#9cc4ff", "#f2c4ff"];

const THUMB_MAX = 60000;                 // characters in a thumbnail data URL
const THUMB_BUDGET = 40 * 1024 * 1024;   // all rooms together
const ROUND_CHOICES = [4, 6, 8];
const SECS_CHOICES = [30, 45, 60];
const DAILY = { rounds: 5, secs: 45 };

// TIME_SCALE < 1 speeds every phase up; only the headless tests set it.
const TS = Math.min(1, Math.max(0.01, Number(process.env.TIME_SCALE) || 1));
const INTRO_MS = 4200 * TS;        // "get ready" before the first colour
const ANN_MS = 4800 * TS;          // the colour is shown, then 3-2-1, then the hunt opens
const ANN_MEMORY_MS = 7000 * TS;   // memory rounds show it longer, then hide it
const GRACE_MS = 1800 * TS;        // snaps (auto snaps especially) may land this late
const END_EARLY_MS = 900 * TS;     // everyone has snapped: pause, then reveal
const REVEAL_BASE_MS = 6400 * TS;  // reveal on screen before the next colour
const REVEAL_PER_MS = 700 * TS;    // ...plus a beat for each card
const LIVE_EVERY_MS = 250;
const LOBBY_DROP_MS = 30000;
const EMPTY_ROOM_MS = 120000;

// ---------- static files ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function sendFile(req, res, filePath, { csp = true } = {}) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const mtime = st.mtime.toUTCString();
    if (req.headers["if-modified-since"] === mtime) {
      res.writeHead(304);
      res.end();
      return;
    }
    const ext = path.extname(filePath);
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Last-Modified": mtime,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    if (ext === ".html" && csp) {
      headers["Content-Security-Policy"] = CSP;
      headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()";
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (urlPath === "/vendor/qrcode.js") return sendFile(req, res, QR_JS);
  let root = PUBLIC_DIR;
  if (DEV && urlPath.startsWith("/__test/")) {
    root = TEST_DIR;
    urlPath = urlPath.slice("/__test".length);
  }
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const filePath = path.join(root, path.normalize(urlPath));
  if (!filePath.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  sendFile(req, res, filePath, { csp: root === PUBLIC_DIR });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: 80 * 1024 });

// ---------- helpers ----------
function sendRaw(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 3 << 20) ws.send(data);
}
function send(ws, msg) {
  sendRaw(ws, JSON.stringify(msg));
}
function bcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.connected) sendRaw(p.ws, data);
  for (const ws of room.displays) sendRaw(ws, data);
}

function cleanName(s) {
  return String(s || "")
    .replace(/[\u0000-\u001f\u007f<>&"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
}
function num(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
function randomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
// The daily palette follows the host's own calendar day, within a day of UTC.
function cleanDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + "T00:00:00Z");
  if (!Number.isFinite(t) || Math.abs(t - Date.parse(today() + "T00:00:00Z")) > 86400000) return null;
  return s;
}

// A thumbnail must be a small base64 JPEG, PNG or WebP data URL whose bytes really
// start like that kind of image. Anything else is dropped (the snap still counts).
const THUMB_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function cleanThumb(s) {
  if (typeof s !== "string" || s.length > THUMB_MAX || s.length < 64) return null;
  const m = THUMB_RE.exec(s);
  if (!m) return null;
  const head = Buffer.from(m[2].slice(0, 24), "base64");
  let ok = false;
  if (m[1] === "jpeg") ok = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  else if (m[1] === "png") ok = head.subarray(0, 8).equals(PNG_SIG);
  else ok = head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
  return ok ? s : null;
}

let thumbBytes = 0; // every thumbnail held right now, all rooms

// ---------- rooms ----------
const rooms = new Map(); // code -> Room

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player
    this.displays = new Set();
    this.leader = null;
    this.phase = "lobby"; // lobby | intro | round | reveal | over
    this.settings = { rounds: 6, secs: 45, daily: false, date: null };
    this.match = null;
    this.cur = null;
    this.solo = false;
    this.timer = null;
    this.liveTimer = null;
    this.liveDirty = false;
    this.rosterQueued = false;
    this.nextId = 1;
    this.emptySince = null;
    this.last = null; // reveal/over payload for sockets that reconnect
  }
  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }
  hasAnyone() {
    return this.displays.size > 0 || this.connectedPlayers().length > 0;
  }
  freeColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[this.nextId % COLORS.length];
  }
}

function makeRoom() {
  if (rooms.size >= MAX_ROOMS) return null;
  let code;
  do code = randomCode(); while (rooms.has(code));
  const room = new Room(code);
  rooms.set(code, room);
  return room;
}

function dropThumbs(room) {
  const c = room.cur;
  if (!c || !c.thumbs) return;
  for (const s of c.thumbs.values()) thumbBytes -= s.length;
  c.thumbs.clear();
}

function dropRoom(room) {
  clearTimeout(room.timer);
  clearInterval(room.liveTimer);
  dropThumbs(room);
  rooms.delete(room.code);
}

function effSettings(room) {
  const s = room.settings;
  return s.daily ? { rounds: DAILY.rounds, secs: DAILY.secs, daily: true } : { rounds: s.rounds, secs: s.secs, daily: false };
}

function pubPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    cam: p.cam, // "" until enabled, then "live" or "photo"
    connected: p.connected,
    inMatch: p.inMatch,
    left: p.left,
    total: p.total,
  };
}

function roomMsg(room) {
  return {
    t: "room",
    code: room.code,
    phase: room.phase,
    leader: room.leader,
    solo: room.solo,
    settings: effSettings(room),
    raw: room.settings,
    displays: room.displays.size,
    round: room.cur ? room.cur.r : 0,
    of: room.match ? room.match.n : 0,
    players: [...room.players.values()].map(pubPlayer),
  };
}

function rosterChanged(room) {
  if (room.rosterQueued) return;
  room.rosterQueued = true;
  setImmediate(() => {
    room.rosterQueued = false;
    if (rooms.get(room.code) === room) bcast(room, roomMsg(room));
  });
}

function pickLeader(room) {
  const cur = room.players.get(room.leader);
  if (cur && cur.connected) return;
  const next = room.connectedPlayers()[0] || [...room.players.values()][0] || null;
  room.leader = next ? next.id : null;
}

function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(fn, Math.max(0, ms));
}

function canHunt(p) {
  return p.connected && !!p.cam;
}

// ---------- match flow ----------
function startMatch(room) {
  const ps = room.connectedPlayers().filter(canHunt);
  if (!ps.length) return false;
  const s = effSettings(room);
  const tiers = tiersFor(s.rounds);
  const date = s.daily ? cleanDate(room.settings.date) || today() : null;
  const seed = s.daily ? hashString(`chroma-${date}`) : crypto.randomInt(1, 2 ** 31 - 1);
  const targets = pickTargets(mulberry32(seed), tiers);
  const kinds = targets.map((_, i) => (i === s.rounds - 1 ? "final" : "normal"));
  // One memory round in longer matches (not in the daily palette, which stays pure).
  if (!s.daily && s.rounds >= 5) kinds[Math.floor(s.rounds * 0.6)] = "memory";
  room.match = { n: s.rounds, secs: s.secs, daily: s.daily, date, targets, kinds, history: [] };
  room.solo = ps.length === 1;
  for (const p of room.players.values()) {
    p.inMatch = ps.includes(p);
    p.total = 0;
    p.snaps = [];
  }
  room.cur = null;
  room.last = null;
  room.phase = "intro";
  bcast(room, {
    t: "intro",
    n: s.rounds,
    secs: s.secs,
    daily: s.daily,
    date: room.match.date,
    solo: room.solo,
    players: ps.length,
    at: Date.now() + INTRO_MS,
  });
  rosterChanged(room);
  setTimer(room, INTRO_MS, () => announce(room));
  return true;
}

function roundPlayers(room) {
  // Everyone in the match who can hunt right now, including late arrivals.
  return [...room.players.values()].filter((p) => p.inMatch && !p.left && canHunt(p));
}

function announce(room) {
  dropThumbs(room);
  const m = room.match;
  const i = room.cur ? room.cur.r : 0;
  const target = m.targets[i];
  const kind = m.kinds[i];
  const ids = roundPlayers(room).map((p) => p.id);
  const now = Date.now();
  const lead = kind === "memory" ? ANN_MEMORY_MS : ANN_MS;
  const dur = Math.round(m.secs * 1000 * TS);
  const huntAt = now + lead;
  room.cur = {
    r: i + 1,
    of: m.n,
    target: { name: target.name, hex: target.hex, tier: target.tier, lab: target.lab.map((v) => +v.toFixed(2)) },
    kind,
    mult: kind === "final" ? 2 : 1,
    huntAt,
    endAt: huntAt + dur,
    dur,
    deadline: huntAt + dur + GRACE_MS,
    ids,
    snaps: new Map(),
    thumbs: new Map(),
    lives: new Map(),
    wantThumbs: room.players.size > 1 || room.displays.size > 0,
    resolved: false,
  };
  room.phase = "round";
  room.last = null;
  bcast(room, announceMsg(room));
  rosterChanged(room);
  startLiveLoop(room);
  setTimer(room, room.cur.deadline - now, () => resolve(room));
}

function announceMsg(room) {
  const c = room.cur;
  return {
    t: "announce",
    r: c.r,
    of: c.of,
    target: c.target,
    kind: c.kind,
    mult: c.mult,
    huntAt: c.huntAt,
    endAt: c.endAt,
    dur: c.dur,
    ids: c.ids,
    wantThumbs: c.wantThumbs,
    locked: [...c.snaps.values()].map((s) => [s.id, s.ms, c.kind === "memory" ? null : +s.match.toFixed(3)]),
  };
}

function startLiveLoop(room) {
  clearInterval(room.liveTimer);
  room.liveDirty = true;
  room.liveTimer = setInterval(() => {
    const c = room.cur;
    if (!c || room.phase !== "round") return;
    if (!room.liveDirty) return;
    room.liveDirty = false;
    const hide = c.kind === "memory";
    const p = [];
    for (const id of c.ids) {
      const s = c.snaps.get(id);
      if (s) { p.push([id, hide ? null : +s.match.toFixed(3), hide ? null : s.hex, 1]); continue; }
      const l = c.lives.get(id);
      p.push([id, l && !hide ? l[0] : null, l ? l[1] : null, 0]);
    }
    bcast(room, { t: "lives", r: c.r, p });
  }, LIVE_EVERY_MS);
}

function maybeEndEarly(room) {
  const c = room.cur;
  if (room.phase !== "round" || !c) return;
  // A phone that dropped off doesn't hold the room up (it can still snap if it
  // comes back before the reveal).
  const waiting = c.ids.filter((id) => {
    const p = room.players.get(id);
    return p && !p.left && p.connected && !c.snaps.has(id);
  });
  if (waiting.length === 0) setTimer(room, END_EARLY_MS, () => resolve(room));
}

function rankRows(rows, key) {
  let rank = 0, prev = null;
  rows.forEach((r, i) => {
    if (prev === null || r[key] !== prev) rank = i + 1;
    r.rank = rank;
    prev = r[key];
  });
}

function resolve(room) {
  const c = room.cur;
  if (room.phase !== "round" || !c || c.resolved) return;
  c.resolved = true;
  clearInterval(room.liveTimer);
  const before = standings(room);
  const prevRank = new Map(before.map((s) => [s.id, s.rank]));

  const rows = [];
  for (const id of c.ids) {
    const p = room.players.get(id);
    if (!p) continue;
    const s = c.snaps.get(id);
    if (s) {
      p.total += s.pts;
      p.snaps.push({ r: c.r, match: s.match, ms: s.ms, auto: s.auto, pts: s.pts });
      rows.push({ ...s, thumb: c.thumbs.has(id) });
    } else {
      p.snaps.push({ r: c.r, match: 0, ms: null, auto: false, pts: 0, miss: true });
      rows.push({ id, miss: true, left: !!p.left, pts: 0, match: 0, ms: null });
    }
  }
  rows.sort((a, b) => b.pts - a.pts || b.match - a.match || (a.ms ?? 1e9) - (b.ms ?? 1e9));
  rankRows(rows, "pts");
  const after = standings(room);
  const totals = new Map(after.map((s) => [s.id, s]));
  for (const r of rows) {
    const t = totals.get(r.id);
    r.total = t ? t.total : 0;
    r.pos = t ? t.rank : null;
    r.prevPos = prevRank.get(r.id) ?? null;
  }
  const hits = rows.filter((r) => !r.miss);
  const closest = hits.length ? hits.reduce((a, b) => (b.match > a.match ? b : a)) : null;
  room.match.history.push({ r: c.r, target: c.target.name, hex: c.target.hex, closest: closest ? { id: closest.id, match: closest.match } : null });

  const over = c.r >= room.match.n;
  const wait = REVEAL_BASE_MS + REVEAL_PER_MS * rows.length;
  room.phase = "reveal";
  room.last = {
    t: "reveal",
    r: c.r,
    of: c.of,
    target: c.target,
    kind: c.kind,
    mult: c.mult,
    dur: c.dur,
    rows,
    closest: closest ? closest.id : null,
    standings: after,
    over,
    nextAt: Date.now() + wait,
  };
  bcast(room, room.last);
  for (const [id, src] of c.thumbs) bcast(room, { t: "thumb", r: c.r, id, src });
  rosterChanged(room);
  setTimer(room, wait, () => (over ? finish(room) : announce(room)));
}

function standings(room) {
  const ps = [...room.players.values()].filter((p) => p.inMatch);
  const rows = ps
    .map((p) => ({ id: p.id, total: p.total, left: !!p.left }))
    .sort((a, b) => b.total - a.total || a.id - b.id);
  rankRows(rows, "total");
  return rows;
}

function finish(room) {
  dropThumbs(room);
  clearInterval(room.liveTimer);
  room.phase = "over";
  const m = room.match;
  const rows = standings(room).map((s) => {
    const p = room.players.get(s.id);
    const hits = p.snaps.filter((x) => !x.miss);
    const best = hits.length ? hits.reduce((a, b) => (b.match > a.match ? b : a)) : null;
    const avg = hits.length ? hits.reduce((a, b) => a + b.match, 0) / p.snaps.length : 0;
    return { ...s, avg: +avg.toFixed(3), best: best ? { r: best.r, match: +best.match.toFixed(3) } : null, snapped: hits.length };
  });
  // Awards: sharpest eye (best single match) and quickest draw (fastest snap that was at least warm).
  let eye = null, quick = null;
  for (const p of room.players.values()) {
    if (!p.inMatch) continue;
    for (const s of p.snaps) {
      if (s.miss) continue;
      if (!eye || s.match > eye.match) eye = { id: p.id, r: s.r, match: +s.match.toFixed(3) };
      if (!s.auto && s.match >= 0.55 && (!quick || s.ms < quick.ms)) quick = { id: p.id, r: s.r, ms: s.ms, match: +s.match.toFixed(3) };
    }
  }
  const winner = room.solo || !rows.length ? null : rows[0].id;
  room.last = {
    t: "over",
    solo: room.solo,
    daily: m.daily,
    date: m.date,
    n: m.n,
    winner,
    tie: !room.solo && rows.length > 1 && rows[0].total === rows[1].total,
    standings: rows,
    awards: { eye, quick },
    history: m.history,
  };
  room.cur = null;
  bcast(room, room.last);
  rosterChanged(room);
}

// A player who leaves for good mid-match: their photo goes with them.
function forgetPlayer(room, p) {
  const c = room.cur;
  if (c && c.thumbs.has(p.id)) {
    thumbBytes -= c.thumbs.get(p.id).length;
    c.thumbs.delete(p.id);
  }
  if (c) c.lives.delete(p.id);
}

function afterDeparture(room) {
  if (room.phase === "round") maybeEndEarly(room);
  if (room.phase !== "lobby" && room.phase !== "over") {
    const anyone = [...room.players.values()].some((p) => p.inMatch && !p.left);
    if (!anyone) {
      clearTimeout(room.timer);
      clearInterval(room.liveTimer);
      if (room.match) finish(room);
      else room.phase = "lobby";
    }
  }
}

// ---------- joining ----------
function newPlayer(room, ws, name) {
  const id = room.nextId++;
  const p = {
    id,
    key: crypto.randomBytes(9).toString("base64url"),
    name: name || `Hunter ${id}`,
    color: room.freeColor(),
    ws,
    connected: true,
    discAt: 0,
    cam: "",
    inMatch: false,
    left: false,
    total: 0,
    snaps: [],
    liveAt: 0,
  };
  room.players.set(id, p);
  if (!room.leader) room.leader = id;
  return p;
}

function attachPlayer(ws, room, p) {
  ws.room = room;
  ws.player = p;
  ws.isDisplay = false;
  room.emptySince = null;
  send(ws, { t: "joined", code: room.code, pid: p.id, key: p.key, display: false });
  send(ws, roomMsg(room));
  catchUp(ws, room);
  rosterChanged(room);
}

function attachDisplay(ws, room) {
  ws.room = room;
  ws.player = null;
  ws.isDisplay = true;
  room.displays.add(ws);
  room.emptySince = null;
  if (room.cur && room.phase === "round") room.cur.wantThumbs = true;
  send(ws, { t: "joined", code: room.code, pid: null, display: true });
  send(ws, roomMsg(room));
  catchUp(ws, room);
  rosterChanged(room);
}

// Bring a socket that arrives mid-match up to date.
function catchUp(ws, room) {
  if (room.phase === "intro" && room.match) {
    send(ws, { t: "intro", n: room.match.n, secs: room.match.secs, daily: room.match.daily, date: room.match.date, solo: room.solo, players: roundPlayers(room).length, at: Date.now() });
  } else if (room.phase === "round" && room.cur) {
    send(ws, announceMsg(room));
  } else if (room.phase === "reveal" && room.last) {
    send(ws, room.last);
    for (const [id, src] of room.cur.thumbs) send(ws, { t: "thumb", r: room.cur.r, id, src });
  } else if (room.phase === "over" && room.last) {
    send(ws, room.last);
  }
}

function detach(ws, { forGood = false } = {}) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  if (ws.isDisplay) {
    room.displays.delete(ws);
  } else if (ws.player) {
    const p = ws.player;
    ws.player = null;
    if (p.ws === ws) {
      p.ws = null;
      p.connected = false;
      p.discAt = Date.now();
    }
    if (forGood) {
      forgetPlayer(room, p);
      if (room.phase === "lobby" || room.phase === "over" || !p.inMatch) room.players.delete(p.id);
      else p.left = true;
    }
    pickLeader(room);
    afterDeparture(room);
  }
  if (!room.hasAnyone()) room.emptySince = Date.now();
  rosterChanged(room);
}

function mayControl(ws, room) {
  return ws.isDisplay || (ws.player && room.leader === ws.player.id);
}

// ---------- snaps ----------
function onSnap(ws, msg, now) {
  const room = ws.room;
  const p = ws.player;
  const c = room && room.cur;
  if (!p || !c || room.phase !== "round" || msg.r !== c.r || !c.ids.includes(p.id) || c.snaps.has(p.id)) return;
  if (now > c.deadline + 400 || now < c.huntAt - 400) return;
  const lab = Array.isArray(msg.lab) ? msg.lab.map(Number) : null;
  if (!lab || lab.length !== 3 || !lab.every(Number.isFinite)) return;
  const L = clamp(lab[0], 0, 100), A = clamp(lab[1], -128, 128), B = clamp(lab[2], -128, 128);
  const auto = !!msg.auto;
  // The phone times its own snap from the hunt's start (lag-free); keep the claim
  // honest: no more than 2.5 s before the server got it, and never after it.
  const elapsed = now - c.huntAt;
  const lo = Math.min(c.dur, Math.max(0, elapsed - 2500));
  const hi = Math.max(lo, Math.min(c.dur, elapsed + 400));
  const ms = auto ? c.dur : Math.round(clamp(num(msg.ms, 0, c.dur, elapsed), lo, hi));
  const lab2 = [+L.toFixed(2), +A.toFixed(2), +B.toFixed(2)];
  const de = distance(c.target.lab, lab2);
  const sc = scoreSnap({ de, t: ms, dur: c.dur, auto, mult: c.mult });
  const hex = isHex(msg.hex) ? msg.hex.toLowerCase() : "#808080";
  const snap = {
    id: p.id,
    ms,
    auto,
    lab: lab2,
    hex,
    de: +de.toFixed(2),
    match: +sc.match.toFixed(4),
    matchPts: sc.matchPts,
    speedPts: sc.speedPts,
    pts: sc.pts,
    look: nameOf(lab2),
  };
  c.snaps.set(p.id, snap);
  if (c.wantThumbs) {
    const th = cleanThumb(msg.thumb);
    if (th && thumbBytes + th.length <= THUMB_BUDGET) {
      c.thumbs.set(p.id, th);
      thumbBytes += th.length;
    }
  }
  send(ws, { t: "scored", r: c.r, ...snap });
  bcast(room, { t: "locked", r: c.r, id: p.id, ms, m: c.kind === "memory" ? null : snap.match, hex: c.kind === "memory" ? null : hex });
  room.liveDirty = true;
  maybeEndEarly(room);
}

// ---------- sockets ----------
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.player = null;
  ws.isDisplay = false;
  ws.win = Date.now();
  ws.count = 0;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - ws.win > 1000) { ws.win = now; ws.count = 0; }
    if (++ws.count > 50) return; // flood guard
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;

    switch (msg.t) {
      case "ping":
        send(ws, { t: "pong", c: msg.c, s: Date.now() });
        break;

      case "create": {
        detach(ws, { forGood: true });
        const room = makeRoom();
        if (!room) { send(ws, { t: "err", msg: "The server is full right now. Try again in a minute." }); return; }
        if (msg.daily) room.settings.daily = true;
        room.settings.date = cleanDate(msg.date);
        if (msg.display) attachDisplay(ws, room);
        else attachPlayer(ws, room, newPlayer(room, ws, cleanName(msg.name)));
        break;
      }

      case "join": {
        const code = String(msg.code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
        const room = rooms.get(code);
        if (!room) { send(ws, { t: "err", code: "noroom", msg: "No room with that code. Check it and try again." }); return; }
        if (ws.room === room) return;
        if (msg.display) {
          if (room.displays.size >= MAX_DISPLAYS) { send(ws, { t: "err", msg: "That room already has enough big screens." }); return; }
          detach(ws, { forGood: true });
          attachDisplay(ws, room);
        } else {
          const active = [...room.players.values()].filter((p) => !p.left).length;
          if (active >= MAX_PLAYERS) { send(ws, { t: "err", code: "full", msg: `That room is full (${MAX_PLAYERS} hunters).` }); return; }
          detach(ws, { forGood: true });
          attachPlayer(ws, room, newPlayer(room, ws, cleanName(msg.name)));
        }
        break;
      }

      case "rejoin": {
        const code = String(msg.code || "").toUpperCase().slice(0, 4);
        const room = rooms.get(code);
        const p = room && room.players.get(Number(msg.pid));
        if (!p || p.left || p.key !== msg.key) { send(ws, { t: "err", code: "norejoin", msg: "That game has ended." }); return; }
        if (ws.room && ws.room !== room) detach(ws, { forGood: true });
        if (p.ws && p.ws !== ws) {
          const old = p.ws;
          old.room = null;
          old.player = null;
          try { old.close(4000, "replaced"); } catch {}
        }
        p.ws = ws;
        p.connected = true;
        p.discAt = 0;
        pickLeader(room);
        attachPlayer(ws, room, p);
        break;
      }

      case "ready": {
        const p = ws.player;
        if (!p) return;
        p.cam = msg.cam === "photo" ? "photo" : msg.cam === "live" ? "live" : "";
        // Arriving mid-match? You're in from the next colour.
        const room = ws.room;
        if (p.cam && room.match && room.phase !== "lobby" && room.phase !== "over" && !p.inMatch) {
          p.inMatch = true;
          p.total = 0;
          p.snaps = [];
          room.solo = false;
        }
        rosterChanged(room);
        break;
      }

      case "name": {
        const p = ws.player;
        if (!p || ws.room.phase !== "lobby") return;
        const n = cleanName(msg.name);
        if (n) { p.name = n; rosterChanged(ws.room); }
        break;
      }

      case "settings": {
        const room = ws.room;
        if (!room || !mayControl(ws, room) || (room.phase !== "lobby" && room.phase !== "over")) return;
        if (ROUND_CHOICES.includes(msg.rounds)) room.settings.rounds = msg.rounds;
        if (SECS_CHOICES.includes(msg.secs)) room.settings.secs = msg.secs;
        if (typeof msg.daily === "boolean") room.settings.daily = msg.daily;
        if (msg.date !== undefined) room.settings.date = cleanDate(msg.date) || room.settings.date;
        rosterChanged(room);
        break;
      }

      case "start": {
        const room = ws.room;
        if (!room || !mayControl(ws, room) || (room.phase !== "lobby" && room.phase !== "over")) return;
        if (!startMatch(room)) send(ws, { t: "err", code: "noready", msg: "Nobody has their camera on yet." });
        break;
      }

      case "toLobby": {
        const room = ws.room;
        if (!room || room.phase !== "over" || !mayControl(ws, room)) return;
        room.phase = "lobby";
        room.last = null;
        room.match = null;
        for (const [id, p] of room.players) {
          if (!p.connected || p.left) room.players.delete(id);
          else { p.inMatch = false; p.total = 0; p.snaps = []; }
        }
        pickLeader(room);
        rosterChanged(room);
        break;
      }

      case "live": {
        const room = ws.room;
        const p = ws.player;
        const c = room && room.cur;
        if (!p || !c || room.phase !== "round" || msg.r !== c.r || !c.ids.includes(p.id) || c.snaps.has(p.id)) return;
        if (now - p.liveAt < 150) return;
        p.liveAt = now;
        const m = num(msg.m, 0, 1, null);
        c.lives.set(p.id, [m === null ? null : Math.round(m * 1000) / 1000, isHex(msg.c) ? msg.c.toLowerCase() : null]);
        room.liveDirty = true;
        break;
      }

      case "snap":
        onSnap(ws, msg, now);
        break;

      case "stats":
        if (TEST) send(ws, { t: "stats", rooms: rooms.size, thumbBytes, thumbs: [...rooms.values()].reduce((n, r) => n + (r.cur ? r.cur.thumbs.size : 0), 0) });
        break;

      case "leave":
        detach(ws, { forGood: true });
        send(ws, { t: "left" });
        break;
    }
  });

  ws.on("close", () => detach(ws));
  ws.on("error", () => {});
});

// ---------- housekeeping ----------
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === "lobby" || room.phase === "over") {
      let changed = false;
      for (const [id, p] of room.players) {
        if (!p.connected && now - p.discAt > LOBBY_DROP_MS) {
          room.players.delete(id);
          changed = true;
        }
      }
      if (changed) {
        pickLeader(room);
        rosterChanged(room);
      }
    }
    if (!room.hasAnyone() && room.emptySince && now - room.emptySince > EMPTY_ROOM_MS) dropRoom(room);
  }
}, 5000);

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`Chroma Hunt listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}${DEV ? " (dev pages at /__test/)" : ""}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const ws of wss.clients) { try { ws.close(1001, "server restarting"); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
