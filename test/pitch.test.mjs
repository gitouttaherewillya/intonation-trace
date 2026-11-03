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

// Silence / noise should not produce a confident pitch
const noise = new Float32Array(N).map(() => Math.random() - 0.5);
const rn = detect(noise, SR, 50, 2500);
console.log(`${rn ? 'FAIL' : 'ok  '} noise -> ${rn ? rn.freq.toFixed(1) : 'null'}`);
if (rn) failures++;

process.exit(failures ? 1 : 0);
