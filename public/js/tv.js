// The big screen (TV or laptop): the join QR, each colour as it's announced, a
// live race of everyone's camera colours while they hunt, and the gallery reveal.
// It never plays; phones do.

import { Net } from "./net.js";
import { sfx, say, audioCtx, setMuted } from "./audio.js";
import { pct, inkFor } from "./color.js";
import { $, esc, avatar, toast, showScreen, restartAnim, ordinal, fmtPts, fmtSecs, joinUrl, qrSvg, photoTile, setPhoto, confetti } from "./ui.js";

const params = new URLSearchParams(location.search);
const TVKEY = "ch-tv";
const HOT = 0.88;

const st = {
  code: null,
  room: null,
  intro: null,
  ann: null,
  open: false,
  lastDigit: -1,
  sound: false,
  stopConfetti: null,
  cards: new Map(),
  reveal: null,
  thumbs: new Map(),
  revealTimers: [],
  over: null,
};

const scr = { lobby: $("tv-lobby"), stage: $("tv-stage"), over: $("tv-over") };
const net = new Net({ onMsg, onOpen });

export function startTv() {
  $("phone").hidden = true;
  $("tv").hidden = false;
  document.body.classList.add("show-hub", "is-tv");
  setMuted(true);
  showScreen(scr.lobby);
  $("tv-start").addEventListener("click", () => { soundOn(); net.send({ t: "start" }); });
  $("tv-again").addEventListener("click", () => { soundOn(); net.send({ t: "start" }); });
  $("tv-tolobby").addEventListener("click", () => net.send({ t: "toLobby" }));
  $("tv-sound").addEventListener("click", () => (st.sound ? soundOff() : soundOn()));
  $("tv-join").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("tv-join-code").value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    if (code.length !== 4) return toast("Room codes are 4 letters.");
    net.send({ t: "join", code, display: true });
  });
  for (const b of $("tv-rounds").querySelectorAll("button")) b.addEventListener("click", () => net.send({ t: "settings", rounds: Number(b.dataset.v) }));
  for (const b of $("tv-secs").querySelectorAll("button")) b.addEventListener("click", () => net.send({ t: "settings", secs: Number(b.dataset.v) }));
  $("tv-daily").addEventListener("change", (e) => net.send({ t: "settings", daily: e.target.checked, date: localDate() }));
  if (params.has("dev")) window.__tv = { st, net };
  net.connect();
  setInterval(loop, 1000 / 30);
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function soundOn() {
  audioCtx();
  setMuted(false);
  st.sound = true;
  $("tv-sound").textContent = "Sound on";
}
function soundOff() {
  setMuted(true);
  st.sound = false;
  $("tv-sound").textContent = "Turn sound on";
}

function onOpen() {
  const code = st.code || (params.get("room") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) || sessionStorage.getItem(TVKEY);
  if (code) net.send({ t: "join", code, display: true });
  else net.send({ t: "create", display: true, date: localDate() });
}

function onMsg(m) {
  switch (m.t) {
    case "joined":
      st.code = m.code;
      sessionStorage.setItem(TVKEY, m.code);
      history.replaceState(null, "", `${location.pathname}?tv&room=${m.code}${params.has("dev") ? "&dev" : ""}`);
      $("tv-code").textContent = m.code;
      $("tv-codechip").textContent = m.code;
      $("tv-url").textContent = joinUrl().replace(/^https?:\/\//, "").replace(/\/$/, "");
      $("tv-qr").innerHTML = qrSvg(joinUrl(m.code));
      return;
    case "room": return onRoom(m);
    case "intro": return onIntro(m);
    case "announce": return onAnnounce(m);
    case "lives": return onLives(m);
    case "locked": return onLocked(m);
    case "reveal": return onReveal(m);
    case "thumb": return onThumb(m);
    case "over": return onOver(m);
    case "err":
      if (m.code === "noroom") {
        // our room vanished (server restart) or a typo: start a fresh one
        st.code = null;
        sessionStorage.removeItem(TVKEY);
        net.send({ t: "create", display: true, date: localDate() });
        if (m.msg && $("tv-join-code").value) toast(m.msg);
        return;
      }
      toast(m.msg || "Something went wrong.");
  }
}

const player = (id) => (st.room ? st.room.players.find((p) => p.id === id) : null) || { id, name: "Hunter", color: "#9a968f" };

function onRoom(m) {
  st.room = m;
  if (m.phase === "lobby" && !scr.lobby.classList.contains("on")) {
    clearRevealTimers();
    showScreen(scr.lobby);
    document.body.classList.add("show-hub");
  }
  const ps = m.players.filter((p) => !p.left);
  const ready = ps.filter((p) => p.cam && p.connected).length;
  $("tv-count").textContent = ps.length ? `${ps.length}` : "";
  $("tv-empty").hidden = ps.length > 0;
  $("tv-players").innerHTML = ps
    .map((p) => `<li class="${p.connected ? "" : "off"}">${avatar(p)}<span class="pname">${esc(p.name)}<small>${p.cam === "photo" ? "camera app" : p.cam ? "camera on" : "turning camera on…"}</small></span></li>`)
    .join("");
  const btn = $("tv-start");
  btn.disabled = ready === 0;
  btn.textContent = ready ? `Start · ${ready} ready` : "Start";
  const s = m.settings;
  for (const b of $("tv-rounds").querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.v) === s.rounds);
  for (const b of $("tv-secs").querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.v) === s.secs);
  $("tv-rounds").classList.toggle("locked", s.daily);
  $("tv-secs").classList.toggle("locked", s.daily);
  $("tv-daily").checked = s.daily;
  if (st.ann && !st.reveal) markOffline();
}

function stageOn() {
  if (!scr.stage.classList.contains("on")) showScreen(scr.stage);
  document.body.classList.remove("show-hub");
}

function panels(which) {
  for (const id of ["tv-intro", "tv-ann", "tv-hunt", "tv-reveal"]) $(id).hidden = id !== which;
}

function setTarget(hex) {
  scr.stage.style.setProperty("--target", hex);
  scr.stage.style.setProperty("--ann-ink", inkFor(hex));
}

function onIntro(m) {
  st.intro = m;
  st.ann = null;
  st.reveal = null;
  st.thumbs.clear();
  st.over = null;
  clearRevealTimers();
  if (st.stopConfetti) { st.stopConfetti(); st.stopConfetti = null; }
  stageOn();
  panels("tv-intro");
  $("tv-round").textContent = "Get ready";
  $("tv-kind").hidden = true;
  $("tv-intro-kicker").textContent = m.daily ? `Today's palette · ${m.date || ""}` : m.solo ? "Solo hunt" : `${m.players} hunters`;
  $("tv-intro-title").textContent = `${m.n} colours`;
  $("tv-intro-sub").textContent = `${m.secs} seconds to find each one. Real things only, no screens. Closer colour and a quicker snap score more.`;
  restartAnim($("tv-intro-title"));
  say(`${m.n} colours. Get ready!`);
}

function onAnnounce(m) {
  st.ann = m;
  scr.stage.classList.remove("memory");
  st.reveal = null;
  st.open = false;
  st.lastDigit = -1;
  clearRevealTimers();
  stageOn();
  setTarget(m.target.hex);
  const memory = m.kind === "memory";
  $("tv-round").textContent = `Colour ${m.r} of ${m.of}`;
  $("tv-kind").hidden = m.kind === "normal";
  $("tv-kind").textContent = memory ? "Memory round" : m.kind === "final" ? "Final · double points" : "";
  // hunt panel, ready underneath
  const chip = $("tv-chip");
  chip.classList.toggle("memory", false);
  chip.style.setProperty("--c", m.target.hex);
  $("tv-chip-nm").textContent = m.target.name;
  $("tv-chip-hx").textContent = m.target.hex.toUpperCase();
  buildHunters(m);
  const started = performance.now() >= net.toPerf(m.huntAt);
  if (started) {
    openHunt(true);
  } else {
    panels("tv-ann");
    const ov = $("tv-ann");
    ov.classList.remove("go");
    $("tv-ann-kicker").textContent = memory ? "Memorise this one" : m.kind === "final" ? "Last one, double points: find" : "Find something";
    $("tv-ann-name").textContent = m.target.name;
    $("tv-ann-hex").textContent = memory ? "It hides when the hunt starts" : m.target.hex.toUpperCase();
    $("tv-countdown").textContent = "";
    restartAnim($("tv-flood"));
    restartAnim($("tv-ann-name"));
    sfx.whoosh();
    say(memory ? `Memory round. ${m.target.name}.` : `Find something ${m.target.name}!`);
  }
}

function buildHunters(m) {
  const ul = $("tv-hunters");
  const n = m.ids.length;
  ul.style.setProperty("--cols", n <= 2 ? 1 : n <= 6 ? 2 : 3);
  st.cards.clear();
  ul.innerHTML = m.ids
    .map((id) => {
      const p = player(id);
      return `<li class="hunter${m.kind === "memory" ? " mem" : ""}" data-id="${id}" style="--p:0"><span class="live"></span><span class="nm">${esc(p.name)}</span><span class="pc">0%</span><span class="bar"><i></i></span><span class="tag"></span></li>`;
    })
    .join("");
  for (const li of ul.children) st.cards.set(Number(li.dataset.id), li);
  for (const [id, ms, mm] of m.locked) lockCard(id, ms, mm, null);
  $("tv-locked").textContent = `${m.locked.length} of ${n} locked in`;
}

function openHunt(quiet) {
  st.open = true;
  const ov = $("tv-ann");
  if (!ov.hidden && !quiet) {
    ov.classList.add("go");
    setTimeout(() => { if (st.open) panels("tv-hunt"); }, 560);
  } else panels("tv-hunt");
  const mem = !!(st.ann && st.ann.kind === "memory");
  scr.stage.classList.toggle("memory", mem);
  if (mem) $("tv-chip").classList.add("memory");
  if (st.ann && st.ann.kind === "memory") { $("tv-chip-nm").textContent = "Remember?"; $("tv-chip-hx").textContent = "no meters this round"; }
  if (!quiet) {
    sfx.go();
    say("Hunt!");
  }
}

function onLives(m) {
  if (!st.ann || m.r !== st.ann.r) return;
  for (const [id, mm, c, lk] of m.p) {
    const li = st.cards.get(id);
    if (!li) continue;
    if (c) li.querySelector(".live").style.setProperty("--lc", c);
    if (lk) continue;
    if (mm != null) {
      li.style.setProperty("--p", mm);
      li.querySelector(".pc").textContent = `${pct(mm)}%`;
      li.classList.toggle("hot", mm >= HOT);
    }
  }
}

function lockCard(id, ms, mm, hex) {
  const li = st.cards.get(id);
  if (!li || li.classList.contains("lk")) return;
  li.classList.add("lk");
  li.classList.remove("hot");
  if (mm != null) {
    li.style.setProperty("--p", mm);
    li.querySelector(".pc").textContent = `${pct(mm)}%`;
  }
  if (hex) li.querySelector(".live").style.setProperty("--lc", hex);
  li.querySelector(".tag").textContent = ms != null ? `locked · ${fmtSecs(ms)}` : "locked";
}

function onLocked(m) {
  if (!st.ann || m.r !== st.ann.r) return;
  lockCard(m.id, m.ms, m.m, m.hex);
  const n = st.ann.ids.length;
  const k = [...st.cards.values()].filter((li) => li.classList.contains("lk")).length;
  $("tv-locked").textContent = `${k} of ${n} locked in`;
  sfx.lock();
}

function markOffline() {
  for (const [id, li] of st.cards) {
    const p = player(id);
    li.classList.toggle("off", !p.connected || !!p.left);
  }
}

// ---------- reveal ----------
function clearRevealTimers() {
  for (const t of st.revealTimers) clearTimeout(t);
  st.revealTimers = [];
}

function onReveal(m) {
  st.reveal = m;
  scr.stage.classList.remove("memory");
  st.open = false;
  clearRevealTimers();
  stageOn();
  setTarget(m.target.hex);
  panels("tv-reveal");
  $("tv-round").textContent = `Colour ${m.r} of ${m.of}`;
  $("tv-rv-sw").style.background = m.target.hex;
  $("tv-rv-name").textContent = m.target.name;
  const n = m.rows.length;
  const g = $("tv-gallery");
  g.className = `tv-gallery${n === 1 ? " n1" : ""}`;
  const cols = n <= 5 ? n : n === 6 ? 3 : n <= 8 ? 4 : 5;
  g.style.setProperty("--cols", cols);
  g.replaceChildren();
  const cards = m.rows.map((r) => {
    const p = player(r.id);
    const li = document.createElement("li");
    li.className = "gcard";
    li.dataset.id = r.id;
    const src = st.thumbs.get(`${m.r}:${r.id}`);
    li.appendChild(photoTile(src, 0.3, r.miss ? (r.left ? "left" : "no snap") : r.thumb ? "" : "no photo"));
    const rk = document.createElement("span");
    rk.className = "rk";
    rk.textContent = ordinal(r.rank);
    li.appendChild(rk);
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = r.miss
      ? `<span class="pct">—</span>`
      : `<span class="split"><i style="background:${m.target.hex}"></i><i style="background:${r.hex}"></i></span><span class="pct">${pct(r.match)}%</span>`;
    li.appendChild(row);
    const nm = document.createElement("p");
    nm.className = "nm";
    nm.textContent = p.name;
    li.appendChild(nm);
    const pts = document.createElement("p");
    pts.className = "pts";
    pts.textContent = r.miss ? "0 pts" : `+${fmtPts(r.pts)} · ${r.auto ? "auto snap" : fmtSecs(r.ms)}`;
    li.appendChild(pts);
    if (!r.miss && r.look) {
      const lk = document.createElement("p");
      lk.className = "look";
      lk.textContent = `ΔE ${Number(r.de).toFixed(1)} · looks like ${r.look}`;
      li.appendChild(lk);
    }
    g.appendChild(li);
    return li;
  });
  // Deal the cards in from last place to first.
  // ...but the closest colour always lands last, for the gold frame
  const order = cards.map((c, i) => i).reverse();
  const ci = m.rows.findIndex((r) => r.id === m.closest);
  if (ci > 0) { order.splice(order.indexOf(ci), 1); order.push(ci); }
  order.forEach((i, k) => {
    st.revealTimers.push(setTimeout(() => {
      cards[i].classList.add("in");
      const r = m.rows[i];
      if (r.id === m.closest && n > 1 && !r.miss) {
        cards[i].classList.add("best");
        sfx.best();
      } else sfx.flip(k);
    }, 500 + k * 620));
  });
  const done = 500 + n * 620;
  renderBoard(m, false);
  st.revealTimers.push(setTimeout(() => {
    renderBoard(m, true);
    const top = m.rows[0];
    if (n > 1 && top && !top.miss) say(`Closest: ${player(top.id).name}, ${pct(top.match)} percent.`);
    else if (n === 1 && top && !top.miss) say(`${pct(top.match)} percent.`);
  }, done));
}

function renderBoard(m, after) {
  const rows = new Map(m.rows.map((r) => [r.id, r]));
  const list = after
    ? m.standings
    : m.standings
        .map((s) => ({ ...s, total: s.total - ((rows.get(s.id) || {}).pts || 0) }))
        .sort((a, b) => b.total - a.total || a.id - b.id);
  $("tv-board").innerHTML = list
    .filter((s) => !s.left)
    .map((s, i) => {
      const p = player(s.id);
      const gain = after && rows.get(s.id) ? rows.get(s.id).pts : 0;
      return `<li><span class="pos">${after ? s.rank : i + 1}</span>${avatar(p)}<span class="nm">${esc(p.name)}</span><span class="tot">${fmtPts(s.total)}${gain ? `<span class="gain">+${fmtPts(gain)}</span>` : ""}</span></li>`;
    })
    .join("");
}

function onThumb(m) {
  st.thumbs.set(`${m.r}:${m.id}`, m.src);
  if (st.reveal && st.reveal.r === m.r) {
    const li = $("tv-gallery").querySelector(`li[data-id="${Number(m.id)}"]`);
    if (li) setPhoto(li.querySelector(".ph"), m.src, 0.3);
  }
}

// ---------- game over ----------
function onOver(m) {
  st.over = m;
  st.ann = null;
  st.reveal = null;
  clearRevealTimers();
  showScreen(scr.over);
  document.body.classList.add("show-hub");
  const top = m.standings[0];
  if (m.solo) {
    $("tv-over-kicker").textContent = m.daily ? `Today's palette · ${m.date || ""}` : "Solo hunt";
    $("tv-winner").textContent = top ? `${fmtPts(top.total)} pts` : "Done";
    $("tv-winner-sub").textContent = top ? `${player(top.id).name} · ${pct(top.avg)}% average match` : "";
    say(top ? `${fmtPts(top.total)} points!` : "Done!");
  } else if (m.tie) {
    $("tv-over-kicker").textContent = "Game over";
    $("tv-winner").textContent = "It's a tie!";
    $("tv-winner-sub").textContent = `${fmtPts(top.total)} pts each at the top`;
    say("It's a tie!");
  } else {
    const w = player(m.winner);
    $("tv-over-kicker").textContent = "Winner";
    $("tv-winner").textContent = w.name;
    $("tv-winner-sub").textContent = `${fmtPts(top.total)} pts · ${pct(top.avg)}% average match`;
    say(`${w.name} wins!`);
  }
  restartAnim($("tv-winner"));
  $("tv-standings").innerHTML = m.standings
    .map((s, i) => {
      const p = player(s.id);
      return `<li class="${i === 0 ? "first" : ""}" style="animation-delay:${200 + i * 80}ms"><span class="pos">${s.rank}</span>${avatar(p)}<span class="pname">${esc(p.name)}<small>${s.left ? "left" : `${pct(s.avg)}% avg`}</small></span><span class="tot">${fmtPts(s.total)}</span></li>`;
    })
    .join("");
  const aw = $("tv-awards");
  aw.replaceChildren();
  const award = (k, a, line) => {
    if (!a) return;
    const d = document.createElement("div");
    d.className = "tv-award";
    d.appendChild(photoTile(st.thumbs.get(`${a.r}:${a.id}`), 0.3, "no photo"));
    d.insertAdjacentHTML("beforeend", `<div class="aw-t"><span class="k">${esc(k)}</span><b>${esc(player(a.id).name)}</b><span>${esc(line)}</span></div>`);
    aw.appendChild(d);
  };
  const nameOfRound = (r) => (m.history.find((h) => h.r === r) || {}).target || "";
  award("Sharpest eye", m.awards.eye, m.awards.eye ? `${pct(m.awards.eye.match)}% on ${nameOfRound(m.awards.eye.r)}` : "");
  if (!m.solo) award("Quickest draw", m.awards.quick, m.awards.quick ? `${fmtSecs(m.awards.quick.ms)} on ${nameOfRound(m.awards.quick.r)}` : "");
  sfx.fanfare();
  if (st.stopConfetti) st.stopConfetti();
  st.stopConfetti = confetti($("tv-confetti"));
}

// countdowns and the hunt clock, from the server's times
function loop() {
  const a = st.ann;
  if (a && !st.reveal && scr.stage.classList.contains("on")) {
    const now = performance.now();
    const start = net.toPerf(a.huntAt);
    if (now < start) {
      const s = (start - now) / 1000;
      const d = s <= 3 ? Math.ceil(s) : 0;
      if (d !== st.lastDigit) {
        st.lastDigit = d;
        const el = $("tv-countdown");
        el.textContent = d ? String(d) : "";
        if (d) { sfx.tick(); restartAnim(el, "tick"); }
      }
    } else {
      if (!st.open) openHunt(false);
      const left = Math.max(0, net.toPerf(a.endAt) - now);
      $("tv-clock").textContent = String(Math.ceil(left / 1000));
      $("tv-clock-fill").style.strokeDashoffset = String(276.5 * (1 - left / a.dur));
      $("tv-clock").parentElement.classList.toggle("low", left < 5500);
    }
  }
  if (st.reveal && scr.stage.classList.contains("on")) {
    const left = Math.ceil((net.toPerf(st.reveal.nextAt) - performance.now()) / 1000);
    $("tv-next").textContent = left > 0 ? (st.reveal.over ? `Final scores in ${left}` : `Next colour in ${left}`) : "";
  }
}
