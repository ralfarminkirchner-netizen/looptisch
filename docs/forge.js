/**
 * LOOPTiSCH Style Forge — license-free original-track generator.
 * Procedural, seeded composition rendered offline (OfflineAudioContext).
 * Style input: music essence signature (LT_ESSENCE) or preset.
 *
 * License note (honest): output is 100% procedurally synthesized from a seed.
 * No copied audio, no trained-on-recordings model. User owns the render.
 * "Original style" = matches measurable signature axes (bpm/key/energy/
 * swing/brightness), NOT imitation of an identifiable artist's recording.
 */
(function (global) {
  'use strict';

  // seeded RNG
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const NOTE_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10];
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function parseKey(key) {
    const m = String(key || 'Am').match(/^([A-G][#b]?)(m)?/);
    return { root: NOTE_PC[m ? m[1] : 'A'] ?? 9, minor: !!(m && m[2]) };
  }

  // ——— mini voices (offline ctx) ———
  function kick(ctx, out, t, vel) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.11);
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.36);
    const c = ctx.createOscillator(), cg = ctx.createGain(); // click
    c.type = 'square'; c.frequency.value = 1500;
    cg.gain.setValueAtTime(vel * 0.25, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
    c.connect(cg); cg.connect(out); c.start(t); c.stop(t + 0.02);
  }

  function snare(ctx, out, t, vel, noiseBuf) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
    n.connect(bp); bp.connect(g); g.connect(out);
    n.start(t); n.stop(t + 0.2);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.value = 190;
    og.gain.setValueAtTime(vel * 0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.1);
  }

  function hat(ctx, out, t, vel, noiseBuf, open) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7800;
    const g = ctx.createGain();
    const dur = open ? 0.24 : 0.045;
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(hp); hp.connect(g); g.connect(out);
    n.start(t); n.stop(t + dur + 0.01);
  }

  function bassNote(ctx, out, t, hz, dur, vel, bright) {
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = hz;
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = hz / 2;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = 300 + bright * 1800; lp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.008);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.7, 0.05);
    const g2 = ctx.createGain(); g2.gain.value = 0.4;
    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(out);
    o1.start(t); o1.stop(t + dur + 0.3); o2.start(t); o2.stop(t + dur + 0.3);
  }

  function chordStab(ctx, out, t, midis, dur, vel, bright) {
    for (const m of midis) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = midiHz(m);
      o.detune.value = (Math.random() - 0.5) * 14;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.value = 600 + bright * 3600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel / midis.length, t + 0.012);
      g.gain.setTargetAtTime(0.0001, t + dur * 0.6, 0.07);
      o.connect(lp); lp.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur + 0.5);
    }
  }

  function arpNote(ctx, out, t, hz, vel) {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    const d = ctx.createDelay(0.5); d.delayTime.value = 0.19;
    const dg = ctx.createGain(); dg.gain.value = 0.3;
    o.connect(g); g.connect(out);
    g.connect(d); d.connect(dg); dg.connect(out);
    o.start(t); o.stop(t + 0.18);
  }

  /**
   * Compose + render an original 16-bar track from an essence-ish style.
   * style: { bpm, key, energy 0..1, swing 50..72, brightness 0..1, seed }
   * Returns { buffer, meta } — meta has the actual seed for reproducibility.
   */
  async function forge(style = {}) {
    const seed = style.seed ?? ((Math.random() * 1e9) | 0);
    const rnd = mulberry32(seed);
    const bpm = Math.max(70, Math.min(160, style.bpm || 92));
    const { root, minor } = parseKey(style.key || 'Am');
    const scale = minor ? SCALE_MINOR : SCALE_MAJOR;
    const energy = style.energy ?? 0.6;
    const swing = style.swing ?? 54;
    const bright = style.brightness ?? 0.5;

    const bars = 16;
    const sr = 44100;
    const beatSec = 60 / bpm;
    const barSec = beatSec * 4;
    const dur = bars * barSec + 1;
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const out = ctx.createGain(); out.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3;
    out.connect(comp); comp.connect(ctx.destination);

    // shared noise
    const noiseBuf = ctx.createBuffer(1, sr, sr);
    { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }

    const swingOff = (step) => (step % 2 === 1 ? (swing - 50) / 100 * beatSec : 0);
    const t16 = (bar, step) => bar * barSec + step * beatSec / 4 + swingOff(step);

    // chord progression: i–VI–III–VII (minor) / I–V–vi–IV (major), 1 chord per bar
    const progs = minor ? [[0, 5, 2, 6], [0, 3, 5, 4], [0, 5, 3, 6]] : [[0, 4, 5, 3], [0, 5, 3, 4]];
    const prog = progs[Math.floor(rnd() * progs.length)];
    const chordAt = (bar) => {
      const deg = prog[bar % 4];
      const base = 48 + root + scale[deg % scale.length];
      return [base, base + (minor ? 3 : 4), base + 7];
    };
    const rootAt = (bar) => 36 + root + scale[prog[bar % 4] % scale.length];

    for (let bar = 0; bar < bars; bar++) {
      const fill = bar % 4 === 3 && rnd() < energy;
      const breakdown = bar === 11 && energy > 0.45;
      // drums
      for (let s = 0; s < 16; s++) {
        const t = t16(bar, s);
        const four = s % 4 === 0;
        // kick: 4-floor if high energy, broken else
        if (!breakdown && (four || (energy > 0.5 && (s === 6 || s === 14) && rnd() < energy) || (fill && s >= 12 && s % 2 === 0))) {
          kick(ctx, out, t, 0.75 + rnd() * 0.2);
        }
        // snare backbeat
        if (!breakdown && (s === 4 || s === 12 || (fill && s >= 14))) snare(ctx, out, t, 0.5 + rnd() * 0.25, noiseBuf);
        // hats: 8ths, 16ths at high energy
        const hatEvery = energy > 0.65 ? 1 : 2;
        if (s % hatEvery === 0 && rnd() < 0.92) {
          const open = s === 14 && rnd() < 0.4;
          hat(ctx, out, t, (four ? 0.32 : 0.18) + rnd() * 0.12, noiseBuf, open && !breakdown);
        }
      }
      // bass: root pattern with octave + syncopation
      const bassPat = energy > 0.55 ? [0, 3, 6, 7, 10, 12, 14] : [0, 7, 12];
      for (const s of bassPat) {
        if (rnd() < 0.28) continue;
        const oct = rnd() < 0.25 ? 12 : 0;
        bassNote(ctx, out, t16(bar, s), midiHz(rootAt(bar) + oct), beatSec * 0.4, 0.5, bright);
      }
      // chords: stab on 1 (+ on 2.5 at high energy)
      chordStab(ctx, out, t16(bar, 0), chordAt(bar), beatSec * (breakdown ? 3.5 : 0.9), breakdown ? 0.35 : 0.3, bright);
      if (energy > 0.6 && rnd() < 0.7) chordStab(ctx, out, t16(bar, 10), chordAt(bar), beatSec * 0.35, 0.22, bright);
      // arp: sparse at low energy, 8ths at high
      if (bar >= 4 && rnd() < 0.3 + energy * 0.6) {
        const tones = chordAt(bar).map((m) => m + 12);
        const arpSteps = energy > 0.6 ? [0, 2, 4, 6, 8, 10, 12, 14] : [0, 4, 8, 12];
        arpSteps.forEach((s, i) => {
          if (rnd() < 0.75) arpNote(ctx, out, t16(bar, s), midiHz(tones[(i + bar) % 3] + (rnd() < 0.2 ? 12 : 0)), 0.16 + energy * 0.12);
        });
      }
    }

    const rendered = await ctx.startRendering();
    // post-normalize: never clip, honest level
    let peak = 0;
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const d = rendered.getChannelData(c);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    let buffer = rendered;
    if (peak > 0.98) {
      const g = 0.95 / peak;
      const norm = new OfflineAudioContext(rendered.numberOfChannels, rendered.length, sr);
      const src = norm.createBufferSource(); src.buffer = rendered;
      const ng = norm.createGain(); ng.gain.value = g;
      src.connect(ng); ng.connect(norm.destination); src.start();
      buffer = await norm.startRendering();
    }
    return {
      buffer,
      meta: {
        seed, bpm, key: style.key || 'Am', energy, swing, brightness: bright,
        bars, license: 'procedural-original · seed-owned · keine Samples Dritter',
        origin: 'forge',
      },
    };
  }

  const PRESETS = {
    'dusty-boombap': { bpm: 88, key: 'Am', energy: 0.5, swing: 62, brightness: 0.3 },
    'deep-house': { bpm: 122, key: 'Cm', energy: 0.65, swing: 54, brightness: 0.5 },
    'club-drive': { bpm: 128, key: 'Fm', energy: 0.85, swing: 50, brightness: 0.6 },
    'lofi-drift': { bpm: 76, key: 'Em', energy: 0.35, swing: 60, brightness: 0.25 },
    'break-fuel': { bpm: 138, key: 'Dm', energy: 0.9, swing: 52, brightness: 0.7 },
  };

  /* ================= SAMPLE-BASED FORGE (v2) =================
   * Renders with REAL library samples (MPC-style rate pitching).
   * This is the honest big sound upgrade: no toy synths when real
   * one-shots exist. Falls back to synth only if nothing loads.
   */

  async function loadBufferFor(engine, s) {
    if (!s) return null;
    const id = s.bufferId || s.id;
    const cached = engine.getBuffer(id);
    if (cached) return cached;
    if (s.url) {
      try { return await engine.loadUrl(id, s.url); } catch { return null; }
    }
    return null;
  }

  function midiOfBuffer(buffer, sr) {
    try {
      const ch = buffer.getChannelData(0);
      const mid = ch.subarray(Math.floor(ch.length * 0.1), Math.floor(ch.length * 0.1) + 4096);
      const f0 = global.LT_DSP?.detectPitch(mid, sr);
      if (f0 && f0 > 30 && f0 < 1200) return 69 + 12 * Math.log2(f0 / 440);
    } catch { /* ignore */ }
    return null;
  }

  /** pick a seeded kit of real samples from the library */
  async function pickKit(engine, project, rnd) {
    const lib = project.library.filter((s) => s.real);
    const byType = (t) => lib.filter((s) => s.type === t);
    const pick = (arr) => (arr.length ? arr[(rnd() * arr.length) | 0] : null);
    const roles = {
      kick: pick(byType('kick')),
      snare: pick(byType('snare')),
      hat: pick(byType('hat')),
      perc: pick(byType('perc')),
      bassSrc: pick(byType('melodic')),
      chordSrc: pick(byType('melodic')),
      texture: pick(byType('loop').filter((s) => s.bpm > 60)),
    };
    const out = {};
    for (const [role, s] of Object.entries(roles)) {
      const buf = await loadBufferFor(engine, s);
      if (buf) out[role] = { sample: s, buffer: buf };
    }
    return Object.keys(out).length >= 3 ? out : null;
  }

  function hit(ctx, out, buffer, t, vel, rate = 1, maxDur = 0, lpHz = 0) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    let node = src;
    if (lpHz) {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lpHz;
      src.connect(lp); node = lp;
    }
    node.connect(g); g.connect(out);
    const dur = maxDur || Math.min(buffer.duration / rate, 1.2);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.85, 0.04);
    src.start(t); src.stop(t + dur + 0.3);
  }

  /**
   * Sample-based forge: real one-shots arranged by the same composer brain.
   * Returns { buffer, meta } like synth forge, meta.kit names the samples used.
   */
  async function forgeSampled(style = {}, { project, engine } = {}) {
    if (!project || !engine) throw new Error('forgeSampled needs project+engine');
    engine.ensure();
    const seed = style.seed ?? ((Math.random() * 1e9) | 0);
    const rnd = mulberry32(seed);
    const kit = await pickKit(engine, project, rnd);
    if (!kit || !kit.kick) {
      const r = await forge(style); // synth fallback, honest
      r.meta.kit = { fallback: 'synth (keine echten Samples ladbar)' };
      return r;
    }

    const bpm = Math.max(70, Math.min(160, style.bpm || 92));
    const { root, minor } = parseKey(style.key || 'Am');
    const scale = minor ? SCALE_MINOR : SCALE_MAJOR;
    const energy = style.energy ?? 0.6;
    const swing = style.swing ?? 54;
    const bright = style.brightness ?? 0.5;
    const sr = 44100;

    // pitch anchors for melodic roles
    const bassMidi = kit.bassSrc ? (midiOfBuffer(kit.bassSrc.buffer, kit.bassSrc.buffer.sampleRate) ?? 45) : 45;
    const chordMidi = kit.chordSrc ? (midiOfBuffer(kit.chordSrc.buffer, kit.chordSrc.buffer.sampleRate) ?? 60) : 60;
    const rateTo = (srcMidi, targetMidi) => Math.pow(2, (targetMidi - srcMidi) / 12);

    const bars = 16;
    const beatSec = 60 / bpm, barSec = beatSec * 4;
    const dur = bars * barSec + 1;
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const out = ctx.createGain(); out.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 3; comp.knee.value = 10;
    out.connect(comp); comp.connect(ctx.destination);

    const swingOff = (step) => (step % 2 === 1 ? (swing - 50) / 100 * beatSec : 0);
    const t16 = (bar, step) => bar * barSec + step * beatSec / 4 + swingOff(step);
    const progs = minor ? [[0, 5, 2, 6], [0, 3, 5, 4], [0, 5, 3, 6]] : [[0, 4, 5, 3], [0, 5, 3, 4]];
    const prog = progs[(rnd() * progs.length) | 0];
    const rootAt = (bar) => 36 + root + scale[prog[bar % 4] % scale.length];
    const chordTones = (bar) => {
      const b = 48 + root + scale[prog[bar % 4] % scale.length];
      return [b, b + (minor ? 3 : 4), b + 7];
    };

    // texture layer: real loop, rate-matched, quiet
    if (kit.texture && kit.texture.sample.bpm) {
      const t = kit.texture;
      const rate = bpm / t.sample.bpm;
      const src = ctx.createBufferSource();
      src.buffer = t.buffer; src.loop = true; src.playbackRate.value = rate;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200 + bright * 4000;
      const g = ctx.createGain(); g.gain.value = 0.14 + energy * 0.06;
      src.connect(lp); lp.connect(g); g.connect(out);
      src.start(0); src.stop(dur - 0.5);
    }

    for (let bar = 0; bar < bars; bar++) {
      const fill = bar % 4 === 3 && rnd() < energy;
      const breakdown = bar === 11 && energy > 0.45;
      for (let s = 0; s < 16; s++) {
        const t = t16(bar, s);
        const four = s % 4 === 0;
        if (!breakdown && (four || (energy > 0.5 && (s === 6 || s === 14) && rnd() < energy) || (fill && s >= 12 && s % 2 === 0))) {
          hit(ctx, out, kit.kick.buffer, t, 0.8 + rnd() * 0.15, 1);
        }
        if (kit.snare && !breakdown && (s === 4 || s === 12 || (fill && s >= 14) || (energy > 0.7 && s === 15 && rnd() < 0.3))) {
          hit(ctx, out, kit.snare.buffer, t, 0.55 + rnd() * 0.25, 1 + (rnd() - 0.5) * 0.02);
        }
        // ghost snare
        if (kit.snare && energy > 0.55 && (s === 7 || s === 13) && rnd() < 0.35) {
          hit(ctx, out, kit.snare.buffer, t, 0.16, 1.02);
        }
        if (kit.hat) {
          const every = energy > 0.65 ? 1 : 2;
          if (s % every === 0 && rnd() < 0.92) {
            hit(ctx, out, kit.hat.buffer, t, (four ? 0.34 : 0.2) + rnd() * 0.12, 1 + (rnd() - 0.5) * 0.03, 0.3);
          }
        }
        if (kit.perc && energy > 0.5 && (s === 2 || s === 10) && rnd() < 0.5) {
          hit(ctx, out, kit.perc.buffer, t, 0.2, 1 + (rnd() - 0.5) * 0.06);
        }
      }
      if (kit.bassSrc) {
        const bassPat = energy > 0.55 ? [0, 3, 6, 7, 10, 12, 14] : [0, 7, 12];
        for (const s of bassPat) {
          if (rnd() < 0.26) continue;
          const target = rootAt(bar) + (rnd() < 0.25 ? 12 : 0);
          hit(ctx, out, kit.bassSrc.buffer, t16(bar, s), 0.55, rateTo(bassMidi, target), 0.5, 500 + bright * 2200);
        }
      }
      if (kit.chordSrc) {
        const tones = chordTones(bar);
        const durC = breakdown ? beatSec * 3.4 : beatSec * 0.8;
        for (const m of tones) {
          hit(ctx, out, kit.chordSrc.buffer, t16(bar, 0), breakdown ? 0.3 : 0.26, rateTo(chordMidi, m), durC, 700 + bright * 3800);
        }
        if (energy > 0.6 && rnd() < 0.7) {
          for (const m of tones) hit(ctx, out, kit.chordSrc.buffer, t16(bar, 10), 0.18, rateTo(chordMidi, m), beatSec * 0.3, 700 + bright * 3800);
        }
        // arp from same source, higher
        if (bar >= 4 && rnd() < 0.3 + energy * 0.6) {
          const steps = energy > 0.6 ? [0, 2, 4, 6, 8, 10, 12, 14] : [0, 4, 8, 12];
          steps.forEach((s, i) => {
            if (rnd() < 0.75) {
              const m = tones[(i + bar) % 3] + 12 + (rnd() < 0.2 ? 12 : 0);
              hit(ctx, out, kit.chordSrc.buffer, t16(bar, s), 0.15 + energy * 0.1, rateTo(chordMidi, m), 0.22);
            }
          });
        }
      }
    }

    const rendered = await ctx.startRendering();
    let peak = 0;
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const d = rendered.getChannelData(c);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    let buffer = rendered;
    if (peak > 0.98) {
      const g = 0.95 / peak;
      const norm = new OfflineAudioContext(rendered.numberOfChannels, rendered.length, sr);
      const src = norm.createBufferSource(); src.buffer = rendered;
      const ng = norm.createGain(); ng.gain.value = g;
      src.connect(ng); ng.connect(norm.destination); src.start();
      buffer = await norm.startRendering();
    }
    return {
      buffer,
      meta: {
        seed, bpm, key: style.key || 'Am', energy, swing, brightness: bright, bars,
        kit: Object.fromEntries(Object.entries(kit).map(([r, v]) => [r, v.sample.name])),
        license: 'forge aus Library-Samples (Lizenzen der Packs beachten) · arrangement=seed-owned',
        origin: 'forge-sampled',
      },
    };
  }

  /** smart entry: sample-based when possible, synth fallback */
  async function forgeSmart(style = {}, ctx = null) {
    if (ctx?.project && ctx?.engine) {
      try { return await forgeSampled(style, ctx); } catch { /* fall through */ }
    }
    return forge(style);
  }

  global.LT_FORGE = { forge, forgeSampled, forgeSmart, PRESETS };
})(window);
