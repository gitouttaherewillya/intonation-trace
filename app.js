import { createDetector } from './pitch.js';

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const INSTRUMENTS = {
  violin: [55, 62, 69, 76], // G3 D4 A4 E5
  viola: [48, 55, 62, 69],  // C3 G3 D4 A4
  cello: [36, 43, 50, 57],  // C2 G2 D3 A3
};
const DEFAULTS = { instrument: 'violin', ref: 440, tuning: 'pure', tolerance: 5, window: 8, gate: -55, autoStop: 10, recordTakes: false };
const STORAGE_KEY = 'intonation-trace-settings';
const BUF_SIZE = 2048;
const MAX_FREQ = 2600;
const MIN_CLARITY = 0.8;
const CENTS_RANGE = 50;
const VIBRATO_WINDOW = 0.36; // s, about two vibrato cycles
const ONSET_SETTLE = 0.045; // s, one analysis window
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
    line: get('--line'), band: get('--band'), flat: get('--flat'), sharp: get('--sharp'), tune: get('--tune'),
  };
  palette.inkRgb = hexToRgb(palette.ink);
  palette.flatRgb = hexToRgb(palette.flat);
  palette.sharpRgb = hexToRgb(palette.sharp);
}
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Green inside the in-tune zone; outside it red (flat) or blue (sharp), deepening up to 25 cents off.
function centsColour(cents) {
  const off = Math.abs(cents) - settings.tolerance;
  if (off <= 0) return palette.tune;
  const t = 0.45 + 0.55 * Math.min(1, off / Math.max(1, 25 - settings.tolerance));
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
let lastPlayedAt = 0;
let recorder = null; // MediaRecorder for the take in progress
let take = null;     // { url, t0, duration } of the last finished take; its pitches stay in `history`

async function start(useDemo) {
  $('error').textContent = '';
  $('notice').textContent = '';
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
      discardTake();
      if (settings.recordTakes && typeof MediaRecorder !== 'undefined') startRecording(stream);
    } else {
      discardTake();
      audio.demo = createDemo(ctx, analyser);
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
  prevSmoothed = null;
  lastPlayedAt = performance.now() / 1000;
  setPaused(false);
  setMuted(true);
  $('mute').hidden = !audio.demo;
  $('overlay').hidden = true;
  $('toggle').textContent = 'Stop';
  $('pause').disabled = false;
  requestWakeLock();
  requestAnimationFrame(tick);
}

// Stops listening; a notice brings the start screen back explaining why.
function stop(notice = '') {
  if (recorder) finishRecording();
  if (audio) {
    audio.stream?.getTracks().forEach((t) => t.stop());
    audio.ctx.close();
  }
  audio = null;
  $('toggle').textContent = 'Start';
  $('pause').disabled = true;
  $('mute').hidden = true;
  releaseWakeLock();
  if (notice) {
    $('notice').textContent = notice;
    $('overlay').hidden = false;
  }
}

// ---------- demo ----------

// A short original tune, played with notes that land out of tune and are corrected, plus vibrato,
// so the display can be tried without an instrument. [semitones above the second string, beats]
const DEMO_TUNE = [
  [0, 1], [4, 1], [7, 1], [12, 1], [11, 1], [9, 1], [7, 2],
  [9, 1], [11, 1], [12, 1], [14, 1], [16, 2], [14, 1], [12, 1],
  [12, 1], [9, 1], [5, 1], [7, 2], [4, 1], [2, 1], [0, 3],
];
const BEAT = 0.5;
const BODY_SCALE = { violin: 1, viola: 0.8, cello: 0.45 };
const rand = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };

// A bowed string vibrates close to a sawtooth. The speakers hear it through filters standing in for
// the instrument's body resonances, plus a little room reverb; the detector hears the plain tone.
function createDemo(ctx, analyser) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const env = ctx.createGain();
  env.gain.value = 0;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.5;
  const vib = ctx.createGain(); // vibrato depth in cents
  vib.gain.value = 0;
  lfo.connect(vib).connect(osc.detune);
  osc.connect(env).connect(analyser);

  const k = BODY_SCALE[settings.instrument];
  const filters = [
    ['highpass', openStrings()[0].freq * 0.7, 0.7, 0],
    ['peaking', 280 * k, 2, 5],
    ['peaking', 500 * k, 3, 4],
    ['peaking', 2600 * k, 1.2, 4],
    ['lowpass', 4500 * Math.sqrt(k), 0.5, 0],
    ['lowpass', 4500 * Math.sqrt(k), 0.5, 0],
  ].map(([type, frequency, Q, gain]) => new BiquadFilterNode(ctx, { type, frequency, Q, gain }));
  filters.reduce((prev, f) => prev.connect(f), env);
  const body = filters[filters.length - 1];

  const out = ctx.createGain(); // master volume, which is also the mute
  out.gain.value = 0;
  const reverb = new ConvolverNode(ctx, { buffer: roomImpulse(ctx) });
  const wet = new GainNode(ctx, { gain: 0.35 });
  body.connect(out);
  body.connect(reverb).connect(wet).connect(out);
  out.connect(ctx.destination);

  osc.start();
  lfo.start();
  return { osc, env, vib, out, next: ctx.currentTime + 0.2, i: 0 };
}

function roomImpulse(ctx, seconds = 1.8) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 4;
  }
  return ir;
}

// Schedules the tune a little ahead of the audio clock.
function scheduleDemo() {
  const d = audio.demo;
  while (d.next < audio.ctx.currentTime + 0.4) {
    const [step, beats] = DEMO_TUNE[d.i % DEMO_TUNE.length];
    const start = d.next, dur = beats * BEAT;
    const midi = INSTRUMENTS[settings.instrument][1] + step;
    const onset = (rand(d.i * 2) - 0.5) * 50; // lands up to ±25 cents out...
    const settle = (rand(d.i * 2 + 1) - 0.5) * 16; // ...then is corrected to within ±8
    const freq = (cents) => midiToFreq(midi + cents / 100);
    d.osc.frequency.setTargetAtTime(freq(onset), start, 0.012);
    d.osc.frequency.setTargetAtTime(freq(settle), start + 0.06, 0.22);
    d.env.gain.setTargetAtTime(0.3, start, 0.04);
    d.env.gain.setTargetAtTime(0.22, start + 0.2, 0.25);
    d.env.gain.setTargetAtTime(0, start + dur - 0.07, beats >= 3 ? 0.15 : 0.025);
    d.vib.gain.setValueAtTime(0, start);
    d.vib.gain.setValueAtTime(0, start + Math.min(0.3, dur * 0.4));
    d.vib.gain.linearRampToValueAtTime(beats > 1 ? 14 : 6, start + Math.min(0.8, dur - 0.05));
    d.next += dur;
    d.i++;
    if (d.i % DEMO_TUNE.length === 0) d.next += 2 * BEAT;
  }
}

let muted = true;
function setMuted(value) {
  muted = value;
  if (audio?.demo) audio.demo.out.gain.setTargetAtTime(muted ? 0 : 0.7, audio.ctx.currentTime, 0.05);
  $('mute').setAttribute('aria-pressed', String(muted));
  $('mute').querySelector('.label').textContent = muted ? 'Sound off' : 'Sound on';
}

function tick() {
  if (!audio) return;
  if (audio.demo) scheduleDemo();
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
    const smoothed = settle(now, smooth(now, midi));
    history.push({ t: now, midi: smoothed, db, centre: vibratoCentre(now, smoothed) });
    if (!recorder) {
      // A take keeps its whole history for playback; otherwise only what is on screen is kept
      const cutoff = now - settings.window - 1;
      while (history.length && history[0].t < cutoff) history.shift();
    }
    if (midi !== null) lastPlayedAt = now;
  } else if (db > settings.gate) {
    lastPlayedAt = now;
  }

  if (!audio.demo && settings.autoStop > 0 && now - lastPlayedAt > settings.autoStop * 60) {
    stop(`Listening stopped after ${settings.autoStop} minutes without playing.`);
    return;
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

// The first frames of a new note are analysed with a window that still holds the silence or note
// before it, which reads several cents out (usually sharp), so they are held back until it has filled.
let prevSmoothed = null, noteStart = 0;
function settle(now, midi) {
  if (midi !== null && (prevSmoothed === null || Math.abs(midi - prevSmoothed) > 0.7)) noteStart = now;
  prevSmoothed = midi;
  return midi !== null && now - noteStart >= ONSET_SETTLE ? midi : null;
}

// The middle pitch over the last couple of vibrato cycles of the current note. Intonation is
// judged (and coloured) by this, since a vibrato swings either side of the note being aimed at;
// a median keeps a stray reading from dragging it.
function vibratoCentre(now, midi) {
  if (midi === null) return null;
  const recent = [midi];
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i];
    if (s.midi === null || now - s.t > VIBRATO_WINDOW || Math.abs(s.midi - midi) > 0.7) break;
    recent.push(s.midi);
  }
  recent.sort((a, b) => a - b);
  return recent[Math.floor(recent.length / 2)];
}

// ---------- recording and playback ----------

function startRecording(stream) {
  const chunks = [];
  const rec = new MediaRecorder(stream);
  rec.t0 = performance.now() / 1000;
  rec.onstart = () => { rec.t0 = performance.now() / 1000; };
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    if (rec.discarded) return;
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    setTake({ url: URL.createObjectURL(blob), mime: blob.type, t0: rec.t0, duration: rec.t1 - rec.t0 });
  };
  rec.start(1000);
  recorder = rec;
  $('recBadge').hidden = false;
}

function finishRecording() {
  recorder.t1 = performance.now() / 1000;
  recorder.stop();
  recorder = null;
  $('recBadge').hidden = true;
}

const player = new Audio();
player.preload = 'auto';

function setTake(t) {
  take = t;
  player.src = t.url;
  const ext = t.mime.includes('mp4') ? 'm4a' : t.mime.includes('ogg') ? 'ogg' : 'webm';
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  $('saveTake').href = t.url;
  $('saveTake').download = `Intonation take ${stamp}.${ext}`;
  $('scrub').max = t.duration;
  $('player').hidden = false;
  $('reviewBtn').hidden = false;
  showTakeAt(t.duration);
}

function discardTake() {
  if (recorder) {
    recorder.discarded = true;
    finishRecording();
  }
  if (!take) return;
  player.pause();
  player.removeAttribute('src');
  URL.revokeObjectURL(take.url);
  take = null;
  $('player').hidden = true;
  $('reviewBtn').hidden = true;
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Draws the charts as they were at `pos` seconds into the take.
function showTakeAt(pos) {
  $('scrub').value = pos;
  $('playTime').textContent = `${clock(pos)} / ${clock(take.duration)}`;
  draw(take.t0 + pos);
}

function togglePlayback() {
  if (!take || audio) return;
  if (player.paused) {
    if (Number($('scrub').value) >= take.duration - 0.05) player.currentTime = 0;
    player.play();
  } else {
    player.pause();
  }
}

function playbackTick() {
  if (!take || player.paused) return;
  showTakeAt(Math.min(player.currentTime, take.duration));
  requestAnimationFrame(playbackTick);
}

player.addEventListener('play', () => {
  $('playBtn').classList.add('playing');
  $('playBtn').setAttribute('aria-label', 'Pause');
  requestAnimationFrame(playbackTick);
});
player.addEventListener('pause', () => {
  $('playBtn').classList.remove('playing');
  $('playBtn').setAttribute('aria-label', 'Play');
});
player.addEventListener('ended', () => { if (take) showTakeAt(take.duration); });

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
    const cents = centsOff(last.centre);
    ctx.fillStyle = centsColour(cents);
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.fillText(formatCents(cents), plotW + 10, y(cents));
  }
}

// Index of the first sample at or after time t (history is in time order).
function indexAt(t) {
  let lo = 0, hi = history.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Consecutive stretches of the visible history (up to `now`) where each neighbouring pair satisfies `joined`.
function runs(now, joined) {
  const out = [];
  let run = [];
  for (let i = indexAt(now - settings.window - 0.2); i < history.length && history[i].t <= now; i++) {
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
  run.forEach((s, i) => g.addColorStop(Math.min(1, Math.max(0, (xs[i] - x0) / span)), centsColour(centsOff(s.centre))));
  return g;
}

// The sample at `now` if it is recent enough to count as the note still sounding.
function latest(now) {
  const last = history[indexAt(now + 1e-6) - 1];
  return last && last.midi !== null && now - last.t < 0.15 ? last : null;
}

function formatCents(cents) {
  const r = Math.round(cents);
  return r === 0 ? '±0' : `${r > 0 ? '+' : '−'}${Math.abs(r)}`;
}

let needleCents = 0;
function updateReadout(now) {
  const last = latest(now);
  $('tuner').classList.toggle('idle', !last);
  $('zone').style.left = `${50 - settings.tolerance}%`;
  $('zone').style.width = `${2 * settings.tolerance}%`;
  if (last) {
    const m = Math.round(last.midi);
    const cents = centsOff(last.centre);
    // Eased so vibrato reads as a gentle sway rather than a blur
    needleCents += (cents - needleCents) * 0.35;
    $('needle').style.left = `${50 + Math.max(-50, Math.min(50, needleCents))}%`;
    $('needle').style.background = centsColour(needleCents);
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

// Never leave the microphone open in the background: stop as soon as the page is hidden
// (switching apps, locking the phone, changing tab).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') player.pause();
  if (document.visibilityState === 'hidden' && audio) {
    stop(audio.demo ? '' : 'Listening stopped when you left the page. Start again whenever you’re ready.');
  }
});
window.addEventListener('pagehide', () => stop());

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
    redraw();
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
bindSetting('autoStop', 'autoStop', String);
// Recording is opt-in, from either the start screen or Settings; both boxes stay in step.
// It takes effect the next time listening starts.
for (const id of ['record', 'recordStart']) {
  $(id).checked = settings.recordTakes;
  $(id).addEventListener('change', () => {
    settings.recordTakes = $(id).checked;
    $('record').checked = $('recordStart').checked = settings.recordTakes;
    saveSettings();
  });
}

$('toggle').addEventListener('click', () => (audio ? stop() : start(false)));
$('startBig').addEventListener('click', () => start(false));
$('demoBtn').addEventListener('click', () => start(true));
$('pause').addEventListener('click', () => setPaused(!paused));
$('mute').addEventListener('click', () => setMuted(!muted));
$('playBtn').addEventListener('click', togglePlayback);
$('scrub').addEventListener('input', () => {
  const pos = Number($('scrub').value);
  player.currentTime = pos;
  showTakeAt(pos);
});
$('closeTake').addEventListener('click', () => {
  discardTake();
  history = [];
  draw(performance.now() / 1000);
});
$('reviewBtn').addEventListener('click', () => { $('overlay').hidden = true; });
$('settingsBtn').addEventListener('click', () => {
  const panel = $('settings');
  panel.hidden = !panel.hidden;
  $('settingsBtn').setAttribute('aria-expanded', String(!panel.hidden));
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !['INPUT', 'SELECT', 'BUTTON'].includes(e.target.tagName)) {
    e.preventDefault();
    if (audio) setPaused(!paused);
    else togglePlayback();
  }
});

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
// Redraw when idle (live listening and playback redraw every frame anyway)
const redraw = () => {
  if (audio) return;
  if (take) showTakeAt(Number($('scrub').value));
  else draw(performance.now() / 1000);
};
darkQuery.addEventListener('change', () => { readPalette(); redraw(); });
new ResizeObserver(redraw).observe(document.querySelector('.charts'));

readPalette();
draw(performance.now() / 1000);

// ?demo starts the demo straight away (handy for a quick look, or for screenshots)
if (new URLSearchParams(location.search).has('demo')) start(true);
