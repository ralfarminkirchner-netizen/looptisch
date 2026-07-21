/**
 * LOOPTiSCH DSP Lab — offline buffer processing (zero dependencies)
 * WSOLA time-stretch · resample pitch · ACF pitch-detect · scale-snap "TUNE"
 * reverse / normalize / trim. Works on AudioBuffer channel arrays, stereo-safe
 * (shared grain map from channel 0 keeps phase).
 */
(function (global) {
  'use strict';

  const tick = () => new Promise((r) => setTimeout(r, 0));

  function toChannels(buffer) {
    const ch = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) ch.push(buffer.getChannelData(c).slice());
    return ch;
  }

  function fromChannels(ctx, chans, sr) {
    const len = chans[0].length;
    const buf = ctx.createBuffer(chans.length, Math.max(1, len), sr);
    chans.forEach((d, c) => buf.copyToChannel(d.subarray(0, len), c));
    return buf;
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    return w;
  }

  /** linear resample by rate (rate 2 = double speed/pitch, half length) */
  function resample(chans, rate) {
    if (Math.abs(rate - 1) < 1e-4) return chans;
    const N = chans[0].length;
    const outN = Math.max(8, Math.round(N / rate));
    return chans.map((src) => {
      const out = new Float32Array(outN);
      for (let i = 0; i < outN; i++) {
        const p = i * rate;
        const i0 = Math.min(N - 2, Math.floor(p));
        const fr = p - i0;
        out[i] = src[i0] * (1 - fr) + src[i0 + 1] * fr;
      }
      return out;
    });
  }

  /**
   * WSOLA time-stretch. ratio > 1 → longer/slower (pitch preserved).
   * Async, yields periodically so the UI stays alive.
   */
  async function wsola(chans, sr, ratio, onProgress) {
    if (Math.abs(ratio - 1) < 1e-3) return chans;
    const N = chans[0].length;
    const win = 1024;
    const Hs = win >> 2;                    // synthesis hop
    const Ha = Hs / ratio;                  // analysis hop
    const tol = Math.min(512, Math.round(sr * 0.012)); // ± search tolerance
    const ref = chans[0];
    const outLen = Math.round(N * ratio) + win * 2;
    const outs = chans.map(() => new Float32Array(outLen));
    const norm = new Float32Array(outLen);
    const w = hann(win);
    const ovLen = Hs;

    let prevX = 0;
    let outPos = 0;
    let grain = 0;
    const maxGrains = Math.ceil((N - win) / Ha) + 2;

    while (prevX + Ha < N - win && outPos + win < outLen) {
      const expect = prevX + Ha;
      const lo = Math.max(0, Math.round(expect - tol));
      const hi = Math.min(N - win - ovLen - 1, Math.round(expect + tol));
      // best correlation vs continuation of previous grain
      const tX = prevX + Hs;
      let bestX = Math.round(expect);
      let best = -Infinity;
      for (let x = lo; x <= hi; x += 2) {
        let s = 0;
        for (let i = 0; i < ovLen; i += 4) s += ref[x + i] * ref[tX + i];
        if (s > best) { best = s; bestX = x; }
      }
      // refine ±1
      for (let x = Math.max(lo, bestX - 1); x <= Math.min(hi, bestX + 1); x++) {
        let s = 0;
        for (let i = 0; i < ovLen; i += 2) s += ref[x + i] * ref[tX + i];
        if (s > best) { best = s; bestX = x; }
      }
      for (let i = 0; i < win; i++) {
        const g = w[i];
        for (let c = 0; c < outs.length; c++) outs[c][outPos + i] += chans[c][bestX + i] * g;
        norm[outPos + i] += g;
      }
      prevX = bestX;
      outPos += Hs;
      grain++;
      if ((grain & 63) === 0) {
        if (onProgress) onProgress(Math.min(1, grain / maxGrains));
        await tick();
      }
    }
    const finalLen = Math.max(1, outPos + win);
    const res = outs.map((o) => {
      const t = o.subarray(0, finalLen);
      for (let i = 0; i < finalLen; i++) { const n = norm[i]; if (n > 1e-6) t[i] /= Math.max(n, 0.5); }
      return t;
    });
    if (onProgress) onProgress(1);
    return res;
  }

  /** pitch shift in semitones, duration preserved (resample + WSOLA) */
  async function pitchShift(chans, sr, semis, onProgress) {
    const r = Math.pow(2, semis / 12);
    if (Math.abs(r - 1) < 1e-4) return chans;
    const shifted = resample(chans, r);
    return wsola(shifted, sr, r, onProgress);
  }

  /** ACF pitch detection, returns Hz or 0 (unvoiced) */
  function detectPitch(frame, sr) {
    const len = frame.length;
    let mean = 0;
    for (let i = 0; i < len; i++) mean += frame[i];
    mean /= len;
    const x = new Float32Array(len);
    let r0 = 0;
    for (let i = 0; i < len; i++) { x[i] = frame[i] - mean; r0 += x[i] * x[i]; }
    if (r0 / len < 1e-5) return 0;
    const minLag = Math.max(2, Math.floor(sr / 800));
    const maxLag = Math.min(Math.ceil(sr / 50), len >> 1);
    let bestLag = 0, best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < len - lag; i += 2) s += x[i] * x[i + lag];
      if (s > best) { best = s; bestLag = lag; }
    }
    if (!bestLag || best < 0.18 * r0) return 0;
    // parabolic interpolation
    const corr = (lag) => { let s = 0; for (let i = 0; i < len - lag; i += 2) s += x[i] * x[i + lag]; return s; };
    const y0 = corr(bestLag - 1), y1 = best, y2 = corr(bestLag + 1);
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    return sr / (bestLag + shift);
  }

  const SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10];
  const NOTE_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

  function nearestScaleDelta(f0, rootPC, scale) {
    const midi = 69 + 12 * Math.log2(f0 / 440);
    let bestDelta = 0, bestDist = Infinity;
    for (let d = -7; d <= 7; d += 0.02) {
      const m = midi + d;
      const pc = ((Math.round(m) % 12) + 12) % 12;
      if (!scale.includes(((pc - rootPC) % 12 + 12) % 12)) continue;
      const dist = Math.abs(d);
      if (dist < bestDist) { bestDist = dist; bestDelta = d; }
    }
    return bestDelta;
  }

  /**
   * TUNE — AutoTune-style scale snap (time-varying granular pitch shift).
   * keyName like 'Am' / 'C'. strength 0..1 (1 = hard tune).
   */
  async function tuneToScale(chans, sr, keyName, strength, onProgress) {
    const m = String(keyName || 'A').match(/^([A-G][#b]?)(m)?/);
    const rootPC = NOTE_PC[m ? m[1] : 'A'] ?? 9;
    const scale = m && m[2] ? SCALE_MINOR : SCALE_MAJOR;
    const N = chans[0].length;
    const ref = chans[0];

    // 1) pitch track: frame 2048, hop 512
    const fLen = 2048, fHop = 512;
    const nFrames = Math.max(1, Math.floor((N - fLen) / fHop));
    const shifts = new Float32Array(nFrames + 2);
    let lastShift = 0;
    for (let f = 0; f < nFrames; f++) {
      const f0 = detectPitch(ref.subarray(f * fHop, f * fHop + fLen), sr);
      if (f0 > 0) {
        const d = nearestScaleDelta(f0, rootPC, scale);
        lastShift = Math.max(-12, Math.min(12, d)) * strength;
      }
      shifts[f] = lastShift; // hold last through unvoiced gaps
      if ((f & 31) === 0) { if (onProgress) onProgress((f / nFrames) * 0.4); await tick(); }
    }
    // light smoothing (attack ~20ms, keeps hard-tune character at strength 1)
    const sm = new Float32Array(shifts.length);
    let acc = 0;
    const atk = strength >= 0.95 ? 0.9 : 0.35;
    for (let i = 0; i < shifts.length; i++) { acc += atk * (shifts[i] - acc); sm[i] = acc; }

    // 2) variable-rate granular resynthesis, duration preserved
    const win = 2048, Hs = win >> 2;
    const w = hann(win);
    const outs = chans.map(() => new Float32Array(N + win));
    const norm = new Float32Array(N + win);
    let inPos = 0, outPos = 0, g = 0;
    const maxG = Math.ceil(N / Hs);
    while (outPos + win < N + win - 1 && inPos + win < N - 1) {
      const fr = Math.min(nFrames - 1, Math.max(0, Math.round(inPos / fHop)));
      const semi = sm[fr];
      for (let i = 0; i < win; i++) {
        const gg = w[i];
        const p = inPos + i;
        const i0 = Math.floor(p);
        for (let c = 0; c < outs.length; c++) outs[c][outPos + i] += chans[c][i0] * gg;
        norm[outPos + i] += gg;
      }
      inPos += Hs * Math.pow(2, semi / 12);
      outPos += Hs;
      g++;
      if ((g & 63) === 0) { if (onProgress) onProgress(0.4 + 0.6 * (g / maxG)); await tick(); }
    }
    const res = outs.map((o, c) => {
      const t = o.subarray(0, N);
      for (let i = 0; i < N; i++) { const n = norm[i]; if (n > 1e-6) t[i] /= Math.max(n, 0.5); }
      return t;
    });
    if (onProgress) onProgress(1);
    return res;
  }

  function reverse(chans) { return chans.map((c) => c.slice().reverse()); }

  function normalize(chans, target = 0.98) {
    let peak = 0;
    chans.forEach((c) => { for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; } });
    if (peak < 1e-6) return chans;
    const g = target / peak;
    return chans.map((c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] * g; return o; });
  }

  function trimSilence(chans, sr, threshDb = -50) {
    const th = Math.pow(10, threshDb / 20);
    const ref = chans[0];
    let a = 0, b = ref.length - 1;
    while (a < ref.length - 1 && Math.abs(ref[a]) < th) a++;
    while (b > a && Math.abs(ref[b]) < th) b--;
    const pad = Math.round(sr * 0.01);
    a = Math.max(0, a - pad); b = Math.min(ref.length - 1, b + pad);
    return chans.map((c) => c.slice(a, b + 1));
  }

  global.LT_DSP = {
    toChannels, fromChannels, wsola, pitchShift, tuneToScale,
    reverse, normalize, trimSilence, detectPitch, resample,
  };
})(window);
