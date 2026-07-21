/**
 * LOOPTiSCH Master Suite — zero-dependency "AI-style" mix & master assist.
 * - K-weighted loudness metering (EBU R128-approx: shelf + highpass, LUFS readout)
 * - AUTO MASTER: 3-band multiband compression + adaptive gain to target loudness
 * - AUTO MIX: role-based gain staging per pad (kick/snare/hat/…) from buffer RMS
 */
(function (global) {
  'use strict';

  class MasterSuite {
    constructor(ctx) {
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.output = ctx.createGain();
      this.enabled = false;
      this.target = -14;

      // ---- multiband: low <150, mid 150–2600, high >2600 ----
      const mk = (filterFn, thr, ratio, atk, rel) => {
        const g = ctx.createGain();
        const last = filterFn(g);
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = thr; comp.ratio.value = ratio;
        comp.knee.value = 8; comp.attack.value = atk; comp.release.value = rel;
        last.connect(comp);
        return { in: g, out: comp, comp };
      };
      this.bands = [
        mk((g) => { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 150; g.connect(f); return f; }, -17, 3.0, 0.004, 0.16),
        mk((g) => { const f1 = ctx.createBiquadFilter(); f1.type = 'highpass'; f1.frequency.value = 150; const f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = 2600; g.connect(f1); f1.connect(f2); return f2; }, -20, 2.2, 0.006, 0.12),
        mk((g) => { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2600; g.connect(f); return f; }, -23, 1.8, 0.003, 0.09),
      ];
      this.mbSum = ctx.createGain();
      this.bands.forEach((b) => { this.input.connect(b.in); b.out.connect(this.mbSum); });
      this.mbSum.connect(this.output);

      // bypass path (mastering off = straight through)
      this.direct = ctx.createGain(); this.direct.gain.value = 1;
      this.input.connect(this.direct); this.direct.connect(this.output);
      this.mbSum.gain.value = 0;

      // ---- K-weighted metering tap ----
      this.kShelf = ctx.createBiquadFilter(); this.kShelf.type = 'highshelf';
      this.kShelf.frequency.value = 1500; this.kShelf.gain.value = 4;
      this.kHp = ctx.createBiquadFilter(); this.kHp.type = 'highpass';
      this.kHp.frequency.value = 38; this.kHp.Q.value = 0.5;
      this.kAnalyser = ctx.createAnalyser(); this.kAnalyser.fftSize = 2048;
      this.input.connect(this.kShelf); this.kShelf.connect(this.kHp); this.kHp.connect(this.kAnalyser);
      this._kBuf = new Float32Array(this.kAnalyser.fftSize);
      this.lufs = -70;
      this._lufsHist = [];
      this._adaptTimer = null;
      this.onMeter = null;
      this._meterLoop();
    }

    _meterLoop() {
      const step = () => {
        this.kAnalyser.getFloatTimeDomainData(this._kBuf);
        let sum = 0;
        for (let i = 0; i < this._kBuf.length; i++) sum += this._kBuf[i] * this._kBuf[i];
        const ms = sum / this._kBuf.length;
        const momentary = ms > 1e-10 ? -0.691 + 10 * Math.log10(ms) : -70;
        this._lufsHist.push(momentary);
        if (this._lufsHist.length > 40) this._lufsHist.shift();
        const gated = this._lufsHist.filter((v) => v > -65);
        this.lufs = gated.length ? gated.reduce((a, b) => a + b, 0) / gated.length : -70;
        if (this.onMeter) this.onMeter(this.lufs);
        requestAnimationFrame(step);
      };
      step();
    }

    setEnabled(on, engine) {
      this.enabled = !!on;
      const t = this.ctx.currentTime;
      this.mbSum.gain.setTargetAtTime(on ? 1 : 0, t, 0.05);
      this.direct.gain.setTargetAtTime(on ? 0 : 1, t, 0.05);
      clearInterval(this._adaptTimer);
      if (on && engine) {
        this._adaptTimer = setInterval(() => {
          if (this.lufs < -60) return; // silence: nothing to adapt to
          const errDb = this.target - this.lufs;
          const cur = engine.masterVol;
          const next = Math.max(0.05, Math.min(1.0, cur * Math.pow(10, (errDb * 0.35) / 20)));
          if (Math.abs(next - cur) > 0.005) engine.setMasterVol(next);
        }, 1500);
      }
    }

    setTarget(lufs) { this.target = lufs; }
  }

  /** AUTO MIX — role-based gain staging from decoded buffer RMS */
  const ROLE_TARGET_RMS = {
    kick: 0.30, snare: 0.24, hat: 0.10, perc: 0.13, melodic: 0.16, loop: 0.20,
  };

  function bufferRMS(buf) {
    const d = buf.getChannelData(0);
    let sum = 0;
    const n = Math.min(d.length, 44100 * 4);
    const step = Math.max(1, Math.floor(d.length / n));
    let count = 0;
    for (let i = 0; i < d.length; i += step) { sum += d[i] * d[i]; count++; }
    return Math.sqrt(sum / Math.max(1, count));
  }

  function autoMix(project, engine, log) {
    const results = [];
    project.pads.forEach((s, i) => {
      if (!s || project.muted[i]) return;
      const target = ROLE_TARGET_RMS[s.type] ?? 0.15;
      let rms = null;
      const buf = s.bufferId ? engine.getBuffer(s.bufferId) : null;
      if (buf) rms = bufferRMS(buf);
      else if (typeof s.energy === 'number') rms = 0.35 * s.energy; // procedural voices
      if (!rms || rms < 1e-4) return;
      const level = Math.max(0.08, Math.min(1, (target / rms) * 0.35));
      project.set_level(i, +level.toFixed(2));
      results.push({ pad: i, name: s.name, level: +level.toFixed(2) });
    });
    if (log) results.forEach((r) => log(`mix · pad ${r.pad + 1} ${r.name} → ${Math.round(r.level * 100)}%`));
    return results;
  }

  global.LT_MASTER = { create: (ctx) => new MasterSuite(ctx), autoMix };
})(window);
