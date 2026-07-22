/**
 * LOOPTiSCH FX Rack — 15 native Web Audio effects, zero dependencies.
 * Serial chain: input → [slot dry/wet crossfade]… → output.
 * Each slot: build(ctx) → { in, out, macro(a01) } — the wet path.
 */
(function (global) {
  'use strict';

  function makeIR(ctx, seconds, decay, bright = 1) {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.round(sr * seconds));
    const buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        let n = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        lp += bright * (n - lp); // damped top end
        d[i] = lp * (c ? 0.96 : 1);
      }
    }
    return buf;
  }

  function lfo(ctx, rate, depth) {
    const osc = ctx.createOscillator();
    osc.frequency.value = rate;
    const g = ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    osc.start();
    return { osc, out: g };
  }

  const DEFS = [
    {
      id: 'filter', name: 'MOOG LP', def: 0.55,
      build(ctx) {
        const pre = ctx.createGain(); pre.gain.value = 1.4;
        const f1 = ctx.createBiquadFilter(); f1.type = 'lowpass'; f1.Q.value = 9;
        const f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.Q.value = 4;
        const out = ctx.createGain();
        pre.connect(f1); f1.connect(f2); f2.connect(out);
        return { in: pre, out, macro(a) { const f = 120 * Math.pow(50, a); f1.frequency.value = f; f2.frequency.value = f * 1.01; } };
      },
    },
    {
      id: 'overdrive', name: 'OVERDRIVE', def: 0.4,
      build(ctx) {
        const sh = ctx.createWaveShaper(); sh.oversample = '4x';
        const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 5200;
        const out = ctx.createGain(); out.gain.value = 0.9;
        sh.connect(tone); tone.connect(out);
        const set = (a) => {
          const k = 1 + a * 80, n = 1024, c = new Float32Array(n);
          for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
          sh.curve = c;
        };
        set(0.4);
        return { in: sh, out, macro: set };
      },
    },
    {
      id: 'lofi', name: 'LOFI·CRUSH', def: 0.5,
      build(ctx) {
        const sh = ctx.createWaveShaper();
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
        const out = ctx.createGain();
        sh.connect(lp); lp.connect(out);
        const set = (a) => {
          const bits = Math.max(2, Math.round(9 - a * 7));
          const steps = Math.pow(2, bits), n = 1024, c = new Float32Array(n);
          for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.round(x * steps) / steps; }
          sh.curve = c;
          lp.frequency.value = 9000 - a * 6800;
        };
        set(0.5);
        return { in: sh, out, macro: set };
      },
    },
    {
      id: 'chorus', name: 'CHORUS', def: 0.5,
      build(ctx) {
        const inp = ctx.createGain(), out = ctx.createGain();
        const mk = (base, rate, depth) => {
          const d = ctx.createDelay(0.06); d.delayTime.value = base;
          const l = lfo(ctx, rate, depth); l.out.connect(d.delayTime);
          const g = ctx.createGain(); g.gain.value = 0.7;
          inp.connect(d); d.connect(g); g.connect(out);
          return l;
        };
        const l1 = mk(0.017, 0.8, 0.0032);
        const l2 = mk(0.023, 0.63, 0.0041);
        inp.connect(out); // dry thru inside wet path keeps body
        return { in: inp, out, macro(a) { l1.osc.frequency.value = 0.3 + a * 1.6; l2.osc.frequency.value = 0.25 + a * 1.3; } };
      },
    },
    {
      id: 'phaser', name: 'PHASER', def: 0.5,
      build(ctx) {
        const inp = ctx.createGain(), out = ctx.createGain();
        const stages = [];
        let node = inp;
        for (let i = 0; i < 4; i++) {
          const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.Q.value = 7;
          node.connect(ap); node = ap; stages.push(ap);
        }
        node.connect(out);
        inp.connect(out);
        const l = lfo(ctx, 0.5, 500);
        stages.forEach((ap) => l.out.connect(ap.frequency));
        const set = (a) => {
          const base = 300 + a * 1300;
          stages.forEach((ap, i) => ap.frequency.value = base * (1 + i * 0.5));
          l.osc.frequency.value = 0.15 + a * 2.2;
          l.out.gain.value = base * 0.8;
        };
        set(0.5);
        return { in: inp, out, macro: set };
      },
    },
    {
      id: 'flanger', name: 'FLANGER', def: 0.5,
      build(ctx) {
        const inp = ctx.createGain(), out = ctx.createGain();
        const d = ctx.createDelay(0.03); d.delayTime.value = 0.005;
        const fb = ctx.createGain(); fb.gain.value = 0.55;
        const l = lfo(ctx, 0.4, 0.0028);
        l.out.connect(d.delayTime);
        inp.connect(d); d.connect(fb); fb.connect(d);
        d.connect(out); inp.connect(out);
        return { in: inp, out, macro(a) { l.osc.frequency.value = 0.1 + a * 1.8; fb.gain.value = 0.2 + a * 0.6; } };
      },
    },
    {
      id: 'tremolo', name: 'TREMOLO', def: 0.5,
      build(ctx) {
        const g = ctx.createGain();
        const depth = ctx.createGain(); depth.gain.value = 0.5;
        const l = lfo(ctx, 5, 1); l.out.connect(depth); depth.connect(g.gain);
        const dc = ctx.createConstantSource(); dc.offset.value = 0.5; dc.connect(g.gain); dc.start();
        return { in: g, out: g, macro(a) { l.osc.frequency.value = 1 + a * 13; depth.gain.value = 0.15 + a * 0.35; dc.offset.value = 1 - (0.15 + a * 0.35); } };
      },
    },
    {
      id: 'gate', name: 'TRANCE GATE', def: 0.5,
      build(ctx) {
        const g = ctx.createGain(); g.gain.value = 1;
        const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = 8;
        const depth = ctx.createGain(); depth.gain.value = 0.5;
        const dc = ctx.createConstantSource(); dc.offset.value = 0.5;
        osc.connect(depth); depth.connect(g.gain); dc.connect(g.gain);
        osc.start(); dc.start();
        return { in: g, out: g, macro(a) { osc.frequency.value = 2 + a * 14; } };
      },
    },
    {
      id: 'autowah', name: 'AUTO-WAH', def: 0.55,
      build(ctx) {
        const inp = ctx.createGain(), out = ctx.createGain();
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 8; bp.frequency.value = 500;
        // envelope follower: rectify → smooth → scale → filter freq
        const rect = ctx.createWaveShaper();
        { const n = 256, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.abs((i * 2) / n - 1); rect.curve = c; }
        const sm = ctx.createBiquadFilter(); sm.type = 'lowpass'; sm.frequency.value = 9;
        const envG = ctx.createGain(); envG.gain.value = 2600;
        inp.connect(bp); bp.connect(out);
        inp.connect(rect); rect.connect(sm); sm.connect(envG); envG.connect(bp.frequency);
        return { in: inp, out, macro(a) { bp.Q.value = 4 + a * 10; envG.gain.value = 800 + a * 4200; } };
      },
    },
    {
      id: 'ringmod', name: 'RING MOD', def: 0.35,
      build(ctx) {
        const g = ctx.createGain(); g.gain.value = 0;
        const osc = ctx.createOscillator(); osc.frequency.value = 42;
        const dc = ctx.createConstantSource(); dc.offset.value = 0.5;
        const og = ctx.createGain(); og.gain.value = 0.5;
        osc.connect(og); og.connect(g.gain); dc.connect(g.gain);
        osc.start(); dc.start();
        return { in: g, out: g, macro(a) { osc.frequency.value = 12 + a * 260; } };
      },
    },
    {
      id: 'vibrato', name: 'VIBRATO', def: 0.5,
      build(ctx) {
        const d = ctx.createDelay(0.03); d.delayTime.value = 0.006;
        const l = lfo(ctx, 5.5, 0.0025);
        l.out.connect(d.delayTime);
        return { in: d, out: d, macro(a) { l.osc.frequency.value = 2 + a * 8; l.out.gain.value = 0.0008 + a * 0.005; } };
      },
    },
    {
      id: 'delay', name: 'ECHO', def: 0.45,
      build(ctx) {
        const inp = ctx.createGain(), out = ctx.createGain();
        const d = ctx.createDelay(2); d.delayTime.value = 0.32;
        const fb = ctx.createGain(); fb.gain.value = 0.38;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
        const dR = ctx.createDelay(2); dR.delayTime.value = 0.48;
        const fbR = ctx.createGain(); fbR.gain.value = 0.3;
        const merge = ctx.createChannelMerger(2);
        inp.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d);
        lp.connect(dR); dR.connect(fbR); fbR.connect(d);
        lp.connect(merge, 0, 0); dR.connect(merge, 0, 1);
        merge.connect(out);
        return { in: inp, out, macro(a) { fb.gain.value = 0.15 + a * 0.55; fbR.gain.value = 0.1 + a * 0.45; } };
      },
    },
    {
      id: 'reverb', name: 'HALL', def: 0.4,
      build(ctx) {
        const cv = ctx.createConvolver();
        cv.buffer = makeIR(ctx, 2.6, 2.6, 0.28);
        const pre = ctx.createBiquadFilter(); pre.type = 'highpass'; pre.frequency.value = 160;
        pre.connect(cv);
        return { in: pre, out: cv, macro() { /* fixed tail; wet knob carries it */ } };
      },
    },
    {
      id: 'cabinet', name: 'CABINET', def: 0.5,
      build(ctx) {
        const cv = ctx.createConvolver();
        cv.buffer = makeIR(ctx, 0.09, 4.5, 0.65);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4600;
        cv.connect(lp);
        return { in: cv, out: lp, macro(a) { lp.frequency.value = 3000 + a * 4000; } };
      },
    },
    {
      id: 'widener', name: 'STEREO+', def: 0.4,
      build(ctx) {
        const inp = ctx.createGain(), out = ctx.createGain();
        // M/S matrix: M = (L+R)/2, S = (L-R)/2 → widen by boosting S
        const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
        const toM0 = ctx.createGain(); toM0.gain.value = 0.5;
        const toM1 = ctx.createGain(); toM1.gain.value = 0.5;
        const toS0 = ctx.createGain(); toS0.gain.value = 0.5;
        const toS1 = ctx.createGain(); toS1.gain.value = -0.5;
        const M = ctx.createGain(), S = ctx.createGain();
        const sBoost = ctx.createGain(); sBoost.gain.value = 1.6;
        inp.connect(sp);
        sp.connect(toM0, 0); sp.connect(toM1, 1); toM0.connect(M); toM1.connect(M);
        sp.connect(toS0, 0); sp.connect(toS1, 1); toS0.connect(S); toS1.connect(S);
        S.connect(sBoost);
        const outL = ctx.createGain(), outR = ctx.createGain();
        M.connect(outL); sBoost.connect(outL);
        M.connect(outR);
        const sInv = ctx.createGain(); sInv.gain.value = -1;
        sBoost.connect(sInv); sInv.connect(outR);
        outL.connect(mg, 0, 0); outR.connect(mg, 0, 1);
        mg.connect(out);
        return { in: inp, out, macro(a) { sBoost.gain.value = 0.6 + a * 2.4; } };
      },
    },
    {
      id: 'exciter', name: 'EXCITER', def: 0.35,
      build(ctx) {
        const inp = ctx.createGain(), out = ctx.createGain();
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000;
        const sh = ctx.createWaveShaper();
        { const n = 512, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.tanh(3 * x); } sh.curve = c; }
        const g = ctx.createGain(); g.gain.value = 0.25;
        inp.connect(out);
        inp.connect(hp); hp.connect(sh); sh.connect(g); g.connect(out);
        return { in: inp, out, macro(a) { g.gain.value = a * 0.6; hp.frequency.value = 7000 - a * 3000; } };
      },
    },
  ];

  const FX_CATS = {
    filter: 'tone', overdrive: 'drive', lofi: 'drive', cabinet: 'drive', exciter: 'drive',
    chorus: 'mod', phaser: 'mod', flanger: 'mod', tremolo: 'mod', gate: 'mod', autowah: 'mod', ringmod: 'mod', vibrato: 'mod',
    delay: 'space', reverb: 'space', widener: 'space',
  };
  DEFS.forEach((d) => { d.cat = FX_CATS[d.id] || 'misc'; });

  class FXRack {
    constructor(ctx) {
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.output = ctx.createGain();
      this.slots = DEFS.map((def) => {
        const fx = def.build(ctx);
        const dry = ctx.createGain(); dry.gain.value = 1;
        const wet = ctx.createGain(); wet.gain.value = 0;
        const sum = ctx.createGain();
        const slotIn = ctx.createGain();
        slotIn.connect(dry); dry.connect(sum);
        slotIn.connect(fx.in); fx.out.connect(wet); wet.connect(sum);
        return { id: def.id, name: def.name, cat: def.cat, fx, dry, wet, in: slotIn, out: sum, enabled: false, amount: def.def };
      });
      // serial chain
      let prev = this.input;
      this.slots.forEach((s) => { prev.connect(s.in); prev = s.out; });
      prev.connect(this.output);
      this.slots.forEach((s) => { if (s.fx.macro) s.fx.macro(s.amount); });
    }
    setEnabled(id, on) {
      const s = this.slots.find((x) => x.id === id);
      if (!s) return;
      s.enabled = !!on;
      const t = this.ctx.currentTime;
      s.wet.gain.setTargetAtTime(on ? s.amount : 0, t, 0.03);
      s.dry.gain.setTargetAtTime(on ? 1 - s.amount * 0.5 : 1, t, 0.03);
    }
    setAmount(id, a) {
      const s = this.slots.find((x) => x.id === id);
      if (!s) return;
      s.amount = Math.max(0, Math.min(1, a));
      if (s.fx.macro) s.fx.macro(s.amount);
      if (s.enabled) {
        const t = this.ctx.currentTime;
        s.wet.gain.setTargetAtTime(s.amount, t, 0.03);
        s.dry.gain.setTargetAtTime(1 - s.amount * 0.5, t, 0.03);
      }
    }
    state() { return this.slots.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled, amount: s.amount })); }
  }

  global.LT_FX = { createRack: (ctx) => new FXRack(ctx), DEFS };
})(window);
