// YIN pitch detector (de Cheveigné & Kawahara, 2002).
// Returns { freq, clarity } for the fundamental, or null when no clear pitch is found.

export function createDetector(bufferSize) {
  const half = bufferSize >> 1;
  const raw = new Float32Array(half);
  const d = new Float32Array(half);

  return function detect(buf, sampleRate, minFreq = 50, maxFreq = 2500, threshold = 0.15) {
    const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
    const tauMax = Math.min(half - 2, Math.ceil(sampleRate / minFreq));

    // Difference function
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let sum = 0;
      for (let i = 0; i < half; i++) {
        const delta = buf[i] - buf[i + tau];
        sum += delta * delta;
      }
      raw[tau] = sum;
      d[tau] = sum;
    }

    // Cumulative mean normalised difference
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }

    // First dip below the threshold, followed down to its local minimum
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < threshold) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) return null;

    // Octave check: when the odd overtones are weak (a low note through small speakers, say) the
    // waveform nearly repeats every half period, so the first dip lands an octave high. If that dip
    // is only a fair match and the one at twice the lag is clearly better, that is the real period.
    // Only below 500 Hz: that is where it happens, and short lags are too coarse to compare reliably.
    const tau2 = 2 * tau;
    if (d[tau] > 0.05 && sampleRate / tau < 500 && tau2 + 3 <= tauMax) {
      let m = tau2;
      for (let t = tau2 - 3; t <= tau2 + 3; t++) if (d[t] < d[m]) m = t;
      if (d[m] < 0.65 * d[tau]) tau = m;
    }

    // Parabolic interpolation on the raw difference function for sub-sample accuracy
    const a = raw[tau - 1], b = raw[tau], c = raw[tau + 1];
    const denom = a + c - 2 * b;
    let period = denom !== 0 ? tau + (a - c) / (2 * denom) : tau;

    // Short periods (high notes) are refined by measuring across k periods,
    // which divides the interpolation error by k.
    const k = Math.floor((tauMax - 1) / period);
    if (k >= 2) {
      let m = Math.round(k * period);
      for (let step = 0; step < 3; step++) {
        if (raw[m - 1] < raw[m] && m - 1 > tau) m--;
        else if (raw[m + 1] < raw[m] && m + 1 <= tauMax) m++;
      }
      const a2 = raw[m - 1], b2 = raw[m], c2 = raw[m + 1];
      const den2 = a2 + c2 - 2 * b2;
      const multi = (den2 !== 0 ? m + (a2 - c2) / (2 * den2) : m) / k;
      if (Math.abs(multi - period) < 0.5) period = multi;
    }

    return { freq: sampleRate / period, clarity: 1 - d[tau] };
  };
}
