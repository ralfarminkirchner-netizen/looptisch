/**
 * LOOPTiSCH local audio analysis — onset, BPM, spectral features, type guess.
 * Pure JS, runs in browser on AudioBuffer. No network.
 */
(function (global) {
  'use strict';

  function monoFromBuffer(audioBuffer) {
    const n = audioBuffer.length;
    const ch = audioBuffer.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  function downsample(mono, sr, targetSr) {
    if (sr <= targetSr) return { data: mono, sr };
    const ratio = sr / targetSr;
    const n = Math.floor(mono.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(mono.length, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let j = start; j < end; j++) s += mono[j];
      out[i] = s / Math.max(1, end - start);
    }
    return { data: out, sr: targetSr };
  }

  /** Spectral flux + envelope peak picking */
  function detectOnsets(mono, sr, opts = {}) {
    const frame = opts.frame || 1024;
    const hop = opts.hop || 256;
    const thresholdMul = opts.thresholdMul || 1.35;
    const minInterval = opts.minIntervalSec || 0.05;

    const nFrames = Math.max(1, Math.floor((mono.length - frame) / hop));
    const flux = new Float32Array(nFrames);
    let prevMag = null;

    for (let f = 0; f < nFrames; f++) {
      const off = f * hop;
      // simple DFT magnitude on low bands (skip full FFT lib)
      const bands = 32;
      const mag = new Float32Array(bands);
      for (let b = 0; b < bands; b++) {
        let re = 0, im = 0;
        const freq = ((b + 1) / bands) * Math.PI;
        for (let i = 0; i < frame; i++) {
          const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
          const x = mono[off + i] * w;
          re += x * Math.cos(freq * i);
          im -= x * Math.sin(freq * i);
        }
        mag[b] = Math.sqrt(re * re + im * im);
      }
      if (prevMag) {
        let sum = 0;
        for (let b = 0; b < bands; b++) {
          const d = mag[b] - prevMag[b];
          if (d > 0) sum += d;
        }
        flux[f] = sum;
      }
      prevMag = mag;
    }

    // smooth
    const sm = new Float32Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
      const a = flux[Math.max(0, i - 2)] || 0;
      const b = flux[i] || 0;
      const c = flux[Math.min(nFrames - 1, i + 2)] || 0;
      sm[i] = (a + b * 2 + c) / 4;
    }

    let mean = 0;
    for (let i = 0; i < nFrames; i++) mean += sm[i];
    mean /= nFrames || 1;
    let vsum = 0;
    for (let i = 0; i < nFrames; i++) vsum += (sm[i] - mean) ** 2;
    const std = Math.sqrt(vsum / (nFrames || 1)) || 1e-6;
    const thr = mean + thresholdMul * std;

    const minHop = Math.round((minInterval * sr) / hop);
    const peaks = [];
    for (let i = 2; i < nFrames - 2; i++) {
      if (sm[i] > thr && sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1]) {
        if (!peaks.length || i - peaks[peaks.length - 1] >= minHop) peaks.push(i);
        else if (sm[i] > sm[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
      }
    }

    // Always include start if energetic
    if (!peaks.length || peaks[0] > 3) {
      let e0 = 0;
      for (let i = 0; i < Math.min(frame, mono.length); i++) e0 += mono[i] * mono[i];
      if (e0 > 1e-6) peaks.unshift(0);
    }

    const times = peaks.map((p) => (p * hop) / sr);
    const positions = times.map((t) => Math.min(0.999, t / Math.max(1e-6, mono.length / sr)));
    return { times, positions, frameFlux: sm, hop, sr };
  }

  /** BPM from onset IOI histogram + autocorrelation of flux */
  function estimateBpm(onsetTimes, durationSec, flux, hop, sr) {
    const candidates = [];

    if (onsetTimes.length >= 4) {
      const iois = [];
      for (let i = 1; i < onsetTimes.length; i++) {
        const d = onsetTimes[i] - onsetTimes[i - 1];
        if (d > 0.1 && d < 2.0) iois.push(d);
      }
      // histogram buckets
      const buckets = new Map();
      iois.forEach((d) => {
        const bpm = 60 / d;
        // fold into 70-160
        let b = bpm;
        while (b < 70) b *= 2;
        while (b > 160) b /= 2;
        const key = Math.round(b);
        buckets.set(key, (buckets.get(key) || 0) + 1);
        // also half/double neighbors soft
        buckets.set(key - 1, (buckets.get(key - 1) || 0) + 0.3);
        buckets.set(key + 1, (buckets.get(key + 1) || 0) + 0.3);
      });
      let best = 0, bestBpm = 0;
      buckets.forEach((v, k) => {
        if (k >= 70 && k <= 160 && v > best) {
          best = v;
          bestBpm = k;
        }
      });
      if (bestBpm) candidates.push({ bpm: bestBpm, score: best });
    }

    // flux autocorr
    if (flux && flux.length > 32) {
      const maxLag = Math.min(flux.length - 1, Math.floor((sr / hop) * (60 / 70)));
      const minLag = Math.max(2, Math.floor((sr / hop) * (60 / 160)));
      let bestLag = 0, bestVal = -1;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let s = 0, c = 0;
        for (let i = 0; i + lag < flux.length; i++) {
          s += flux[i] * flux[i + lag];
          c++;
        }
        const v = s / (c || 1);
        if (v > bestVal) {
          bestVal = v;
          bestLag = lag;
        }
      }
      if (bestLag) {
        const period = (bestLag * hop) / sr;
        let bpm = 60 / period;
        while (bpm < 70) bpm *= 2;
        while (bpm > 160) bpm /= 2;
        candidates.push({ bpm: Math.round(bpm), score: bestVal * 10 });
      }
    }

    // duration-based default for one-shots
    if (!candidates.length) {
      if (durationSec < 2) return { bpm: 0, confidence: 0.2, method: 'one-shot' };
      return { bpm: 120, confidence: 0.15, method: 'default' };
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];
    const conf = Math.min(0.95, 0.35 + top.score / 20);
    return { bpm: top.bpm, confidence: conf, method: 'onset+flux' };
  }

  function spectralFeatures(mono, sr) {
    // sample ~4096 centered or start
    const n = Math.min(4096, mono.length);
    const start = Math.max(0, Math.floor(mono.length * 0.05));
    let reBins = 64;
    const mags = new Float32Array(reBins);
    let total = 0;
    for (let b = 1; b < reBins; b++) {
      let re = 0, im = 0;
      const w = (2 * Math.PI * b) / reBins;
      for (let i = 0; i < n; i++) {
        const x = mono[start + i] || 0;
        re += x * Math.cos(w * i);
        im -= x * Math.sin(w * i);
      }
      const m = Math.sqrt(re * re + im * im);
      mags[b] = m;
      total += m;
    }
    let centroid = 0;
    for (let b = 1; b < reBins; b++) {
      const freq = (b / reBins) * (sr / 2);
      centroid += freq * (mags[b] / (total || 1));
    }
    // low band energy ratio
    let low = 0, high = 0;
    for (let b = 1; b < reBins; b++) {
      const freq = (b / reBins) * (sr / 2);
      if (freq < 150) low += mags[b];
      if (freq > 4000) high += mags[b];
    }
    const energy = rms(mono);
    return {
      centroidHz: centroid,
      lowRatio: low / (total || 1),
      highRatio: high / (total || 1),
      rms: energy,
      peak: peakAbs(mono),
    };
  }

  function rms(mono) {
    let s = 0;
    const step = Math.max(1, Math.floor(mono.length / 20000));
    let c = 0;
    for (let i = 0; i < mono.length; i += step) {
      s += mono[i] * mono[i];
      c++;
    }
    return Math.sqrt(s / (c || 1));
  }

  function peakAbs(mono) {
    let p = 0;
    const step = Math.max(1, Math.floor(mono.length / 50000));
    for (let i = 0; i < mono.length; i += step) {
      const a = Math.abs(mono[i]);
      if (a > p) p = a;
    }
    return p;
  }

  function guessType(durationSec, feat, bpm, onsetCount) {
    const { centroidHz, lowRatio, highRatio, rms } = feat;
    if (durationSec >= 1.8 && onsetCount >= 4) {
      if (centroidHz < 800 && lowRatio > 0.25) return { type: 'loop', tags: ['loop', 'low'], energy: clamp01(rms * 4) };
      return { type: 'loop', tags: ['loop', 'break', 'chop-me'], energy: clamp01(rms * 5) };
    }
    if (durationSec >= 1.5 && onsetCount <= 3 && centroidHz < 1200) {
      return { type: 'melodic', tags: ['pad', 'sustained'], energy: clamp01(rms * 3) };
    }
    if (durationSec < 0.55) {
      if (lowRatio > 0.35 && centroidHz < 600) return { type: 'kick', tags: ['one-shot', 'analyzed'], energy: clamp01(rms * 6) };
      if (highRatio > 0.25 && centroidHz > 3500) return { type: 'hat', tags: ['one-shot', 'analyzed'], energy: clamp01(rms * 4) };
      if (centroidHz > 1200 && centroidHz < 4500) return { type: 'snare', tags: ['one-shot', 'analyzed'], energy: clamp01(rms * 5) };
      return { type: 'perc', tags: ['one-shot', 'analyzed'], energy: clamp01(rms * 4) };
    }
    if (durationSec < 1.2 && lowRatio > 0.3) return { type: 'melodic', tags: ['bass', 'analyzed'], energy: clamp01(rms * 4) };
    if (bpm > 0) return { type: 'loop', tags: ['loop', 'analyzed'], energy: clamp01(rms * 4) };
    return { type: 'perc', tags: ['analyzed'], energy: clamp01(rms * 3) };
  }

  function clamp01(x) {
    return Math.max(0.05, Math.min(1, x));
  }

  function waveformPeaks(mono, buckets = 512) {
    const out = new Float32Array(buckets);
    const block = Math.max(1, Math.floor(mono.length / buckets));
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const start = i * block;
      const end = Math.min(mono.length, start + block);
      for (let j = start; j < end; j++) {
        const a = Math.abs(mono[j]);
        if (a > peak) peak = a;
      }
      out[i] = peak;
    }
    return out;
  }

  /**
   * Full analysis pipeline.
   * @param {AudioBuffer} audioBuffer
   * @param {{name?: string}} meta
   */
  function analyzeAudioBuffer(audioBuffer, meta = {}) {
    const sr0 = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;
    const monoFull = monoFromBuffer(audioBuffer);
    const { data: mono, sr } = downsample(monoFull, sr0, 22050);

    const onset = detectOnsets(mono, sr, {
      thresholdMul: duration > 2 ? 1.25 : 1.5,
      minIntervalSec: duration > 4 ? 0.07 : 0.04,
    });

    // Limit chops for UI
    let positions = onset.positions;
    let times = onset.times;
    if (positions.length > 32) {
      // keep strongest by sampling evenly
      const step = positions.length / 32;
      const np = [], nt = [];
      for (let i = 0; i < 32; i++) {
        const idx = Math.floor(i * step);
        np.push(positions[idx]);
        nt.push(times[idx]);
      }
      positions = np;
      times = nt;
    }

    const bpmInfo = estimateBpm(times, duration, onset.frameFlux, onset.hop, sr);
    const feat = spectralFeatures(mono, sr);
    const guess = guessType(duration, feat, bpmInfo.bpm, times.length);
    const peaks = waveformPeaks(monoFull, 600);

    // one-shots: bpm 0
    const bpm = duration < 1.5 && times.length < 4 ? 0 : bpmInfo.bpm;

    const tags = [...guess.tags];
    if (bpm) tags.push(bpm + 'bpm');
    if (feat.centroidHz > 3000) tags.push('bright');
    if (feat.lowRatio > 0.3) tags.push('dark');
    if (meta.name) {
      const ln = meta.name.toLowerCase();
      if (/kick|bd|bassdrum/.test(ln)) {
        guess.type = 'kick';
      } else if (/snare|sd|clap/.test(ln)) {
        guess.type = 'snare';
      } else if (/hat|hh|hi-hat|hihat/.test(ln)) {
        guess.type = 'hat';
      } else if (/break|loop|drum/.test(ln) && duration > 1) {
        guess.type = 'loop';
        if (!tags.includes('break')) tags.push('break', 'chop-me');
      }
    }

    return {
      duration,
      sampleRate: sr0,
      bpm,
      bpmConfidence: bpmInfo.confidence,
      bpmMethod: bpmInfo.method,
      key: '—',
      type: guess.type,
      tags: unique(tags),
      energy: guess.energy,
      onsets: positions,
      onsetTimes: times,
      features: {
        centroidHz: Math.round(feat.centroidHz),
        lowRatio: +feat.lowRatio.toFixed(3),
        highRatio: +feat.highRatio.toFixed(3),
        rms: +feat.rms.toFixed(4),
        peak: +feat.peak.toFixed(4),
      },
      waveform: peaks,
    };
  }

  function unique(arr) {
    return [...new Set(arr.filter(Boolean))];
  }

  /**
   * Slice AudioBuffer by normalized start/end [0,1]
   */
  function sliceBuffer(ctx, audioBuffer, startN, endN) {
    const start = Math.floor(Math.max(0, startN) * audioBuffer.length);
    const end = Math.floor(Math.min(1, endN) * audioBuffer.length);
    const len = Math.max(1, end - start);
    const out = ctx.createBuffer(audioBuffer.numberOfChannels, len, audioBuffer.sampleRate);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const src = audioBuffer.getChannelData(c).subarray(start, start + len);
      out.copyToChannel(src, c);
    }
    return out;
  }

  global.LoopTischAnalyze = {
    analyzeAudioBuffer,
    detectOnsets,
    estimateBpm,
    monoFromBuffer,
    waveformPeaks,
    sliceBuffer,
  };
})(window);
