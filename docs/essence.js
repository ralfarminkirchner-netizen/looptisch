/**
 * LOOPTiSCH Essence — music style signature (client-side, zero deps).
 * Interop with Ralf's Essence Engine (~/Projects/signature-of-style):
 * cells there / signatures here share the same philosophy:
 * signature = Hypothesenbündel, NOT identity. Delta = distance, not proof.
 *
 * schema: looptisch.music-essence/v1
 */
(function (global) {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Krumhansl-Schmuckler profiles
  const K_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const K_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function monoFromBuffer(buf) {
    const n = buf.length, ch = buf.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  /** Goertzel power for one frame at freq f */
  function goertzel(frame, sr, f) {
    const w = (2 * Math.PI * f) / sr;
    const cw = Math.cos(w), sw = Math.sin(w);
    const coeff = 2 * cw;
    let q0 = 0, q1 = 0, q2 = 0;
    for (let i = 0; i < frame.length; i++) {
      q0 = coeff * q1 - q2 + frame[i];
      q2 = q1; q1 = q0;
    }
    return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
  }

  /** 12 pitch-class energies + key estimate (Krumhansl-Schmuckler) */
  function chromaAndKey(mono, sr) {
    const pc = new Float32Array(12);
    const frameLen = 8192;
    const nFrames = Math.max(1, Math.min(6, Math.floor(mono.length / frameLen)));
    const notes = [];
    for (let m = 36; m <= 96; m++) notes.push({ m, f: 440 * Math.pow(2, (m - 69) / 12) });
    for (let fr = 0; fr < nFrames; fr++) {
      const off = Math.floor((mono.length - frameLen) * (fr / Math.max(1, nFrames - 1 || 1)));
      const frame = mono.subarray(Math.max(0, off), Math.max(0, off) + frameLen);
      // Hann
      for (let i = 0; i < frame.length; i++) frame[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frame.length - 1)));
      for (const n of notes) {
        // skip notes above Nyquist of effective content
        if (n.f > sr / 2.2) continue;
        const p = goertzel(frame, sr, n.f);
        pc[n.m % 12] += Math.sqrt(Math.max(0, p));
      }
    }
    const total = pc.reduce((a, b) => a + b, 0) || 1;
    const norm = Array.from(pc, (v) => v / total);

    const corr = (profile, rot) => {
      const x = norm.map((_, i) => norm[(i + rot) % 12]);
      const mx = x.reduce((a, b) => a + b, 0) / 12;
      const my = profile.reduce((a, b) => a + b, 0) / 12;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < 12; i++) {
        num += (x[i] - mx) * (profile[i] - my);
        dx += (x[i] - mx) ** 2; dy += (profile[i] - my) ** 2;
      }
      return num / (Math.sqrt(dx * dy) || 1);
    };
    let best = { key: '—', score: -2 };
    for (let rot = 0; rot < 12; rot++) {
      const maj = corr(K_MAJOR, rot);
      if (maj > best.score) best = { key: NOTE_NAMES[rot], score: maj };
      const min = corr(K_MINOR, rot);
      if (min > best.score) best = { key: NOTE_NAMES[rot] + 'm', score: min };
    }
    return { chroma: norm.map((v) => +v.toFixed(4)), key: best.key, keyConfidence: +best.score.toFixed(3) };
  }

  /** swing estimate from onset times vs straight 8th grid */
  function estimateSwing(onsetTimes, bpm) {
    if (!bpm || onsetTimes.length < 6) return 50;
    const eighth = 60 / bpm / 2;
    const devs = [];
    for (const t of onsetTimes) {
      const pos = t / eighth;
      const frac = pos - Math.floor(pos);
      // offbeat onsets (near .5 of 8th pair = every second 8th)
      const pairPos = (t / (eighth * 2)) % 1;
      if (pairPos > 0.35 && pairPos < 0.85) devs.push(frac > 0.5 ? frac - 0.5 : frac);
    }
    if (devs.length < 3) return 50;
    const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
    return Math.round(Math.max(50, Math.min(72, 50 + mean * 44)));
  }

  /**
   * Extract music essence signature from an AudioBuffer.
   * Uses Analyze (onsets/bpm/spectral) if available.
   */
  function signatureFromBuffer(buf, meta = {}) {
    const sr = buf.sampleRate;
    const mono = monoFromBuffer(buf);
    let analysis = null;
    const analyzer = global.LoopTischAnalyze || global.Analyze;
    if (analyzer?.analyzeAudioBuffer) {
      try { analysis = analyzer.analyzeAudioBuffer(buf, meta); } catch (e) { /* fall through */ }
    }
    // energy / rms
    let sum = 0;
    const step = Math.max(1, Math.floor(mono.length / 100000));
    let count = 0;
    for (let i = 0; i < mono.length; i += step) { sum += mono[i] * mono[i]; count++; }
    const rms = Math.sqrt(sum / Math.max(1, count));

    const keyInfo = chromaAndKey(mono.slice(0, Math.min(mono.length, sr * 20)), sr);
    const bpm = analysis?.bpm || 0;
    const onsets = analysis?.onsets || [];
    const onsetTimes = analysis?.onsetTimes || [];
    const duration = buf.duration;

    const sig = {
      schema: 'looptisch.music-essence/v1',
      name: meta.name || 'unnamed',
      origin: meta.origin || 'unknown', // 'reference' | 'forge' | 'import'
      license: meta.license || null,
      duration: +duration.toFixed(3),
      bpm,
      bpm_confidence: analysis?.bpmConfidence ?? 0,
      key: keyInfo.key,
      key_confidence: keyInfo.keyConfidence,
      chroma: keyInfo.chroma,
      energy: +(rms * 4).toFixed(3),
      rms: +rms.toFixed(4),
      brightness_centroid_hz: analysis?.features?.centroidHz ?? null,
      low_ratio: analysis?.features?.lowRatio ?? null,
      high_ratio: analysis?.features?.highRatio ?? null,
      onset_density: +(onsets.length / Math.max(0.1, duration)).toFixed(2),
      onsets: onsets.length,
      swing: estimateSwing(onsetTimes, bpm),
      type: analysis?.type || null,
      created: new Date().toISOString(),
      claim_ceiling: 'signature = Hypothesenbündel über Stil-Merkmale. Kein Identitätsbeweis, keine Urheber-Zuschreibung.',
    };
    return sig;
  }

  /** normalized feature vector + euclidean delta between two signatures */
  const DELTA_AXES = ['bpm', 'energy', 'onset_density', 'swing', 'low_ratio', 'high_ratio', 'brightness_centroid_hz'];
  const AXIS_NORM = { bpm: 200, energy: 2, onset_density: 20, swing: 30, low_ratio: 1, high_ratio: 1, brightness_centroid_hz: 8000 };

  function essenceDelta(a, b) {
    let sum = 0, used = 0;
    const perAxis = {};
    for (const ax of DELTA_AXES) {
      const va = a[ax], vb = b[ax];
      if (typeof va !== 'number' || typeof vb !== 'number') continue;
      const d = Math.abs(va - vb) / AXIS_NORM[ax];
      perAxis[ax] = +d.toFixed(3);
      sum += d * d; used++;
    }
    // chroma distance (key character)
    if (a.chroma && b.chroma) {
      let cd = 0;
      for (let i = 0; i < 12; i++) cd += Math.abs(a.chroma[i] - b.chroma[i]);
      perAxis.chroma = +(cd / 2).toFixed(3);
      sum += (cd / 2) ** 2; used++;
    }
    const distance = used ? Math.sqrt(sum / used) : 1;
    return {
      distance: +distance.toFixed(4),
      similarity: +Math.max(0, 1 - distance * 2).toFixed(3),
      per_axis: perAxis,
      ceiling: 'Delta = Abstand in Stil-Merkmalen, nicht Wahrheitsbeweis.',
    };
  }

  /** encode AudioBuffer → 16-bit PCM WAV Blob (for Essence-Engine POST) */
  function wavFromBuffer(buf) {
    const ch = Math.min(2, buf.numberOfChannels);
    const sr = buf.sampleRate;
    const len = buf.length;
    const bytes = 44 + len * ch * 2;
    const ab = new ArrayBuffer(bytes);
    const v = new DataView(ab);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); v.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, ch, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    wstr(36, 'data'); v.setUint32(40, len * ch * 2, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const x = Math.max(-1, Math.min(1, buf.getChannelData(c)[i]));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7FFF, true); o += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /** chunked base64 (safe for multi-MB audio, no spread/stack blowup) */
  function b64encode(ab) {
    const u8 = new Uint8Array(ab);
    const CH = 0x8000;
    let s = '';
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function b64decodeToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  global.LT_ESSENCE = { signatureFromBuffer, essenceDelta, chromaAndKey, wavFromBuffer, b64encode, b64decodeToBytes };
})(window);
