// Synth sound effects, a Geiger-style "you're getting warmer" click, vibration,
// and (big screen only) an announcer voice. No audio files.

let ctx = null;
let master = null;
let muted = false;

export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function setMuted(m) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.55;
  if (m && window.speechSynthesis) speechSynthesis.cancel();
}
export function isMuted() {
  return muted;
}

function tone(freq, dur, { type = "sine", vol = 0.25, at = 0, slide = 0, attack = 0.005 } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

let noiseBuf = null;
function noise(dur, { vol = 0.2, at = 0, freq = 1200, q = 0.8, type = "bandpass" } = {}) {
  if (!ctx || muted) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

export const sfx = {
  tick() { tone(880, 0.07, { type: "square", vol: 0.09 }); },
  go() {
    tone(660, 0.1, { type: "triangle", vol: 0.2 });
    tone(990, 0.22, { type: "triangle", vol: 0.18, at: 0.07 });
  },
  // a single Geiger click; pitch rises a little with the match
  click(m = 0) { noise(0.012, { vol: 0.16 + m * 0.12, freq: 2600 + m * 2400, q: 1.2, type: "bandpass" }); },
  hot() {
    tone(1318, 0.12, { type: "sine", vol: 0.12 });
    tone(1760, 0.18, { type: "sine", vol: 0.1, at: 0.06 });
  },
  shutter() {
    noise(0.05, { vol: 0.5, freq: 3200, q: 0.6 });
    noise(0.08, { vol: 0.35, freq: 900, q: 0.7, at: 0.06 });
    tone(180, 0.05, { type: "square", vol: 0.08, at: 0.06 });
  },
  lock() {
    [0, 0.08, 0.16].forEach((at, i) => tone([659, 880, 1175][i], 0.18, { type: "triangle", vol: 0.16, at }));
  },
  flip(i = 0) {
    noise(0.12, { vol: 0.14, freq: 1400 + i * 120, q: 0.5 });
    tone(330 * Math.pow(1.06, i), 0.1, { type: "triangle", vol: 0.08, at: 0.04 });
  },
  best() {
    [0, 0.09, 0.18, 0.27].forEach((at, i) => tone([784, 988, 1175, 1568][i], 0.22, { type: "triangle", vol: 0.16, at }));
  },
  miss() { tone(240, 0.3, { type: "sawtooth", vol: 0.1, slide: -90 }); },
  whoosh() { noise(0.4, { vol: 0.16, freq: 700, q: 0.4 }); },
  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: "triangle", vol: 0.2, at: i * 0.11 }));
    tone(1047, 0.7, { type: "triangle", vol: 0.18, at: 0.48 });
  },
};

export function buzz(pattern) {
  if (muted || !navigator.vibrate) return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate(pattern); } catch {}
}

// Announcer (big screen). Browsers only speak after the page has had a click.
let voice = null;
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  voice =
    vs.find((v) => /en[-_](GB|US)/i.test(v.lang) && /Google|Samantha|Daniel|Aria|Guy|Jenny|Serena/i.test(v.name)) ||
    vs.find((v) => /^en/i.test(v.lang)) ||
    null;
}
if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}
export function say(text, { rate = 1.02, pitch = 1 } = {}) {
  if (muted || !window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = rate;
    u.pitch = pitch;
    speechSynthesis.speak(u);
  } catch {}
}
