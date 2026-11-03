import { createDetector } from './pitch.js';

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const INSTRUMENTS = {
  violin: [55, 62, 69, 76], // G3 D4 A4 E5
  viola: [48, 55, 62, 69],  // C3 G3 D4 A4
  cello: [36, 43, 50, 57],  // C2 G2 D3 A3
};
const DEFAULTS = { instrument: 'violin', ref: 440, tuning: 'pure', tolerance: 5, window: 8, gate: -55 };
const STORAGE_KEY = 'intonation-trace-settings';
const BUF_SIZE = 2048;
const MAX_FREQ = 2600;
const MIN_CLARITY = 0.8;
const CENTS_RANGE = 50;
const RIGHT_GUTTER = 92; // px kept free on the right of each chart for live labels

const $ = (id) => document.getElementById(id);
const settings = loadSettings();

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

// ---------- music helpers ----------

const freqToMidi = (f) => 69 + 12 * Math.log2(f / settings.ref);
const midiToFreq = (m) => settings.ref * 2 ** ((m - 69) / 12);
const pitchClass = (m) => ((m % 12) + 12) % 12;
const octaveOf = (m) => Math.floor(m / 12) - 1;
const centsOff = (midi) => (midi - Math.round(midi)) * 100;

// Open strings, either tuned in pure 3:2 fifths from the A string (as string players tune) or equal tempered.
function openStrings() {
  const notes = INSTRUMENTS[settings.instrument];
  const a = notes.find((m) => pitchClass(m) === 9);
  return notes.map((note) => {
    const freq = settings.tuning === 'pure' ? midiToFreq(a) * 1.5 ** ((note - a) / 7) : midiToFreq(note);
    return { note, freq, midi: freqToMidi(freq) };
  });
}

function midiRange() {
  const notes = INSTRUMENTS[settings.instrument];
  return [notes[0] - 2, notes[notes.length - 1] + 10];
}

// ---------- colours ----------

let palette;
function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  palette = {
    plot: get('--plot'), ink: get('--ink'), muted: get('--muted'), grid: get('--grid'),
    line: get('--line'), band: get('--band'), flat: get('--flat'), sharp: get('--sharp'),
  };
  palette.inkRgb = hexToRgb(palette.ink);
  palette.flatRgb = hexToRgb(palette.flat);
  palette.sharpRgb = hexToRgb(palette.sharp);
}
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Plain ink inside the in-tune zone, fading to red (flat) or blue (sharp) by 30 cents off.
function centsColour(cents) {
  const off = Math.abs(cents) - settings.tolerance;
  if (off <= 0) return palette.ink;
  const t = Math.min(1, off / (30 - settings.tolerance));
  const target = cents < 0 ? palette.flatRgb : palette.sharpRgb;
  const [r, g, b] = palette.inkRgb.map((v, i) => Math.round(v + (target[i] - v) * t));
  return `rgb(${r},${g},${b})`;
}

// ---------- audio ----------

const detect = createDetector(BUF_SIZE);
const buf = new Float32Array(BUF_SIZE);
let audio = null; // { ctx, analyser, stream?, demo? }
let paused = false;
let frozenAt = 0;
let history = [];   // { t, midi|null, db }
let recentRaw = []; // { t, midi } raw detections for median smoothing
let lastDb = -100;

async function start(useDemo) {
  $('error').textContent = '';
  try {
    let stream = null;
    if (!useDemo) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access the microphone here (it needs HTTPS).');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = BUF_SIZE;
    audio = { ctx, analyser, stream };
    if (stream) {
      ctx.createMediaStreamSource(stream).connect(analyser);
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.connect(gain).connect(analyser); // analysed only, never played aloud
      osc.start();
      audio.demo = { osc, gain, t0: ctx.currentTime };
    }
    await ctx.resume();
  } catch (err) {
    stop();
    $('error').textContent = err.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in your browser’s site settings and try again.'
      : err.message || String(err);
    return;
  }
  history = [];
  recentRaw = [];
  setPaused(false);
  $('overlay').hidden = true;
  $('toggle').textContent = 'Stop';
  $('pause').disabled = false;
  requestWakeLock();
  requestAnimationFrame(tick);
}

function stop() {
  if (audio) {
    audio.stream?.getTracks().forEach((t) => t.stop());
    audio.ctx.close();
  }
  audio = null;
  $('toggle').textContent = 'Start';
  $('pause').disabled = true;
  releaseWakeLock();
}

// A scale with deliberate intonation slips and vibrato, so the display can be tried without an instrument.
const DEMO_STEPS = [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2];
function updateDemo() {
  const { osc, gain, t0 } = audio.demo;
  const t = audio.ctx.currentTime - t0;
  const NOTE_LEN = 1.4;
  const step = Math.floor(t / NOTE_LEN);
  const phase = t - step * NOTE_LEN;
  const seed = Math.sin(step * 12.9898) * 43758.5453;
  const slip = ((seed - Math.floor(seed)) - 0.5) * 50; // ±25 cents
  const vibrato = 12 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, Math.max(0, (phase - 0.5) * 2));
  const cents = slip * Math.exp(-phase * 2.2) + vibrato;
  const midi = INSTRUMENTS[settings.instrument][1] + DEMO_STEPS[step % DEMO_STEPS.length] + cents / 100;
  osc.frequency.setTargetAtTime(midiToFreq(midi), audio.ctx.currentTime, 0.005);
  gain.gain.setTargetAtTime(phase > NOTE_LEN - 0.15 ? 0 : 0.3, audio.ctx.currentTime, 0.01);
}

function tick() {
  if (!audio) return;
  if (audio.demo) updateDemo();
  audio.analyser.getFloatTimeDomainData(buf);
  const now = performance.now() / 1000;

  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-12);
  lastDb = db;

  if (!paused) {
    let midi = null;
    if (db > settings.gate) {
      const lowest = openStrings()[0].freq;
      const r = detect(buf, audio.ctx.sampleRate, lowest * 0.8, MAX_FREQ);
      if (r && r.clarity > MIN_CLARITY) midi = freqToMidi(r.freq);
    }
    history.push({ t: now, midi: smooth(now, midi), db });
    const cutoff = now - settings.window - 1;
    while (history.length && history[0].t < cutoff) history.shift();
  }

  draw(paused ? frozenAt : now);
  requestAnimationFrame(tick);
}

// Median of the last three detections suppresses single-frame octave slips;
// a pitch is only shown once two frames in a row agree on it.
function smooth(now, midi) {
  if (midi === null) {
    recentRaw = [];
    return null;
  }
  recentRaw.push({ t: now, midi });
  recentRaw = recentRaw.filter((r) => now - r.t < 0.12).slice(-3);
  if (recentRaw.length < 2) return null;
  const sorted = recentRaw.map((r) => r.midi).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function setPaused(value) {
  paused = value;
  frozenAt = performance.now() / 1000;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
}

// ---------- drawing ----------

const pitchCanvas = $('pitchChart');
const centsCanvas = $('centsChart');

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const xOf = (t, now, plotW) => plotW * (1 - (now - t) / settings.window);
const linked = (a, b) => a.midi !== null && b.midi !== null && b.t - a.t < 0.1 && Math.abs(b.midi - a.midi) < 0.7;
const widthFor = (db) => 2 + 6 * Math.min(1, Math.max(0, (db - settings.gate) / 35));

function draw(now) {
  drawPitch(now);
  drawCents(now);
  updateReadout(now);
}

function drawPitch(now) {
  const { ctx, w, h } = fitCanvas(pitchCanvas);
  const plotW = w - RIGHT_GUTTER;
  const [lo, hi] = midiRange();
  const pad = 14;
  const y = (m) => pad + ((hi - m) / (hi - lo)) * (h - 2 * pad);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  // Semitone grid, labelled at each C
  const strings = openStrings();
  for (let m = Math.ceil(lo); m <= hi; m++) {
    ctx.fillStyle = palette.grid;
    ctx.fillRect(0, Math.round(y(m)), w, 1);
    if (pitchClass(m) === 0 && !strings.some((s) => Math.abs(y(s.midi) - y(m)) < 22)) {
      ctx.fillStyle = palette.muted;
      ctx.fillText(`C${octaveOf(m)}`, 6, y(m) - 7);
    }
  }

  // Open strings
  for (const s of strings) {
    const sy = Math.round(y(s.midi)) + 0.5;
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
    const label = `${NOTE_NAMES[pitchClass(s.note)]} ${s.freq.toFixed(1)}`;
    ctx.fillStyle = palette.plot;
    ctx.fillRect(4, sy - 9, ctx.measureText(label).width + 6, 18);
    ctx.fillStyle = palette.ink;
    ctx.fillText(label, 7, sy);
  }

  // Pitch trace: one ribbon per sustained note, thickness following loudness
  for (const run of runs(now, linked)) {
    const xs = run.map((s) => xOf(s.t, now, plotW));
    ctx.fillStyle = runGradient(ctx, run, xs);
    ctx.beginPath();
    run.forEach((s, i) => ctx.lineTo(xs[i], y(s.midi) - widthFor(s.db) / 2));
    for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(xs[i], y(run[i].midi) + widthFor(run[i].db) / 2);
    ctx.fill();
  }

  // Live note label at the head of the trace
  const last = latest(now);
  if (last) {
    const m = Math.round(last.midi);
    ctx.fillStyle = palette.ink;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillText(`${NOTE_NAMES[pitchClass(m)]}${octaveOf(m)}`, plotW + 10, y(last.midi) - 8);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = palette.muted;
    ctx.fillText(midiToFreq(last.midi).toFixed(1), plotW + 10, y(last.midi) + 8);
  }
}

function drawCents(now) {
  const { ctx, w, h } = fitCanvas(centsCanvas);
  const plotW = w - RIGHT_GUTTER;
  const mid = h / 2;
  const scale = (h / 2 - 8) / CENTS_RANGE;
  const y = (c) => mid - Math.max(-CENTS_RANGE, Math.min(CENTS_RANGE, c)) * scale;
  ctx.clearRect(0, 0, w, h);

  // In-tune band
  ctx.fillStyle = palette.band;
  ctx.fillRect(0, y(settings.tolerance), w, 2 * settings.tolerance * scale);

  // Grid every 10 cents
  for (let c = -40; c <= 40; c += 10) {
    if (c === 0) continue;
    ctx.fillStyle = palette.grid;
    ctx.fillRect(0, Math.round(y(c)), plotW, 1);
  }

  // Filled deviation from the nearest note
  const sounding = (a, b) => a.midi !== null && b.midi !== null && b.t - a.t < 0.1;
  for (const run of runs(now, sounding)) {
    const xs = run.map((s) => xOf(s.t, now, plotW));
    ctx.fillStyle = runGradient(ctx, run, xs);
    ctx.beginPath();
    ctx.moveTo(xs[0], mid);
    run.forEach((s, i) => ctx.lineTo(xs[i], y(centsOff(s.midi))));
    ctx.lineTo(xs[xs.length - 1], mid);
    ctx.fill();
  }

  ctx.fillStyle = palette.line;
  ctx.fillRect(0, Math.round(mid), w, 1);

  // Labels last so the fill never hides them
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const c of [-40, -20, 20, 40]) {
    const label = c > 0 ? `+${c}` : `−${-c}`;
    ctx.fillStyle = palette.plot;
    ctx.fillRect(3, y(c) - 8, ctx.measureText(label).width + 6, 16);
    ctx.fillStyle = palette.muted;
    ctx.fillText(label, 6, y(c));
  }

  const last = latest(now);
  if (last) {
    const cents = centsOff(last.midi);
    ctx.fillStyle = centsColour(cents);
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.fillText(formatCents(cents), plotW + 10, y(cents));
  }
}

// Consecutive stretches of history (up to `now`) where each neighbouring pair satisfies `joined`.
function runs(now, joined) {
  const out = [];
  let run = [];
  for (let i = 0; i < history.length && history[i].t <= now; i++) {
    const s = history[i];
    if (run.length && !joined(run[run.length - 1], s)) {
      if (run.length > 1) out.push(run);
      run = [];
    }
    if (s.midi !== null) run.push(s);
  }
  if (run.length > 1) out.push(run);
  return out;
}

// Horizontal gradient giving every frame of a run its own intonation colour.
function runGradient(ctx, run, xs) {
  const x0 = xs[0], span = Math.max(1, xs[xs.length - 1] - x0);
  const g = ctx.createLinearGradient(x0, 0, x0 + span, 0);
  run.forEach((s, i) => g.addColorStop(Math.min(1, Math.max(0, (xs[i] - x0) / span)), centsColour(centsOff(s.midi))));
  return g;
}

// The newest sample if it is recent enough to count as the note still sounding.
function latest(now) {
  const last = history[history.length - 1];
  return last && last.midi !== null && now - last.t < 0.15 ? last : null;
}

function formatCents(cents) {
  const r = Math.round(cents);
  return r === 0 ? '±0' : `${r > 0 ? '+' : '−'}${Math.abs(r)}`;
}

function updateReadout(now) {
  const last = latest(now);
  if (last) {
    const m = Math.round(last.midi);
    const cents = centsOff(last.midi);
    $('noteName').textContent = NOTE_NAMES[pitchClass(m)];
    $('noteOct').textContent = octaveOf(m);
    $('cents').textContent = `${formatCents(cents)}¢`;
    $('cents').style.color = centsColour(cents);
    $('freq').textContent = `${midiToFreq(last.midi).toFixed(1)} Hz`;
  } else if (!paused) {
    $('noteName').textContent = '–';
    $('noteOct').textContent = '';
    $('cents').textContent = '';
    $('freq').textContent = '';
  }
  const pct = (db) => `${Math.min(100, Math.max(0, ((db + 80) / 60) * 100))}%`;
  $('levelBar').style.width = pct(lastDb);
  $('gateMark').style.left = pct(settings.gate);
}

// ---------- wake lock (keeps the screen on while practising) ----------

let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported or denied */ }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audio) requestWakeLock();
});

// ---------- controls ----------

function bindSetting(id, key, format, parse = Number) {
  const el = $(id);
  const out = $(`${id}Out`);
  el.value = settings[key];
  if (out) out.textContent = format(settings[key]);
  el.addEventListener('input', () => {
    const v = parse(el.value);
    if (typeof v === 'number' && !Number.isFinite(v)) return;
    settings[key] = v;
    if (out) out.textContent = format(v);
    saveSettings();
    if (!audio) draw(performance.now() / 1000);
  });
}

bindSetting('instrument', 'instrument', String, String);
bindSetting('tuning', 'tuning', String, String);
bindSetting('ref', 'ref', String, (v) => {
  const n = Number(v);
  return n >= 400 && n <= 480 ? n : NaN;
});
bindSetting('tolerance', 'tolerance', (v) => `±${v} cents`);
bindSetting('window', 'window', (v) => `${v} s`);
bindSetting('gate', 'gate', (v) => `${v} dB`);

$('toggle').addEventListener('click', () => (audio ? stop() : start(false)));
$('startBig').addEventListener('click', () => start(false));
$('demoBtn').addEventListener('click', () => start(true));
$('pause').addEventListener('click', () => setPaused(!paused));
$('settingsBtn').addEventListener('click', () => {
  const panel = $('settings');
  panel.hidden = !panel.hidden;
  $('settingsBtn').setAttribute('aria-expanded', String(!panel.hidden));
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && audio && !['INPUT', 'SELECT', 'BUTTON'].includes(e.target.tagName)) {
    e.preventDefault();
    setPaused(!paused);
  }
});

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener('change', () => { readPalette(); if (!audio) draw(performance.now() / 1000); });
new ResizeObserver(() => { if (!audio) draw(performance.now() / 1000); }).observe(document.querySelector('.charts'));

readPalette();
draw(performance.now() / 1000);

// ?demo starts the demo straight away (handy for a quick look, or for screenshots)
if (new URLSearchParams(location.search).has('demo')) start(true);
