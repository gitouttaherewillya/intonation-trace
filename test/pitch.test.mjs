// Run with: node test/pitch.test.mjs
// Checks the detector against synthetic bowed-string-like tones across cello and violin range.
import { createDetector } from '../pitch.js';

const SR = 48000;
const N = 2048;
const detect = createDetector(N);

// Sawtooth-ish tone with a weak fundamental, which is the hard case for octave errors.
function tone(freq, phase = 0) {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h * freq < SR / 2 && h <= 20; h++) {
      const amp = (h === 1 ? 0.4 : 1) / h;
      v += amp * Math.sin(2 * Math.PI * freq * h * t + phase * h);
    }
    buf[i] = v * 0.3 + (Math.random() - 0.5) * 0.01;
  }
  return buf;
}

const cases = [65.41, 73.42, 98, 146.83, 220, 261.63, 293.66, 440, 659.25, 987.77, 1318.5, 2093];
let failures = 0;
for (const f of cases) {
  const r = detect(tone(f, Math.random() * 6), SR, 50, 2500);
  const cents = r ? 1200 * Math.log2(r.freq / f) : NaN;
  const ok = r && Math.abs(cents) < 2;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.toFixed(2).padStart(8)} Hz -> ${r ? r.freq.toFixed(2) : 'null'} Hz (${cents.toFixed(2)} cents)`);
}

// Low piano notes heard through small speakers and a phone mic: fundamental cut, odd overtones weak,
// stretched partials. These used to read an octave high.
const hp = (f, fc) => (f / fc) ** 2 / Math.sqrt(1 + (f / fc) ** 4);
function bassPiano(f0, B = 0.0004, odd = 0.2) {
  const buf = new Float32Array(N);
  for (let n = 1; n <= 30; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n);
    const amp = hp(fn, 120) / (1 + ((n - 3) / 4) ** 2) * (n % 2 ? odd : 1);
    const ph = Math.sin(n * 91.7) * 6; // fixed phases keep the test repeatable
    for (let i = 0; i < N; i++) buf[i] += amp * Math.sin(2 * Math.PI * fn * (i / SR) + ph);
  }
  return buf;
}
for (const f of [65.41, 73.42, 82.41, 98]) {
  const r = detect(bassPiano(f), SR, 65.19 * 0.8, 2500);
  const semis = r ? 12 * Math.log2(r.freq / f) : NaN;
  const ok = r && Math.abs(semis) < 0.5;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} bass piano ${f.toFixed(2).padStart(6)} Hz -> ${r ? r.freq.toFixed(2) : 'null'} Hz`);
}

// Silence / noise should not produce a confident pitch
const noise = new Float32Array(N).map(() => Math.random() - 0.5);
const rn = detect(noise, SR, 50, 2500);
console.log(`${rn ? 'FAIL' : 'ok  '} noise -> ${rn ? rn.freq.toFixed(1) : 'null'}`);
if (rn) failures++;

process.exit(failures ? 1 : 0);
