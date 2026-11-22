// The phone: join a room, turn on the back camera, hunt each colour the server
// announces, snap once, then see everyone's snaps side by side.
//
// Game logic runs on fixed timers (setInterval); only CSS animates. Hidden tabs and
// phones in low-power mode throttle animation frames, and timers keep going.

import { Net } from "./net.js";
import { cam, geometry, photoGeometry, sampleAt, thumbAt, startCamera, stopCamera, flipCamera, setTorch, camAlive, camError, loadPhoto, srcSize } from "./camera.js";
import { distance, matchOf, scoreSnap, heat, pct, inkFor, labToHex } from "./color.js";
import { PALETTE, nameOf } from "./palette.js";
import { sfx, buzz, audioCtx, setMuted, isMuted } from "./audio.js";
import { $, esc, avatar, toast, showScreen, restartAnim, ordinal, fmtPts, fmtSecs, clock, joinUrl, qrSvg, photoTile, setPhoto, confetti } from "./ui.js";
import { createSim, createAutopilot } from "./sim.js";
import { makeCard, saveCard } from "./card.js";

const params = new URLSearchParams(location.search);
const DEV = params.has("dev");
const AUTO = DEV && params.has("auto");
// ?slot=N keeps same-origin iframes (the test harness) from sharing one session
const SESSION = "ch-session" + (params.get("slot") || "").replace(/W/g, "");
const NAME = "ch-name";
const SOUND = "ch-sound";
const BEST = "ch-best";
const HOLE = 44 / 240; // scope hole radius as a share of the scope's size (see the reticle's viewBox)
const TICKS = 36;
const HOT = 0.88;

const st = {
  code: null,
  pid: null,
  key: null,
  room: null,
  me: null,
  intro: null,
  ann: null,
  hunt: null,
  history: [],
  thumbs: new Map(),
  reveals: new Map(),
  over: null,
  wantSolo: false,
  wake: null,
  stopConfetti: null,
  timers: [],
  previewTimer: null,
  nextTimer: null,
  sim: null,
  auto: null,
  frozen: null,
  livePaused: false,
};

const scr = { home: $("scr-home"), lobby: $("scr-lobby"), game: $("scr-game"), over: $("scr-over") };
const net = new Net({ onMsg, onOpen });

// ---------- start ----------
export function startPhone() {
  document.body.classList.add("show-hub");
  setMuted(localStorage.getItem(SOUND) === "off");
  syncSound();
  buildTicks();
  startFan();
  if (DEV) {
    window.__ch = { st, net, cam, snap: () => snap(false), get sim() { return st.sim; }, photo: devPhoto };
  }
  const name = params.get("name") || localStorage.getItem(NAME) || "";
  $("in-name").value = name.slice(0, 14);
  const code = (params.get("room") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  if (code) {
    $("in-code").value = code;
    $("btn-join").classList.replace("ghost", "primary");
    $("btn-join").textContent = `Join ${code}`;
    $("btn-create").classList.replace("primary", "ghost");
    $("btn-create").classList.remove("big");
    $("f-home").classList.add("has-code");
  }
  showScreen(scr.home);
  wire();
  net.connect();
}

function wire() {
  $("f-home").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("f-home").classList.contains("has-code")) join();
    else create(false, false);
  });
  $("btn-join").addEventListener("click", join);
  $("in-code").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); join(); } });
  $("btn-solo").addEventListener("click", () => create(true, false));
  $("btn-daily").addEventListener("click", () => create(true, true));
  $("btn-cam").addEventListener("click", enableCamera);
  $("btn-photo").addEventListener("click", enablePhotoMode);
  $("btn-start").addEventListener("click", () => { audioCtx(); net.send({ t: "start" }); });
  $("btn-again").addEventListener("click", () => { audioCtx(); net.send({ t: "start" }); });
  $("btn-settings").addEventListener("click", () => net.send({ t: "toLobby" }));
  $("btn-leave").addEventListener("click", leave);
  $("btn-exit").addEventListener("click", leave);
  $("btn-share").addEventListener("click", share);
  $("btn-qr").addEventListener("click", () => {
    const box = $("qr-box");
    box.hidden = !box.hidden;
    $("btn-qr").setAttribute("aria-expanded", String(!box.hidden));
    if (!box.hidden) $("lob-qr").innerHTML = qrSvg(joinUrl(st.code));
  });
  for (const b of $("set-rounds").querySelectorAll("button")) b.addEventListener("click", () => net.send({ t: "settings", rounds: Number(b.dataset.v) }));
  for (const b of $("set-secs").querySelectorAll("button")) b.addEventListener("click", () => net.send({ t: "settings", secs: Number(b.dataset.v) }));
  $("set-daily").addEventListener("change", (e) => net.send({ t: "settings", daily: e.target.checked, date: localDate() }));
  $("btn-shutter").addEventListener("pointerdown", (e) => { e.preventDefault(); snap(false); });
  $("btn-shutter").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); snap(false); } });
  $("btn-flip").addEventListener("click", onFlip);
  $("btn-torch").addEventListener("click", onTorch);
  $("btn-sound").addEventListener("click", () => {
    audioCtx();
    setMuted(!isMuted());
    localStorage.setItem(SOUND, isMuted() ? "off" : "on");
    syncSound();
  });
  $("btn-pu-take").addEventListener("click", () => $("file-cap").click());
  $("btn-pu-retake").addEventListener("click", () => $("file-cap").click());
  $("btn-pu-use").addEventListener("click", () => usePhoto(false));
  $("file-cap").addEventListener("change", onPhotoPicked);
  const camBack = async () => {
    audioCtx();
    if (cam.mode === "photo") { $("ov-camoff").hidden = true; return; }
    try {
      if (DEV) useSim();
      else await startCamera($("cam"), cam.facing);
      $("ov-camoff").hidden = true;
      $("btn-watch-cam").hidden = true;
      net.send({ t: "ready", cam: "live" });
      syncCamTools();
      $("cam-card").classList.add("on");
      if (st.hunt && !st.hunt.done && !st.hunt.snapped) keepAwake();
    } catch (e) {
      toast(camError(e));
    }
  };
  $("btn-camback").addEventListener("click", camBack);
  $("btn-watch-cam").addEventListener("click", camBack);
  $("btn-card").addEventListener("click", onSaveCard);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (inMatch()) keepAwake();
    ensureCamera(false);
  });
  if (DEV) {
    window.addEventListener("keydown", (e) => {
      if (e.target && e.target.tagName === "INPUT") return;
      if (e.key === " " || e.key === "Enter") { if (st.hunt && st.hunt.open) { e.preventDefault(); snap(false); } }
    });
  }
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function myName() {
  const n = $("in-name").value.trim().slice(0, 14);
  if (n) localStorage.setItem(NAME, n);
  return n;
}

function create(solo, daily) {
  audioCtx();
  st.wantSolo = solo;
  net.send({ t: "create", name: myName(), daily: !!daily, date: localDate() });
}

function join() {
  audioCtx();
  const code = $("in-code").value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  if (code.length !== 4) {
    toast("Room codes are 4 letters.");
    $("in-code").focus();
    return;
  }
  st.wantSolo = false;
  net.send({ t: "join", code, name: myName() });
}

function leave() {
  net.send({ t: "leave" });
  sessionStorage.removeItem(SESSION);
  endRound();
  releaseWake();
  stopPreview();
  stopCamera();
  if (st.sim) cam.mode = "";
  $("cam-card").classList.remove("on");
  resetCamCard();
  st.code = st.pid = st.key = null;
  st.room = st.me = null;
  st.over = null;
  if (st.stopConfetti) { st.stopConfetti(); st.stopConfetti = null; }
  document.body.classList.add("show-hub");
  document.body.classList.remove("hunting");
  history.replaceState(null, "", location.pathname + (DEV ? "?dev" : ""));
  showScreen(scr.home);
}

async function share() {
  const url = joinUrl(st.code);
  const text = `Join my Chroma Hunt room: ${st.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Chroma Hunt", text, url }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied");
  } catch {
    toast(url, 5000);
  }
}

// ---------- home art: a fan of paint chips being sampled ----------
function startFan() {
  const chips = [...$("fan").querySelectorAll(".pchip")];
  const front = $("fan").querySelector(".pchip.front");
  const paint = () => {
    const picks = PALETTE.slice().sort(() => Math.random() - 0.5).slice(0, chips.length);
    chips.forEach((c, i) => {
      const p = picks[i];
      c.style.setProperty("--c", p.hex);
      c.querySelector(".nm").textContent = p.name;
      c.querySelector(".hx").textContent = p.hex;
    });
    const hex = front.style.getPropertyValue("--c");
    $("fan").style.setProperty("--fan-c", hex);
    const m = 0.82 + Math.random() * 0.17;
    $("fan-read").textContent = `${pct(m)}% · ${heat(m)}`;
  };
  paint();
  setInterval(() => { if (scr.home.classList.contains("on") && document.visibilityState === "visible") paint(); }, 3400);
}

// ---------- network ----------
function onOpen() {
  const saved = JSON.parse(sessionStorage.getItem(SESSION) || "null");
  if (st.pid && st.code) net.send({ t: "rejoin", code: st.code, pid: st.pid, key: st.key });
  else if (saved) net.send({ t: "rejoin", code: saved.code, pid: saved.pid, key: saved.key });
  else if (AUTO) autoStart();
}

function onMsg(m) {
  if (DEV) {
    st.log = st.log || [];
    st.log.push(`${m.t}${m.t === "room" ? ":" + m.phase + ":" + (st.me ? st.me.cam : "-") : ""}@${Date.now() % 100000}`);
    if (st.log.length > 200) st.log.shift();
  }
  switch (m.t) {
    case "joined": return onJoined(m);
    case "room": return onRoom(m);
    case "intro": return onIntro(m);
    case "announce": return onAnnounce(m);
    case "lives": return onLives(m);
    case "locked": return onLocked(m);
    case "scored": return onScored(m);
    case "reveal": return onReveal(m);
    case "thumb": return onThumb(m);
    case "over": return onOver(m);
    case "left": return;
    case "err":
      if (m.code === "norejoin") {
        sessionStorage.removeItem(SESSION);
        st.code = st.pid = st.key = null;
        if (!scr.home.classList.contains("on")) {
          toast("That game has ended.");
          leave();
        } else if (AUTO) autoStart();
        return;
      }
      toast(m.msg || "Something went wrong.");
  }
}

function onJoined(m) {
  st.code = m.code;
  st.pid = m.pid;
  st.key = m.key;
  sessionStorage.setItem(SESSION, JSON.stringify({ code: m.code, pid: m.pid, key: m.key }));
  history.replaceState(null, "", `${location.pathname}?room=${m.code}${DEV ? "&dev" : ""}${AUTO ? "&auto" : ""}`);
  $("lob-code").textContent = m.code;
  $("qr-box").hidden = true;
  $("btn-cam").textContent = st.wantSolo ? "Turn on camera & start" : "Turn on camera";
  if (!inMatch()) {
    showScreen(scr.lobby);
    document.body.classList.remove("show-hub");
    startPreview();
  }
  // Camera already on from an earlier room on this page? (After a reload it's off:
  // the server keeps us in the rounds and the game screen asks for one tap.)
  if (cam.mode) net.send({ t: "ready", cam: cam.mode === "photo" ? "photo" : "live" });
  if (AUTO && !cam.mode) setTimeout(enableCamera, 200);
}

function inMatch() {
  return scr.game.classList.contains("on");
}

function onRoom(m) {
  st.room = m;
  st.me = m.players.find((p) => p.id === st.pid) || null;
  if (!st.me) return;
  if (m.phase === "lobby" && !scr.lobby.classList.contains("on") && !scr.home.classList.contains("on")) {
    endRound();
    releaseWake();
    showScreen(scr.lobby);
    document.body.classList.remove("show-hub", "hunting");
    startPreview();
  }
  renderLobby();
  if (scr.over.classList.contains("on")) renderOverActions();
  if (st.hunt && !st.hunt.done) renderWho();
}

function renderLobby() {
  const m = st.room;
  if (!m) return;
  const amLeader = m.leader === st.pid;
  const ready = m.players.filter((p) => p.cam && p.connected && !p.left).length;
  $("lob-count").textContent = `${m.players.length}`;
  $("lob-players").innerHTML = m.players
    .filter((p) => !p.left)
    .map((p) => {
      const lead = p.id === m.leader ? '<span class="crown" title="Host">♛</span>' : "";
      const live = m.phase !== "lobby" && m.phase !== "over";
      const sub = !p.connected ? "reconnecting…" : live && p.inMatch ? "hunting" : p.id === st.pid ? "you" : "";
      const tag = p.cam === "photo" ? "camera app" : p.cam ? "camera on" : "no camera yet";
      return `<li class="${p.id === st.pid ? "me" : ""} ${p.connected ? "" : "off"}">${avatar(p)}<span class="pname"><span>${esc(p.name)}${lead}</span>${sub ? `<small>${sub}</small>` : ""}</span><span class="ptag ${p.cam ? "ok" : ""}">${tag}</span></li>`;
    })
    .join("");
  // settings
  const s = m.settings;
  $("set-card").classList.toggle("ro", !amLeader);
  for (const b of $("set-rounds").querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.v) === s.rounds);
  for (const b of $("set-secs").querySelectorAll("button")) b.classList.toggle("on", Number(b.dataset.v) === s.secs);
  $("set-rounds").classList.toggle("locked", s.daily);
  $("set-secs").classList.toggle("locked", s.daily);
  $("set-daily").checked = s.daily;
  $("set-ro").textContent = s.daily ? "Today's palette: the same 5 colours for everyone today, 45 s each." : `${s.rounds} colours, ${s.secs} seconds each.`;
  // start
  const btn = $("btn-start");
  const live = m.phase === "intro" || m.phase === "round" || m.phase === "reveal";
  btn.hidden = !amLeader || live;
  btn.disabled = ready === 0;
  btn.textContent = ready <= 1 && m.players.filter((p) => !p.left).length <= 1 ? "Start solo hunt" : `Start · ${ready} ready`;
  const wait = $("lob-wait");
  const leader = m.players.find((p) => p.id === m.leader);
  if (live) wait.textContent = st.me.cam ? "A game is on. You're in from the next colour." : "A game is on. Turn your camera on to join from the next colour.";
  else if (!st.me.cam) wait.textContent = "Turn your camera on to play.";
  else if (amLeader) wait.textContent = m.displays ? "Big screen connected. Start when everyone's ready." : ready < m.players.filter((p) => !p.left).length ? "Waiting for everyone's camera…" : "Everyone's ready.";
  else wait.textContent = `Waiting for ${leader ? leader.name : "the host"} to start…`;
}

// ---------- camera setup ----------
function resetCamCard() {
  $("cc-title").textContent = "Turn on your camera";
  $("cc-sub").textContent = "Use the back camera. It reads colours right here on your phone.";
  $("btn-cam").textContent = "Turn on camera";
}

async function enableCamera() {
  audioCtx();
  const btn = $("btn-cam");
  btn.disabled = true;
  btn.textContent = "Opening camera…";
  try {
    if (DEV) useSim();
    else await startCamera($("cam"));
    camReady("live");
  } catch (e) {
    $("cc-title").textContent = "Camera didn't start";
    $("cc-sub").textContent = camError(e);
    btn.textContent = "Try again";
  } finally {
    btn.disabled = false;
  }
}

function enablePhotoMode() {
  audioCtx();
  stopCamera();
  cam.mode = "photo";
  cam.source = null;
  camReady("photo");
}

function camReady(mode) {
  net.send({ t: "ready", cam: mode });
  $("ov-camoff").hidden = true;
  $("btn-watch-cam").hidden = true;
  $("cam-card").classList.toggle("on", true);
  $("cc-title").textContent = mode === "photo" ? "Camera app mode" : "Camera on";
  $("cc-sub").textContent = mode === "photo"
    ? "Each round you'll take a photo with your camera app. Fill the frame with your colour."
    : "Point it around: the dot shows the colour it reads.";
  syncCamTools();
  startPreview();
  sfx.lock();
  buzz(20);
  if (st.wantSolo) {
    st.wantSolo = false;
    setTimeout(() => net.send({ t: "start" }), 350);
  }
}

function useSim() {
  if (!st.sim) {
    const seed = (params.get("seed") | 0) || Math.floor(Math.random() * 1e9);
    st.sim = createSim(seed);
    $("view").appendChild(st.sim.canvas);
    $("cam").hidden = true;
    const skill = Math.min(1, Math.max(0, Number(params.get("skill") || 0.75)));
    st.auto = createAutopilot(st.sim, {
      skill,
      snap: () => $("btn-shutter").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
      match: () => (st.hunt ? st.hunt.match : 0),
    });
  }
  cam.source = st.sim.canvas;
  // ?dev&stream: pipe the painted room through a real MediaStream into the <video>,
  // so sampling runs on the same element (and readiness checks) as a phone camera.
  if (params.has("stream") && st.sim.canvas.captureStream) {
    const v = $("cam");
    if (!v.srcObject) {
      v.srcObject = st.sim.canvas.captureStream(30);
      v.muted = true;
      v.play().catch(() => {});
    }
    v.hidden = false;
    v.style.cssText = "z-index:1;pointer-events:none";
    cam.video = v;
    cam.source = v;
  }
  cam.mode = "live";
  cam.mirrored = false;
  cam.multi = false;
  cam.hasTorch = false;
}

function syncCamTools() {
  scr.game.classList.toggle("photo-mode", cam.mode === "photo");
  $("btn-flip").hidden = !(cam.mode === "live" && cam.multi && !st.sim);
  $("btn-torch").hidden = !(cam.mode === "live" && cam.hasTorch);
  $("btn-torch").classList.toggle("on", cam.torch);
  $("view").classList.toggle("mirror", !!cam.mirrored);
}

async function onFlip() {
  try {
    await flipCamera();
  } catch (e) {
    toast(camError(e));
  }
  syncCamTools();
}

async function onTorch() {
  const ok = await setTorch(!cam.torch);
  if (!ok) toast("The torch isn't available.");
  syncCamTools();
}

// Bring the camera back after the phone paused it (iOS does when the page hides).
async function ensureCamera(fromTap) {
  if (cam.mode !== "live" || st.sim) return;
  if (camAlive()) {
    if (cam.video && cam.video.paused && !st.livePaused) cam.video.play().catch(() => {});
    return;
  }
  try {
    await startCamera($("cam"), cam.facing);
    syncCamTools();
  } catch (e) {
    if (inMatch()) $("ov-camoff").hidden = false;
    if (fromTap) toast(camError(e));
  }
}
cam.onEnded = () => { if (document.visibilityState === "visible") ensureCamera(false); };

// The lobby's little round preview, and the colour the scope would read.
function startPreview() {
  stopPreview();
  const c = $("lob-preview");
  const x = c.getContext("2d");
  st.previewTimer = setInterval(() => {
    if (!scr.lobby.classList.contains("on") || cam.mode !== "live") return;
    const src = cam.source;
    const s0 = srcSize(src);
    if (!s0) return;
    const side = Math.min(s0.w, s0.h) * 0.6;
    try {
      x.save();
      if (cam.mirrored) { x.translate(c.width, 0); x.scale(-1, 1); }
      x.drawImage(src, (s0.w - side) / 2, (s0.h - side) / 2, side, side, 0, 0, c.width, c.height);
      x.restore();
    } catch {}
    const g = { cx: s0.w / 2, cy: s0.h / 2, r: side * (14 / 100), visW: s0.w, visH: s0.h, w: s0.w, h: s0.h };
    const s = sampleAt(g, src);
    if (s) $("lob-swatch").style.background = s.hex;
  }, 140);
}
function stopPreview() {
  clearInterval(st.previewTimer);
  st.previewTimer = null;
}

// ---------- the match ----------
function keepAwake() {
  if (!("wakeLock" in navigator) || st.wake) return;
  navigator.wakeLock.request("screen").then((l) => {
    st.wake = l;
    l.addEventListener("release", () => { st.wake = null; });
  }).catch(() => {});
}
function releaseWake() {
  if (st.wake) { st.wake.release().catch(() => {}); st.wake = null; }
}

function enterGame() {
  if (!scr.game.classList.contains("on")) {
    showScreen(scr.game);
    stopPreview();
  }
  document.body.classList.remove("show-hub");
  document.body.classList.add("hunting");
  syncCamTools();
}

function hideOverlays() {
  for (const id of ["ov-intro", "ov-ann", "ov-locked", "ov-watch", "ov-reveal"]) $(id).hidden = true;
}

function setTarget(hex) {
  scr.game.style.setProperty("--target", hex);
  scr.game.style.setProperty("--ann-ink", inkFor(hex));
}

function onIntro(m) {
  st.intro = m;
  st.history = [];
  st.thumbs.clear();
  st.reveals.clear();
  st.over = null;
  if (st.stopConfetti) { st.stopConfetti(); st.stopConfetti = null; }
  if (!(st.me && st.me.cam && st.me.connected)) {
    if (!scr.lobby.classList.contains("on")) showScreen(scr.lobby);
    document.body.classList.remove("show-hub");
    $("lob-wait").textContent = "A game just started. Turn your camera on to join from the next colour.";
    return;
  }
  endRound();
  enterGame();
  hideOverlays();
  unfreeze();
  $("scope").classList.add("idle");
  $("ov-intro").hidden = false;
  $("intro-kicker").textContent = m.daily ? `Today's palette · ${m.date || ""}` : m.solo ? "Solo hunt" : `${m.players} hunters`;
  $("intro-title").textContent = `${m.n} colours`;
  $("intro-sub").textContent = `${m.secs} seconds to find each one. Closer colour and a quicker snap score more. The last colour counts double.`;
  restartAnim($("intro-title"));
  keepAwake();
  ensureCamera(false);
}

function clearTimers() {
  for (const t of st.timers) { clearInterval(t); clearTimeout(t); }
  st.timers = [];
  clearInterval(st.nextTimer);
  if (st.auto) st.auto.stop();
}

function endRound() {
  clearTimers();
  if (st.hunt) st.hunt.done = true;
}

function onAnnounce(m) {
  st.ann = m;
  endRound();
  const playing = m.ids.includes(st.pid);
  if (!playing) {
    if (inMatch() || (st.me && st.me.inMatch && st.me.cam)) {
      enterGame();
      hideOverlays();
      showWatch(m);
    } else if (scr.lobby.classList.contains("on")) {
      $("lob-wait").textContent = st.me && st.me.cam ? "A game is on. You're in from the next colour." : "A game is on. Turn your camera on to join from the next colour.";
    }
    return;
  }
  enterGame();
  hideOverlays();
  unfreeze();
  $("ov-camoff").hidden = !!cam.mode;
  const memory = m.kind === "memory";
  setTarget(m.target.hex);
  const h = {
    r: m.r,
    of: m.of,
    target: m.target,
    kind: m.kind,
    mult: m.mult,
    dur: m.dur,
    startPerf: net.toPerf(m.huntAt),
    endPerf: net.toPerf(m.endAt),
    open: false,
    snapped: false,
    done: false,
    ema: null,
    match: 0,
    hot: false,
    geiger: 0,
    lastDigit: -1,
    lastLive: 0,
    locked: new Set(m.locked.map((l) => l[0])),
    lives: new Map(),
    photo: null,
    photoSrc: null,
    local: null,
    scored: null,
  };
  st.hunt = h;
  // HUD
  $("hud-round").textContent = `${m.r}/${m.of}`;
  $("hud-name").textContent = m.target.name;
  $("hud-clock").textContent = clock(m.dur);
  $("hud-clock").classList.remove("low");
  $("hud-time").style.transform = "scaleX(1)";
  $("hud-time").parentElement.classList.remove("low");
  $("hud-note").hidden = true;
  scr.game.classList.remove("scope-memory", "scope-hot");
  const sc = $("scope");
  sc.classList.remove("hot", "memory", "busy");
  sc.classList.add("idle");
  $("m-pct").textContent = "--";
  $("m-heat").textContent = "Aim at something";
  setLit(0);
  $("btn-shutter").disabled = true;
  renderWho();

  // Back after a reconnect, already snapped this round: just wait for the reveal.
  if (h.locked.has(st.pid)) {
    h.snapped = true;
    h.open = true;
    $("ov-watch").hidden = false;
    $("w-tag").textContent = `Colour ${m.r} of ${m.of}: ${m.target.name}`;
    $("w-title").textContent = "You're locked in";
    $("w-sub").textContent = "Waiting for the others…";
    $("btn-watch-cam").hidden = true;
    $("w-list").innerHTML = m.ids.filter((id) => id !== st.pid).map((id) => miniRow(id, null)).join("");
    $("ov-camoff").hidden = true;
    return;
  }

  const already = performance.now() >= h.startPerf;
  if (!already) {
    // the colour floods the screen, then drains into the scope
    $("ann-round").textContent = `Colour ${m.r} of ${m.of}`;
    const kind = $("ann-kind");
    kind.hidden = m.kind === "normal";
    kind.textContent = memory ? "Memory round" : m.kind === "final" ? "Final · double points" : "";
    $("ann-name").textContent = m.target.name;
    $("ann-hex").textContent = m.target.hex.toUpperCase();
    $("ann-hint").textContent = memory ? "Memorise it. It hides when the hunt starts." : "Find something this colour";
    $("ann-count").textContent = "";
    const ov = $("ov-ann");
    ov.classList.remove("go");
    restartAnim($("ann-flood"));
    restartAnim($("ann-name"));
    ov.hidden = false;
    scr.game.style.setProperty("--hole", `${Math.round($("scope").offsetWidth * HOLE)}px`);
    sfx.whoosh();
  }
  if (cam.mode === "photo") preparePhotoRound();
  st.timers.push(setInterval(roundTick, 1000 / 30));
  st.timers.push(setInterval(sampleTick, 80));
  roundTick();
}

function buildTicks() {
  const g = $("ticks");
  let s = "";
  for (let i = 0; i < TICKS; i++) {
    const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
    const c = Math.cos(a), sn = Math.sin(a);
    s += `<line x1="${(c * 74).toFixed(1)}" y1="${(sn * 74).toFixed(1)}" x2="${(c * 86).toFixed(1)}" y2="${(sn * 86).toFixed(1)}"/>`;
  }
  g.innerHTML = s;
}

let litNow = -1;
function setLit(n) {
  if (n === litNow) return;
  litNow = n;
  const ls = $("ticks").children;
  for (let i = 0; i < ls.length; i++) ls[i].classList.toggle("lit", i < n);
}

function roundTick() {
  const h = st.hunt;
  if (!h || h.done) return;
  const now = performance.now();
  if (now < h.startPerf) {
    const s = (h.startPerf - now) / 1000;
    const d = s <= 3 ? Math.ceil(s) : 0;
    if (d !== h.lastDigit) {
      h.lastDigit = d;
      const el = $("ann-count");
      el.textContent = d ? String(d) : "";
      if (d) {
        sfx.tick();
        buzz(8);
        restartAnim(el, "tick");
      }
    }
    return;
  }
  if (!h.open) openHunt(h);
  const left = h.endPerf - now;
  $("hud-clock").textContent = clock(left);
  const low = left < 5500;
  $("hud-clock").classList.toggle("low", low && !h.snapped);
  $("hud-time").style.transform = `scaleX(${Math.max(0, Math.min(1, left / h.dur))})`;
  $("hud-time").parentElement.classList.toggle("low", low);
  // Geiger clicks: faster the closer you are
  if (!h.snapped && h.kind !== "memory" && h.ema) {
    h.geiger += (0.7 + 13 * Math.pow(h.match, 3)) / 30;
    if (h.geiger >= 1) {
      h.geiger -= 1 + (Math.random() - 0.5) * 0.4;
      sfx.click(h.match);
    }
  }
  if (!h.snapped && left <= 150) autoSnap(h);
}

function openHunt(h) {
  h.open = true;
  const ov = $("ov-ann");
  if (!ov.hidden) {
    ov.classList.add("go");
    st.timers.push(setTimeout(() => { ov.hidden = true; ov.classList.remove("go"); }, 620));
  }
  const memory = h.kind === "memory";
  const sc = $("scope");
  sc.classList.remove("idle");
  sc.classList.toggle("memory", memory);
  scr.game.classList.toggle("scope-memory", memory);
  if (memory) {
    $("hud-name").textContent = "Memory round";
    $("m-pct").textContent = "?";
    $("m-heat").textContent = "Trust your eyes";
    $("hud-note").hidden = false;
    $("hud-note").textContent = "No meter this time. Snap what you remember.";
  }
  if (cam.mode === "photo") {
    sc.classList.add("idle");
    $("photo-ui").hidden = false;
  } else {
    $("btn-shutter").disabled = false;
  }
  sfx.go();
  buzz(30);
  if (AUTO && st.auto && cam.mode === "live") st.auto.hunt(h.target.lab, h.endPerf - performance.now());
}

function scopeGeometry() {
  const v = $("view");
  const size = $("scope").offsetWidth;
  return geometry(v.clientWidth, v.clientHeight, size * HOLE);
}

function sampleTick() {
  const h = st.hunt;
  if (!h || h.done || h.snapped || cam.mode !== "live") return;
  const s = sampleAt(scopeGeometry());
  if (!s) {
    $("m-heat").textContent = "Waiting for the camera…";
    return;
  }
  h.ema = h.ema ? h.ema.map((v, i) => v + (s.lab[i] - v) * 0.5) : s.lab.slice();
  const de = distance(h.target.lab, h.ema);
  const m = matchOf(de);
  h.match = m;
  h.liveHex = labToHex(h.ema);
  const memory = h.kind === "memory";
  $("m-live").style.background = h.liveHex;
  $("shutter-fill").style.background = h.liveHex;
  const sc = $("scope");
  const busy = s.mixed > 0.42;
  sc.classList.toggle("busy", busy && !memory);
  if (!memory) {
    $("m-pct").textContent = `${pct(m)}%`;
    $("m-heat").textContent = busy ? "Mixed colours · get closer" : heat(m);
    setLit(Math.round(m * TICKS));
    const hot = m >= HOT;
    sc.classList.toggle("hot", hot);
    scr.game.classList.toggle("scope-hot", hot);
    if (hot && !h.hot && h.open) { sfx.hot(); buzz(15); }
    h.hot = hot;
  }
  const now = performance.now();
  if (h.open && now - h.lastLive > 240) {
    h.lastLive = now;
    net.send({ t: "live", r: h.r, m: Math.round(m * 1000) / 1000, c: h.liveHex }, { queue: false });
  }
}

function wantThumbs() {
  const m = st.room;
  if (!m) return false;
  return m.displays > 0 || m.players.filter((p) => !p.left).length > 1;
}

function snap(auto) {
  const h = st.hunt;
  if (!h || h.done || h.snapped || !h.open || cam.mode !== "live") return;
  const g = scopeGeometry();
  const s = sampleAt(g);
  if (!s) {
    if (!auto) toast("The camera isn't ready yet.");
    return;
  }
  const ms = Math.max(0, Math.round(performance.now() - h.startPerf));
  const lab = s.lab.map((v) => +v.toFixed(2));
  const th = thumbAt(g, cam.source, { mirror: cam.mirrored });
  freezeFrame();
  lockIn(h, { lab, hex: s.hex, ms, auto, thumb: th });
}

function autoSnap(h) {
  if (cam.mode === "photo") {
    if (h.photoSrc) usePhoto(true);
    return;
  }
  snap(true);
}

function lockIn(h, { lab, hex, ms, auto, thumb }) {
  h.snapped = true;
  h.photo = thumb;
  net.send({ t: "snap", r: h.r, ms, lab, hex, auto, thumb: wantThumbs() && thumb ? thumb.src : null });
  const de = distance(h.target.lab, lab);
  const sc = scoreSnap({ de, t: auto ? h.dur : Math.min(ms, h.dur), dur: h.dur, auto, mult: h.mult });
  h.local = { lab, hex, ms: auto ? h.dur : ms, auto, de, look: nameOf(lab), ...sc };
  if (st.auto) st.auto.stop();
  $("btn-shutter").disabled = true;
  $("photo-ui").hidden = true;
  const f = $("flash");
  restartAnim(f, "go");
  sfx.shutter();
  buzz(35);
  setTimeout(() => sfx.lock(), 260);
  showLocked(h);
}

function showLocked(h) {
  const r = h.scored || h.local;
  const memory = h.kind === "memory";
  $("ov-watch").hidden = true;
  $("ov-locked").hidden = false;
  $("lk-tag").textContent = r.auto ? "Time's up: auto snap" : `Locked in at ${fmtSecs(r.ms)}`;
  $("lk-target").style.background = h.target.hex;
  $("lk-found").style.background = r.hex;
  $("lk-pct").textContent = `${pct(r.match)}%`;
  $("lk-heat").textContent = heat(r.match);
  const mult = h.mult > 1 ? " ×2" : "";
  $("lk-pts").innerHTML = `+${fmtPts(r.pts)} <em>(${fmtPts(r.matchPts)} colour${r.auto ? ", halved" : ` + ${fmtPts(r.speedPts)} speed`}${mult})</em>`;
  $("lk-meta").textContent = `Looks like ${r.look} · ΔE ${r.de.toFixed(1)}${memory ? " · from memory" : ""}`;
  restartAnim($("lk-card"));
  renderWaiting();
}

function renderWaiting() {
  const h = st.hunt;
  if (!h || $("ov-locked").hidden) return;
  const players = st.room ? st.room.players : [];
  const left = st.ann.ids.filter((id) => id !== st.pid && !h.locked.has(id) && !(players.find((p) => p.id === id) || {}).left);
  const box = $("lk-wait");
  if (!left.length) {
    box.innerHTML = st.ann.ids.length > 1 ? "<p>Everyone's in. Here comes the reveal…</p>" : "<p>Here comes the reveal…</p>";
    return;
  }
  box.innerHTML = `<p>Still hunting: ${left.length}</p><ul class="mini">${left.map((id) => miniRow(id, h.lives.get(id))).join("")}</ul>`;
}

function miniRow(id, live) {
  const p = (st.room && st.room.players.find((x) => x.id === id)) || { name: "Hunter", color: "#9a968f" };
  const m = live && live.m != null ? live.m : 0;
  const lc = live && live.c ? live.c : "transparent";
  const txt = live && live.m != null ? `${pct(live.m)}%` : "";
  return `<li style="--p:${m};--lc:${lc}"><span class="bar"></span>${avatar(p)}<span class="pname">${esc(p.name)}</span><span class="dot"></span><span class="st">${txt}</span></li>`;
}

function renderWho() {
  const h = st.hunt;
  if (!h || !st.ann) return;
  const players = st.room ? st.room.players : [];
  $("hunt-who").innerHTML = st.ann.ids
    .filter((id) => id !== st.pid)
    .slice(0, 9)
    .map((id) => {
      const p = players.find((x) => x.id === id) || { name: "?", color: "#9a968f" };
      return avatar(p, h.locked.has(id) ? "lk" : "");
    })
    .join("");
}

function onLives(m) {
  const h = st.hunt;
  if (h && !h.done && m.r === h.r) {
    for (const [id, mm, c, lk] of m.p) {
      h.lives.set(id, { m: mm, c });
      if (lk) h.locked.add(id);
    }
    if (!$("ov-locked").hidden) renderWaiting();
  }
  if (!$("ov-watch").hidden && st.ann && m.r === st.ann.r) {
    $("w-list").innerHTML = m.p.map(([id, mm, c, lk]) => miniRow(id, { m: lk && mm != null ? mm : mm, c })).join("");
  }
}

function onLocked(m) {
  const h = st.hunt;
  if (!h || m.r !== h.r) return;
  if (!h.locked.has(m.id) && m.id !== st.pid) sfx.click(0.2);
  h.locked.add(m.id);
  renderWho();
  renderWaiting();
}

function onScored(m) {
  const h = st.hunt;
  if (!h || m.r !== h.r) return;
  h.scored = m;
  if (!$("ov-locked").hidden) showLocked(h);
}

function showWatch(m) {
  $("ov-watch").hidden = false;
  const late = !(st.me && st.me.inMatch);
  $("w-tag").textContent = `Colour ${m.r} of ${m.of}: ${m.target.name}`;
  const camOn = !!cam.mode;
  $("w-title").textContent = camOn ? "You're in from the next colour" : "Turn your camera on to play";
  $("w-sub").textContent = late ? "Watch the others hunt for now." : "";
  $("btn-watch-cam").hidden = camOn;
  $("w-list").innerHTML = m.ids.map((id) => miniRow(id, null)).join("");
  setTarget(m.target.hex);
}

// ---------- the camera-app fallback ----------
function preparePhotoRound() {
  $("pu-img").removeAttribute("src");
  $("pu-read").textContent = st.hunt.kind === "memory"
    ? "Memory round: snap what you remember with your camera app."
    : "Fill the frame with your colour, then snap it with your camera app.";
  $("btn-pu-take").hidden = false;
  $("btn-pu-use").hidden = true;
  $("btn-pu-retake").hidden = true;
  $("photo-ui").hidden = true;
}

async function onPhotoPicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  const h = st.hunt;
  if (!file || !h || h.done || h.snapped) return;
  try {
    const c = await loadPhoto(file);
    showPhoto(c);
  } catch {
    toast("That photo couldn't be read. Try again.");
  }
}

function showPhoto(c) {
  const h = st.hunt;
  const g = photoGeometry(c);
  const s = sampleAt(g, c);
  if (!s) return toast("That photo couldn't be read. Try again.");
  h.photoSrc = { canvas: c, g, s };
  $("pu-img").src = c.toDataURL("image/jpeg", 0.8);
  const m = matchOf(distance(h.target.lab, s.lab));
  $("pu-read").innerHTML = h.kind === "memory" ? `<b>Got it</b>Use it, or retake.` : `<b>${pct(m)}% · ${esc(heat(m))}</b>Use it, or retake for a closer colour.`;
  $("btn-pu-take").hidden = true;
  $("btn-pu-use").hidden = false;
  $("btn-pu-retake").hidden = false;
}

function usePhoto(auto) {
  const h = st.hunt;
  if (!h || h.done || h.snapped || !h.photoSrc) return;
  const { canvas, g, s } = h.photoSrc;
  const ms = Math.max(0, Math.round(performance.now() - h.startPerf));
  const th = thumbAt(g, canvas);
  lockIn(h, { lab: s.lab.map((v) => +v.toFixed(2)), hex: s.hex, ms, auto, thumb: th });
}

// ?dev: pretend the camera app returned a photo of this colour
function devPhoto(hex = "#e8662a") {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 480;
  const x = c.getContext("2d");
  x.fillStyle = "#555";
  x.fillRect(0, 0, 640, 480);
  x.fillStyle = hex;
  x.beginPath();
  x.ellipse(320, 240, 220, 190, 0, 0, Math.PI * 2);
  x.fill();
  showPhoto(c);
}

// ---------- the frozen frame after a snap ----------
function freezeFrame() {
  const v = $("view");
  const src = cam.source;
  const s0 = srcSize(src);
  if (!s0) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement("canvas");
  c.className = "frozen";
  c.width = Math.round(v.clientWidth * dpr);
  c.height = Math.round(v.clientHeight * dpr);
  const x = c.getContext("2d");
  const k = Math.max(c.width / s0.w, c.height / s0.h);
  const w = s0.w * k, hh = s0.h * k;
  if (cam.mirrored) { x.translate(c.width, 0); x.scale(-1, 1); }
  try { x.drawImage(src, (c.width - w) / 2, (c.height - hh) / 2, w, hh); } catch { return; }
  unfreeze();
  c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:1";
  v.appendChild(c);
  st.frozen = c;
  if (cam.video && cam.mode === "live" && !st.sim) { cam.video.pause(); st.livePaused = true; }
}
function unfreeze() {
  if (st.frozen) { st.frozen.remove(); st.frozen = null; }
  if (st.livePaused && cam.video) { cam.video.play().catch(() => {}); st.livePaused = false; }
}

// ---------- reveal ----------
function onReveal(m) {
  st.reveals.set(m.r, m);
  const h = st.hunt && st.hunt.r === m.r ? st.hunt : null;
  endRound();
  const mine = m.rows.find((r) => r.id === st.pid);
  if (mine) {
    st.history = st.history.filter((x) => x.r !== m.r);
    st.history.push({ r: m.r, target: m.target, kind: m.kind, mult: m.mult, row: mine, photo: h && h.photo ? h.photo : null });
  }
  if (!inMatch()) {
    if (!(st.me && st.me.inMatch)) return;
    enterGame();
  }
  const wasLocked = !$("ov-locked").hidden;
  const show = () => {
    hideOverlays();
    renderReveal(m);
    $("ov-reveal").hidden = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((net.toPerf(m.nextAt) - performance.now()) / 1000));
      $("rv-next").textContent = left > 0 ? (m.over ? `Final scores in ${left}` : `Next colour in ${left}`) : "";
    };
    tick();
    clearInterval(st.nextTimer);
    st.nextTimer = setInterval(tick, 250);
    if (mine && !mine.miss && m.closest === st.pid && m.rows.length > 1) { sfx.best(); buzz([30, 40, 30]); }
    else if (mine && mine.miss) sfx.miss();
  };
  if (wasLocked) setTimeout(show, 700);
  else show();
}

function photoFor(r, id) {
  if (id === st.pid) {
    const mine = st.history.find((x) => x.r === r);
    if (mine && mine.photo) return mine.photo;
  }
  return st.thumbs.get(`${r}:${id}`) || null;
}

function renderReveal(m) {
  setTarget(m.target.hex);
  $("rv-sw").style.background = m.target.hex;
  $("rv-round").textContent = `Colour ${m.r} of ${m.of}${m.kind === "final" ? " · double points" : m.kind === "memory" ? " · memory round" : ""}`;
  $("rv-name").textContent = m.target.name;
  const players = st.room ? st.room.players : [];
  const pl = (id) => players.find((p) => p.id === id) || { id, name: "Hunter", color: "#9a968f" };
  const n = m.rows.length;
  // my result
  const mine = m.rows.find((r) => r.id === st.pid);
  const me = $("rv-me");
  me.replaceChildren();
  if (mine) {
    const card = document.createElement("div");
    if (mine.miss) {
      card.className = "rv-mine miss";
      card.innerHTML = `<div><p class="big-pct">No snap</p><p class="sub">Nothing reached the server this round.</p></div>`;
    } else {
      card.className = "rv-mine";
      const ph = photoFor(m.r, st.pid);
      card.appendChild(photoTile(ph && ph.src, ph && ph.ring));
      const info = document.createElement("div");
      const place = n > 1 ? `${ordinal(mine.rank)} of ${n}` : heat(mine.match);
      info.innerHTML = `<p class="big-pct">${pct(mine.match)}%</p><p class="sub">ΔE ${Number(mine.de).toFixed(1)} · ${esc(mine.look || "")}</p><p class="pl">+${fmtPts(mine.pts)} · ${esc(place)}</p>`;
      card.appendChild(info);
    }
    me.appendChild(card);
  }
  // everyone's snaps (solo: your own card above says it all)
  const grid = $("rv-grid");
  grid.replaceChildren();
  grid.hidden = n < 2 && !!mine;
  if (!grid.hidden) m.rows.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = `rv-card${r.id === st.pid ? " me" : ""}${r.id === m.closest && n > 1 ? " best" : ""}`;
    li.dataset.id = r.id;
    li.style.animationDelay = `${120 + i * 90}ms`;
    const ph = r.miss ? null : photoFor(m.r, r.id);
    li.appendChild(photoTile(ph && (ph.src || ph), ph && ph.ring, r.miss ? (r.left ? "left" : "no snap") : r.thumb ? "loading" : "no photo"));
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = r.miss
      ? `<span class="pct">—</span><span class="rk">${ordinal(r.rank)}</span>`
      : `<span class="split"><i style="background:${m.target.hex}"></i><i style="background:${r.hex}"></i></span><span class="pct">${pct(r.match)}%</span><span class="rk">${ordinal(r.rank)}</span>`;
    li.appendChild(row);
    const nm = document.createElement("p");
    nm.className = "nm";
    nm.textContent = pl(r.id).name;
    li.appendChild(nm);
    const pts = document.createElement("p");
    pts.className = "pts";
    pts.textContent = r.miss ? "0 pts" : `+${fmtPts(r.pts)}${r.auto ? " · auto" : ` · ${fmtSecs(r.ms)}`}`;
    li.appendChild(pts);
    grid.appendChild(li);
  });
  // running totals
  const moves = new Map(m.rows.map((r) => [r.id, r.prevPos && r.pos ? r.prevPos - r.pos : 0]));
  const myTotal = (m.standings.find((s) => s.id === st.pid) || {}).total || 0;
  $("rv-table").innerHTML = n < 2 && m.standings.length < 2
    ? `<li class="me solo"><span class="nm">Total after ${m.r} of ${m.of}</span><span class="tot">${fmtPts(myTotal)}</span></li>`
    : n > 1 || m.standings.length > 1
    ? m.standings
        .filter((s) => !s.left)
        .map((s) => {
          const mv = moves.get(s.id) || 0;
          const mvs = mv > 0 ? `<span class="mv up">▲${mv}</span>` : mv < 0 ? `<span class="mv down">▼${-mv}</span>` : `<span class="mv"></span>`;
          return `<li class="${s.id === st.pid ? "me" : ""}"><span class="pos">${s.rank}</span>${avatar(pl(s.id))}<span class="nm">${esc(pl(s.id).name)}</span><span class="tot">${fmtPts(s.total)}</span>${mvs}</li>`;
        })
        .join("")
    : "";
}

function onThumb(m) {
  st.thumbs.set(`${m.r}:${m.id}`, { src: m.src, ring: ringFor(m.r, m.id) });
  if (!$("ov-reveal").hidden && st.reveals.get(m.r) && $("rv-name").textContent === st.reveals.get(m.r).target.name) {
    const li = $("rv-grid").querySelector(`li[data-id="${Number(m.id)}"]`);
    if (li && m.id !== st.pid) setPhoto(li.querySelector(".ph"), m.src, ringFor(m.r, m.id));
  }
}

// Thumbnails from other phones: their scope covered about the same share of the frame as ours.
function ringFor() {
  const mine = st.history.length && st.history[st.history.length - 1].photo;
  return mine ? mine.ring : 0.3;
}

// ---------- game over ----------
function onOver(m) {
  st.over = m;
  endRound();
  if (!m.standings.some((s) => s.id === st.pid)) {
    if (!inMatch()) { renderLobby(); return; }
  }
  releaseWake();
  hideOverlays();
  unfreeze();
  showScreen(scr.over);
  document.body.classList.add("show-hub");
  document.body.classList.remove("hunting");
  const players = st.room ? st.room.players : [];
  const pl = (id) => players.find((p) => p.id === id) || { id, name: "Hunter", color: "#9a968f" };
  const meIdx = m.standings.findIndex((s) => s.id === st.pid);
  const mine = meIdx >= 0 ? m.standings[meIdx] : null;
  let kicker = "Game over", title = "", sub = "";
  let party = false;
  let best = null;
  if (m.solo) {
    kicker = m.daily ? `Today's palette · ${m.date || ""}` : "Solo hunt";
    title = mine ? `${fmtPts(mine.total)} pts` : "Done";
    const key = m.daily ? `${BEST}-daily-${m.date}` : `${BEST}-${m.n}`;
    const prev = Number(localStorage.getItem(key) || 0);
    if (mine && mine.total > prev) {
      localStorage.setItem(key, String(mine.total));
      best = prev ? "New best!" : null;
      party = !!prev;
    }
    const avg = mine ? `${pct(mine.avg)}% average match` : "";
    sub = [avg, best || (prev ? `Best: ${fmtPts(Math.max(prev, mine ? mine.total : 0))}` : "")].filter(Boolean).join(" · ");
  } else if (m.tie && mine && mine.rank === 1) {
    kicker = "Game over";
    title = "It's a tie!";
    sub = `${fmtPts(mine.total)} pts`;
    party = true;
  } else if (m.winner === st.pid) {
    kicker = "Winner";
    title = "You win!";
    sub = `${fmtPts(mine.total)} pts · ${pct(mine.avg)}% average match`;
    party = true;
  } else {
    kicker = "Winner";
    title = `${pl(m.winner).name} wins`;
    sub = mine ? `You came ${ordinal(mine.rank)} of ${m.standings.length} · ${fmtPts(mine.total)} pts` : "";
  }
  $("ov-kicker").textContent = kicker;
  $("ov-title").textContent = title;
  restartAnim($("ov-title"));
  $("ov-sub").textContent = sub;
  $("ov-list").innerHTML = m.solo
    ? ""
    : m.standings
        .map((s, i) => {
          const p = pl(s.id);
          const sub2 = s.left ? "left" : `${pct(s.avg)}% avg · ${s.snapped}/${m.n} snapped`;
          return `<li class="${s.id === st.pid ? "me" : ""} ${i === 0 ? "first" : ""}" style="animation-delay:${i * 60}ms"><span class="pos">${s.rank}</span>${avatar(p)}<span class="pname">${esc(p.name)}<small>${sub2}</small></span><span class="tot">${fmtPts(s.total)}</span></li>`;
        })
        .join("");
  const aw = [];
  if (m.awards.eye && !m.solo) aw.push(`<div class="award"><span class="k">Sharpest eye</span><b>${esc(pl(m.awards.eye.id).name)}</b><span>${pct(m.awards.eye.match)}% on ${esc(histName(m, m.awards.eye.r))}</span></div>`);
  if (m.awards.quick && !m.solo) aw.push(`<div class="award"><span class="k">Quickest draw</span><b>${esc(pl(m.awards.quick.id).name)}</b><span>${fmtSecs(m.awards.quick.ms)} on ${esc(histName(m, m.awards.quick.r))}</span></div>`);
  $("ov-awards").innerHTML = aw.join("");
  // your palette
  const pal = $("ov-palette");
  pal.replaceChildren();
  const hist = st.history.slice().sort((a, b) => a.r - b.r);
  $("ov-pal-h").hidden = !hist.length;
  $("btn-card").hidden = !hist.length;
  hist.forEach((x, i) => {
    const li = document.createElement("li");
    li.style.animationDelay = `${200 + i * 70}ms`;
    li.appendChild(photoTile(x.photo && x.photo.src, x.photo && x.photo.ring, x.row.miss ? "no snap" : "no photo"));
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.innerHTML = `<i style="background:${x.target.hex}"></i><b>${esc(x.target.name)}</b>`;
    li.appendChild(cap);
    const sc = document.createElement("span");
    sc.className = "pc";
    sc.textContent = x.row.miss ? "no snap" : `${pct(x.row.match)}% · +${fmtPts(x.row.pts)}`;
    li.appendChild(sc);
    pal.appendChild(li);
  });
  if (st.stopConfetti) st.stopConfetti();
  st.stopConfetti = null;
  if (party) {
    st.stopConfetti = confetti($("ov-confetti"));
    sfx.fanfare();
    buzz([40, 60, 40, 60, 120]);
  }
  renderOverActions();
}

function histName(m, r) {
  const h = m.history.find((x) => x.r === r);
  return h ? h.target : "";
}

function renderOverActions() {
  const amLeader = st.room && st.room.leader === st.pid;
  $("btn-again").hidden = !amLeader;
  $("btn-settings").hidden = !amLeader;
  $("ov-wait").hidden = amLeader;
}

async function onSaveCard() {
  const m = st.over;
  if (!m) return;
  const btn = $("btn-card");
  btn.disabled = true;
  try {
    const mine = m.standings.find((s) => s.id === st.pid);
    const c = await makeCard({
      name: st.me ? st.me.name : "",
      history: st.history.slice().sort((a, b) => a.r - b.r),
      total: mine ? mine.total : 0,
      place: m.solo || !mine ? "" : `${ordinal(mine.rank)} of ${m.standings.length}`,
      label: m.daily ? `Today's palette · ${m.date}` : m.solo ? "Solo hunt" : "Party",
    });
    await saveCard(c, `chroma-hunt-${localDate()}.png`);
  } catch {
    toast("Couldn't make the card on this phone.");
  }
  btn.disabled = false;
}

// ---------- ?dev&auto: join, turn the "camera" on and hunt by itself ----------
function autoStart() {
  const code = (params.get("room") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  if (code) join();
  else if (params.has("solo")) create(true, params.has("daily"));
  else if (params.has("host")) create(false, params.has("daily"));
}

function syncSound() {
  scr.game.classList.toggle("muted", isMuted());
}
