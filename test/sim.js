/*
 * Headless test of the server: boots it at 5% speed, connects bot phones (and a
 * bot big screen), plays whole matches and checks the flow, the scoring, the
 * memory round's secrecy, and that photo thumbnails are only held in memory
 * during a round's reveal.
 *
 *   node test/sim.js
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { distance, scoreSnap, labToHex, labToRgb, clamp } from "../public/js/color.js";
import { fakePhoto } from "./png.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3998;
const URL = `ws://127.0.0.1:${PORT}/`;
const TS = 0.05;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.log("  FAIL:", msg);
  }
}
function unit3() {
  const v = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5];
  const m = Math.hypot(...v) || 1;
  return v.map((x) => x / m);
}

class Bot {
  constructor(name, opts = {}) {
    this.name = name;
    this.opts = { skill: Math.random(), thumbs: true, auto: false, play: true, bad: null, ...opts };
    this.ws = new WebSocket(URL);
    this.handlers = new Set();
    this.scored = [];
    this.sent = new Map();
    this.timers = [];
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      this.onMsg(m);
      for (const h of [...this.handlers]) h(m);
    });
  }
  open() {
    return new Promise((r) => this.ws.once("open", r));
  }
  send(m) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }
  next(t, timeout = 8000, pred = () => true) {
    return new Promise((res, rej) => {
      const to = setTimeout(() => {
        this.handlers.delete(h);
        rej(new Error(`${this.name}: no ${t} within ${timeout} ms`));
      }, timeout);
      const h = (m) => {
        if (m.t === t && pred(m)) {
          clearTimeout(to);
          this.handlers.delete(h);
          res(m);
        }
      };
      this.handlers.add(h);
    });
  }
  onMsg(m) {
    if (m.t === "joined") {
      this.pid = m.pid;
      this.code = m.code;
      this.key = m.key;
    }
    if (m.t === "announce" && this.opts.play && m.ids.includes(this.pid)) this.hunt(m);
    if (m.t === "scored") this.scored.push(m);
  }
  hunt(m) {
    const o = this.opts;
    const huntIn = Math.max(0, m.huntAt - Date.now());
    const dist = 2 + (1 - o.skill) * 26 * Math.random();
    const v = unit3();
    const lab = [clamp(m.target.lab[0] + v[0] * dist, 1, 99), m.target.lab[1] + v[1] * dist, m.target.lab[2] + v[2] * dist].map((x) => +x.toFixed(2));
    const hex = labToHex(lab);
    const at = o.auto ? m.dur - 20 : Math.round(m.dur * (0.08 + 0.7 * (1 - o.skill) * Math.random()));
    for (let k = 1; k <= 3; k++) {
      this.timers.push(setTimeout(() => this.send({ t: "live", r: m.r, m: Math.random(), c: hex }), huntIn + (at * k) / 4));
    }
    this.timers.push(
      setTimeout(() => {
        let thumb = null;
        if (o.bad === "magic") thumb = "data:image/png;base64," + Buffer.from("GIF89a" + "x".repeat(90)).toString("base64");
        else if (o.bad === "big") thumb = "data:image/jpeg;base64,/9j/" + "A".repeat(65000);
        else if (o.thumbs) thumb = fakePhoto(labToRgb(...lab), 96, (this.pid || 1) * 977 + m.r);
        this.sent.set(m.r, { lab, auto: o.auto, target: m.target.lab, dur: m.dur, mult: m.mult, at, thumb: !!thumb });
        this.send({ t: "snap", r: m.r, ms: at, lab, hex, auto: o.auto, thumb });
      }, huntIn + at)
    );
  }
  checkScores() {
    for (const s of this.scored) {
      const sent = this.sent.get(s.r);
      if (!sent) { check(false, `${this.name}: scored a round it never snapped`); continue; }
      const want = scoreSnap({ de: distance(sent.target, sent.lab), t: s.ms, dur: sent.dur, auto: sent.auto, mult: sent.mult });
      check(s.pts === want.pts, `${this.name} r${s.r}: server says ${s.pts} pts, colour maths says ${want.pts}`);
      if (sent.auto) check(s.ms === sent.dur && s.speedPts === 0, `${this.name}: auto snap should take full time, no speed bonus`);
      else check(Math.abs(s.ms - sent.at) <= 5, `${this.name}: snap time ${s.ms} vs claimed ${sent.at}`);
    }
  }
  close() {
    for (const t of this.timers) clearTimeout(t);
    this.ws.close();
  }
}

let statsBot = null;
async function stats() {
  statsBot.send({ t: "stats" });
  return statsBot.next("stats", 2000);
}

async function makeRoom(n, botOpts = () => ({})) {
  const bots = [];
  for (let i = 0; i < n; i++) bots.push(new Bot(`bot${i + 1}`, botOpts(i)));
  await Promise.all(bots.map((b) => b.open()));
  const host = bots[0];
  host.send({ t: "create", name: host.name });
  const j = await host.next("joined");
  for (const b of bots.slice(1)) {
    b.send({ t: "join", code: j.code, name: b.name });
    await b.next("joined");
  }
  return { bots, host, code: j.code };
}

async function party(n, { display = false, rounds = 6, secs = 30, label }) {
  const { bots, host, code } = await makeRoom(n, (i) => ({
    skill: n === 1 ? 0.7 : i / Math.max(1, n - 1),
    auto: n > 2 && i === n - 1,
    thumbs: i !== 1,
  }));
  let tv = null;
  if (display) {
    tv = new Bot("tv", { play: false });
    await tv.open();
    tv.send({ t: "join", code, display: true });
    await tv.next("joined");
  }
  for (const b of bots) b.send({ t: "ready", cam: "live" });
  host.send({ t: "settings", rounds, secs });
  await wait(80);
  const watcher = tv || host;
  const wantThumbs = n > 1 || display;

  const announces = [];
  const reveals = [];
  const thumbsByRound = new Map();
  let memLives = 0, memLeak = 0, statsChecks = [];
  watcher.handlers.add((m) => {
    if (m.t === "announce") {
      announces.push(m);
      if (m.r > 1) statsChecks.push(stats().then((s) => check(s.thumbBytes === 0, `${label}: ${s.thumbBytes} thumbnail bytes still held after round ${m.r - 1}'s reveal`)));
    }
    if (m.t === "reveal") {
      reveals.push(m);
      const held = m.rows.filter((r) => r.thumb).length;
      statsChecks.push(stats().then((s) => check(s.thumbs === held, `${label} r${m.r}: server holds ${s.thumbs} thumbs, reveal promised ${held}`)));
    }
    if (m.t === "thumb") thumbsByRound.set(m.r, (thumbsByRound.get(m.r) || 0) + 1);
    const a = announces[announces.length - 1];
    if (a && a.kind === "memory" && m.t === "lives") {
      memLives++;
      if (m.p.some((x) => x[1] !== null)) memLeak++;
    }
    if (a && a.kind === "memory" && m.t === "locked" && (m.m !== null || m.hex !== null)) memLeak++;
  });

  host.send({ t: "start" });
  const intro = await host.next("intro");
  check(intro.n === rounds && intro.players === n && intro.solo === (n === 1), `${label}: intro ${JSON.stringify(intro)}`);
  const over = await host.next("over", 90000);
  await Promise.all(statsChecks);

  // Round structure
  check(announces.length === rounds, `${label}: ${announces.length} rounds announced, expected ${rounds}`);
  const names = announces.map((a) => a.target.name);
  check(new Set(names).size === rounds, `${label}: a colour repeated (${names.join(", ")})`);
  check(announces[rounds - 1].kind === "final" && announces[rounds - 1].mult === 2, `${label}: last round is not the double-points final`);
  const mem = announces.filter((a) => a.kind === "memory");
  check(mem.length === (rounds >= 5 ? 1 : 0), `${label}: ${mem.length} memory rounds`);
  if (mem.length) check(memLives > 0 && memLeak === 0, `${label}: memory round leaked match info (${memLeak} of ${memLives})`);
  const tiers = announces.map((a) => a.target.tier);
  check(tiers.every((t, i) => i === 0 || t >= tiers[i - 1]), `${label}: tiers not rising: ${tiers.join(",")}`);
  for (const a of announces) check(a.wantThumbs === wantThumbs, `${label}: wantThumbs ${a.wantThumbs}, expected ${wantThumbs}`);

  // Reveals: sorted, ranked, thumbs only from bots that sent good ones
  for (const rv of reveals) {
    check(rv.rows.length === n, `${label} r${rv.r}: ${rv.rows.length} rows`);
    for (let i = 1; i < rv.rows.length; i++) {
      const a = rv.rows[i - 1], b = rv.rows[i];
      check(a.pts >= b.pts, `${label} r${rv.r}: rows out of order`);
      check(b.rank === (a.pts === b.pts ? a.rank : i + 1), `${label} r${rv.r}: bad rank ${b.rank} at ${i}`);
    }
    const promised = rv.rows.filter((r) => r.thumb).length;
    const sentGood = bots.filter((b) => b.sent.get(rv.r) && b.sent.get(rv.r).thumb).length;
    check(promised === (wantThumbs ? sentGood : 0), `${label} r${rv.r}: ${promised} thumbs held, ${sentGood} sent, wantThumbs ${wantThumbs}`);
    check((thumbsByRound.get(rv.r) || 0) === promised, `${label} r${rv.r}: watcher got ${thumbsByRound.get(rv.r) || 0} thumbs of ${promised}`);
  }

  // Totals add up, standings sorted, winner on top
  const sum = new Map();
  for (const rv of reveals) for (const r of rv.rows) sum.set(r.id, (sum.get(r.id) || 0) + r.pts);
  for (const s of over.standings) check(sum.get(s.id) === s.total, `${label}: pid ${s.id} total ${s.total}, rounds sum to ${sum.get(s.id)}`);
  for (let i = 1; i < over.standings.length; i++) check(over.standings[i - 1].total >= over.standings[i].total, `${label}: standings out of order`);
  check(n === 1 ? over.winner === null && over.solo : over.winner === over.standings[0].id, `${label}: winner ${over.winner}`);
  check(over.history.length === rounds && over.awards.eye, `${label}: history/awards missing`);
  for (const b of bots) b.checkScores();
  const after = await stats();
  check(after.thumbBytes === 0, `${label}: ${after.thumbBytes} thumbnail bytes held after the game`);

  const top = over.standings[0];
  console.log(
    `${label.padEnd(16)} ok  ${reveals.length} rounds: ${names.join(" → ")}`,
    `| top ${top.total} pts`,
    `| thumbs/round ${[...thumbsByRound.values()].join(",") || 0}`
  );

  // play again straight from the results
  host.send({ t: "start" });
  await host.next("intro");
  for (const b of bots) b.close();
  if (tv) tv.close();
  await wait(100);
}

async function edgeCases() {
  // bad code, cleaned names
  const a = new Bot("a", { play: false });
  await a.open();
  a.send({ t: "join", code: "ZZZZ", name: "x" });
  check((await a.next("err")).code === "noroom", "bad code accepted");
  a.send({ t: "create", name: "  <b>Al</b>  " });
  const j = await a.next("joined");
  const room = await a.next("room");
  check(room.players[0].name === "bAl/b", `name not cleaned: "${room.players[0].name}"`);

  // nobody ready -> can't start
  a.send({ t: "start" });
  check((await a.next("err")).code === "noready", "started with no cameras");

  // non-host can't change settings; host can; junk ignored
  const b = new Bot("b", { play: false });
  await b.open();
  b.send({ t: "join", code: j.code, name: "b" });
  await b.next("joined");
  b.send({ t: "settings", rounds: 4, secs: 60 });
  await wait(60);
  a.send({ t: "settings", rounds: 8, secs: 99 });
  const rs = await a.next("room", 2000, (m) => m.settings.rounds === 8);
  check(rs.settings.secs === 45, `junk secs accepted: ${rs.settings.secs}`);

  // rejoin with key, refused with a wrong key
  a.ws.close();
  await wait(80);
  const a2 = new Bot("a2", { play: false });
  await a2.open();
  a2.send({ t: "rejoin", code: j.code, pid: j.pid, key: j.key });
  check((await a2.next("joined")).pid === j.pid, "rejoin gave a new pid");
  const bad = new Bot("bad", { play: false });
  await bad.open();
  bad.send({ t: "rejoin", code: j.code, pid: j.pid, key: "nope" });
  check((await bad.next("err")).code === "norejoin", "wrong key accepted");
  bad.close();

  // room fills at 10
  const extra = [];
  for (let i = 0; i < 8; i++) {
    const e = new Bot(`e${i}`, { play: false });
    await e.open();
    e.send({ t: "join", code: j.code, name: `e${i}` });
    await e.next("joined");
    extra.push(e);
  }
  const eleventh = new Bot("eleventh", { play: false });
  await eleventh.open();
  eleventh.send({ t: "join", code: j.code, name: "late" });
  check((await eleventh.next("err")).code === "full", "eleventh hunter got in");
  eleventh.close();
  for (const e of extra) e.close();
  a2.close();
  b.close();
  await wait(100);

  // a display can start; a late joiner hunts from the next round; a leaver's photo goes with them;
  // bad thumbnails are dropped but the snap still counts; a lying snap time is pulled into line.
  const { bots, host, code } = await makeRoom(2, (i) => ({ skill: 0.8, bad: i === 1 ? "magic" : null }));
  const tv = new Bot("tv", { play: false });
  await tv.open();
  tv.send({ t: "join", code, display: true });
  await tv.next("joined");
  for (const x of bots) x.send({ t: "ready", cam: "live" });
  tv.send({ t: "settings", rounds: 4, secs: 60 }); // hunts last 3 s at this speed
  await wait(60);
  tv.send({ t: "start" });
  await tv.next("intro");
  const ann1 = await tv.next("announce");
  const late = new Bot("late", { skill: 0.9 });
  await late.open();
  late.send({ t: "join", code, name: "late" });
  await late.next("joined");
  late.send({ t: "ready", cam: "photo" });
  check(!ann1.ids.includes(late.pid), "late joiner was put in the running round");
  const rv1 = await tv.next("reveal");
  const r1bad = rv1.rows.find((r) => r.id === bots[1].pid);
  check(r1bad && !r1bad.miss && !r1bad.thumb, "bad-magic thumbnail should be dropped, snap kept");
  const liar = bots[0];
  liar.opts.play = false; // hunts by hand from round 2 on
  const ann2 = await tv.next("announce");
  check(ann2.ids.includes(late.pid), "late joiner not in the next round");

  // a liar: snaps 2.9 s into round 2 but claims 0 ms. Allowed slack is 2.5 s.
  await wait(Math.max(0, ann2.huntAt - Date.now()) + 2900);
  liar.send({ t: "snap", r: ann2.r, ms: 0, lab: ann2.target.lab, hex: ann2.target.hex, thumb: null });
  const sc = await liar.next("scored");
  check(sc.ms >= 350, `snap time not clamped: ${sc.ms} ms`);
  check(sc.de < 0.01 && sc.match > 0.999, `exact colour should match 100%: ΔE ${sc.de}`);

  // bots[1] leaves for good during the round-2 reveal: its thumbnail must go
  const rv2 = await tv.next("reveal");
  const s1 = await stats();
  bots[1].send({ t: "leave" });
  await wait(80);
  const s2 = await stats();
  const hadThumb = rv2.rows.find((r) => r.id === bots[1].pid)?.thumb;
  check(!hadThumb || s2.thumbs === s1.thumbs - 1, `leaver's thumbnail kept (${s1.thumbs} -> ${s2.thumbs})`);
  const over = await tv.next("over", 30000);
  check(over.standings.some((s) => s.id === late.pid), "late joiner missing from standings");
  check(over.standings.find((s) => s.id === bots[1].pid)?.left === true, "leaver not marked as left");
  for (const x of bots) x.close();
  late.close();
  tv.close();
  await wait(80);

  // Daily palette: two separate solo rooms get the same colours
  const pal = [];
  for (let k = 0; k < 2; k++) {
    const s = new Bot(`daily${k}`, { skill: 0.5 });
    await s.open();
    s.send({ t: "create", name: "d", daily: true, date: new Date().toISOString().slice(0, 10) });
    await s.next("joined");
    s.send({ t: "ready", cam: "live" });
    await wait(40);
    s.send({ t: "start" });
    const intro = await s.next("intro");
    check(intro.daily && intro.n === 5, `daily intro wrong: ${JSON.stringify(intro)}`);
    const o = await s.next("over", 30000);
    pal.push(o.history.map((h) => h.target).join(","));
    s.close();
  }
  check(pal[0] === pal[1], `daily palettes differ: ${pal[0]} / ${pal[1]}`);
  const memo = pal[0].split(",");
  check(memo.length === 5, "daily palette should have 5 colours");
  console.log(`edge cases       ok  (today's palette: ${memo.join(" → ")})`);
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", TIME_SCALE: String(TS), CH_TEST: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((res) => srv.stdout.once("data", res));
  statsBot = new Bot("stats", { play: false });
  await statsBot.open();
  const t0 = Date.now();
  try {
    await party(1, { label: "solo", rounds: 4 });
    await party(2, { label: "2 phones", rounds: 6 });
    await party(5, { label: "5 phones + TV", rounds: 6, display: true });
    await party(10, { label: "10 phones + TV", rounds: 8, display: true, secs: 45 });
    await edgeCases();
  } catch (e) {
    failures++;
    console.log("  ERROR:", e.message);
  }
  statsBot.close();
  srv.kill();
  console.log(`\n${checks} checks, ${failures} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(failures ? 1 : 0);
}

main();
