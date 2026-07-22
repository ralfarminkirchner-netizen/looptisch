/**
 * LOOPTiSCH Neural — magenta.js adapter (Apache 2.0, läuft im Browser).
 * DrumsRNN: neurale Groove-Fortsetzung → 16th-Steps für echte Kit-Pads.
 * Lazy-loaded von CDN; ehrlicher Status statt stillem Fail.
 *
 * Lizenz: @magenta/music + Checkpoints = Apache 2.0. Output = generiert,
 * keine Samples Dritter im Modell-Output (Noten-Events, kein Audio).
 */
(function (global) {
  'use strict';

  const MM_URL = 'https://cdn.jsdelivr.net/npm/@magenta/music@1.23.1/dist/magentamusic.min.js';
  const CKPT_DRUMS = 'https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/drum_kit_rnn';
  const CKPT_VAE_TRIO = 'https://storage.googleapis.com/magentadata/js/checkpoints/music_vae/trio_4bar';
  const CKPT_VAE_MEL = 'https://storage.googleapis.com/magentadata/js/checkpoints/music_vae/mel_2bar_small';

  let ready = null;
  let statusMsg = 'idle';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('load fail: ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensure(onStatus) {
    if (ready) return ready;
    const say = (t) => { statusMsg = t; if (onStatus) onStatus(t); };
    ready = (async () => {
      // magentamusic UMD bringt eigenes tf 2.7 mit (mm.tf) — KEIN separates
      // tf.js laden, sonst Versionskonflikt ("d is not a function")
      say('lade @magenta/music (inkl. tf)…');
      if (!global.mm) await loadScript(MM_URL);
      say('lade DrumsRNN checkpoint…');
      const drums = new global.mm.MusicRNN(CKPT_DRUMS);
      await drums.initialize();
      say('lade MusicVAE trio_4bar…');
      const trio = new global.mm.MusicVAE(CKPT_VAE_TRIO);
      await trio.initialize();
      say('lade MusicVAE mel_2bar…');
      const mel = new global.mm.MusicVAE(CKPT_VAE_MEL);
      await mel.initialize();
      say('bereit');
      return { mm: global.mm, drums, trio, mel };
    })();
    ready.catch((e) => { statusMsg = 'fail: ' + e.message; ready = null; });
    return ready;
  }

  /**
   * Neurale Drum-Groove: seed (1 Bar basic) → DrumsRNN continuation.
   * Returns { steps: Array<16*bars>, notes, status }
   * steps[s] = { kick: vel0..1, snare: vel, hat: vel, perc: vel }
   */
  async function drumGroove({ bars = 2, temperature = 1.15, onStatus } = {}) {
    const { mm, drums } = await ensure(onStatus);
    const say = (t) => { if (onStatus) onStatus(t); };
    say('DrumsRNN denkt…');

    // 1-bar seed, direkt quantisiert (16 steps @ spq 4): kick 1+3, snare 2+4, hats 8tel
    const seedNotes = [];
    const push = (pitch, q) => seedNotes.push({
      pitch, quantizedStartStep: q, quantizedEndStep: q + 1,
      startTime: q * 0.25, endTime: (q + 1) * 0.25, velocity: 100,
    });
    push(36, 0); push(42, 0);
    push(42, 2); push(38, 4); push(42, 4);
    push(42, 6); push(36, 8); push(42, 8);
    push(42, 10); push(38, 12); push(42, 12);
    push(42, 14);
    const seed = {
      notes: seedNotes,
      totalTime: 4,
      totalQuantizedSteps: 16,
      quantizationInfo: { stepsPerQuarter: 4 },
    };

    // continueSequence gibt SEED + Fortsetzung zurück → Seed-Länge abziehen
    const cont = await drums.continueSequence(seed, bars * 16, temperature);
    const notes = cont?.notes || [];
    const SEED_LEN = 16;

    // → step grid (16 steps/bar, 4 steps/quarter)
    const empty = () => ({ kick: 0, snare: 0, hat: 0, perc: 0 });
    const steps = Array.from({ length: bars * 16 }, empty);
    const roleOf = (p) => {
      if (p === 35 || p === 36) return 'kick';
      if (p === 38 || p === 40 || p === 37) return 'snare';
      if (p === 42 || p === 44 || p === 46) return 'hat';
      return 'perc';
    };
    let used = 0;
    for (const n of notes) {
      const qRaw = n.quantizedStartStep ?? Math.round(n.startTime * 4);
      const q = qRaw - SEED_LEN;
      if (q < 0 || q >= bars * 16) continue;
      const role = roleOf(n.pitch);
      const vel = Math.max(0.35, Math.min(1, (n.velocity || 80) / 110));
      if (vel > steps[q][role]) { steps[q][role] = vel; used++; }
    }
    say(`groove fertig: ${used}/${notes.length} Noten im Grid`);
    return { steps, notes: used, bars, temperature };
  }

  const NOTE_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

  /**
   * MusicVAE trio_4bar: neurale 4-Bar-Komposition (Melodie + Bass + Drums).
   * Rollen-Trennung: instrument 2/isDrum = drums, tiefster Mittel-Pitch = bass,
   * Rest = melody. Optional Transposition in Projekt-Key (Root auf Key-Grundton).
   * Returns { drums, bass, melody, bars: 4, beatsPerBar: 4, transposed, key }
   * Zeiten in Beats (quarters), 4 Beats/Bar → step = beat * 4 (16tel).
   */
  /** Rollen-Split einer Trio-Sequence (instrument 0=mel,1=bass,2=drums, defensiv) */
  function splitTrio(seq) {
    const drums = [], rawMel = [], rawBass = [];
    const byInst = { 0: [], 1: [], 2: [] };
    for (const n of (seq.notes || [])) (byInst[n.instrument] || []).push(n);
    drums.push(...byInst[2]);
    rawMel.push(...byInst[0]);
    rawBass.push(...byInst[1]);
    if (!drums.length) {
      for (const n of (seq.notes || [])) {
        if (n.isDrum) drums.push(n);
        else if (n.pitch < 48) rawBass.push(n);
        else rawMel.push(n);
      }
    }
    return { drums, rawMel, rawBass, totalNotes: (seq.notes || []).length };
  }

  function keyShift(rawBass, key) {
    if (!key || !rawBass.length) return { shift: 0, estRoot: null };
    const pcCount = new Array(12).fill(0);
    rawBass.forEach((n) => pcCount[n.pitch % 12]++);
    const estRoot = pcCount.indexOf(Math.max(...pcCount));
    const m = String(key).match(/^([A-G][#b]?)/);
    const target = NOTE_PC[m ? m[1] : 'A'] ?? 9;
    let shift = ((target - estRoot) % 12 + 12) % 12;
    if (shift > 6) shift -= 12;
    return { shift, estRoot };
  }

  function finishComp(split, shift, key, bars = 4) {
    const fix = (n) => ({
      pitch: n.pitch + shift,
      startBeat: n.startTime, endBeat: n.endTime,
      vel: Math.max(0.3, Math.min(1, (n.velocity || 80) / 110)),
    });
    return {
      drums: split.drums.map((n) => ({ ...fix(n), gm: n.pitch })),
      bass: split.rawMel ? split.rawBass.map(fix) : [],
      melody: split.rawMel ? split.rawMel.map(fix) : [],
      bars, beatsPerBar: 4,
      transposed: shift, key,
      totalNotes: split.totalNotes,
    };
  }

  async function trioSample({ temperature = 1.0, key = null, onStatus } = {}) {
    const { trio } = await ensure(onStatus);
    const say = (t) => { if (onStatus) onStatus(t); };
    say('MusicVAE komponiert (trio_4bar)…');
    const seqs = await trio.sample(1, temperature);
    const split = splitTrio(seqs[0]);
    const { shift, estRoot } = keyShift(split.rawBass, key);
    const out = finishComp(split, shift, key);
    out.estRoot = estRoot;
    out._seq = seqs[0]; // für interpolate()
    say(`trio: ${out.drums.length} drums · ${out.bass.length} bass · ${out.melody.length} melody${shift ? ` · ${shift > 0 ? '+' : ''}${shift}st → ${key}` : ''}`);
    return out;
  }

  /**
   * Latent-Interpolation: zwei Trio-Kompositionen → N Morphs dazwischen.
   * VAE-Superkraft: Zwischenstände sind musikalisch kohärente Mischungen.
   * Shared key-shift (von seqA) → alle Morphs in derselben Tonart.
   */
  async function trioInterpolate({ temperature = 1.0, steps = 4, key = null, onStatus } = {}) {
    const { trio } = await ensure(onStatus);
    const say = (t) => { if (onStatus) onStatus(t); };
    say('VAE: zwei Seeds komponieren…');
    const [a, b] = await trio.sample(2, temperature);
    say(`VAE interpolate ×${steps}…`);
    const morphs = await trio.interpolate([a, b], steps);
    const splitA = splitTrio(a);
    const { shift } = keyShift(splitA.rawBass, key);
    const out = morphs.map((seq, i) => {
      const c = finishComp(splitTrio(seq), shift, key, 4);
      c.morphIndex = i;
      return c;
    });
    say(`morph: ${out.length} Varianten · shift ${shift}`);
    return { morphs: out, keyA: a, keyB: b, shift };
  }

  /** mel_2bar: reine Melodie-Lane (kein Schlagzeug/Bass) */
  async function melodySample({ temperature = 1.0, key = null, onStatus } = {}) {
    const { mel } = await ensure(onStatus);
    const say = (t) => { if (onStatus) onStatus(t); };
    say('MusicVAE melodiert (mel_2bar)…');
    const seqs = await mel.sample(1, temperature);
    const notes = (seqs[0].notes || []);
    const { shift } = keyShift(notes, key);
    const fix = (n) => ({
      pitch: n.pitch + shift,
      startBeat: n.startTime, endBeat: n.endTime,
      vel: Math.max(0.3, Math.min(1, (n.velocity || 80) / 110)),
    });
    say(`melody: ${notes.length} Noten · shift ${shift}`);
    return { melody: notes.map(fix), bars: 2, beatsPerBar: 4, transposed: shift, key, totalNotes: notes.length };
  }

  /** GM-Drum-Rolle */
  function drumRoleOf(p) {
    if (p === 35 || p === 36) return 'kick';
    if (p === 38 || p === 40 || p === 37) return 'snare';
    if (p === 42 || p === 44 || p === 46) return 'hat';
    return 'perc';
  }

  /**
   * Render trio composition OFFLINE through real kit samples (MPC rate pitching).
   * kit: { kick?, snare?, hat?, perc?, bassSrc?, chordSrc? } of { buffer, sample }
   * from LT_FORGE.pickKit-compatible objects. bpm = playback tempo.
   */
  async function renderTrio(comp, kit, { bpm = 92, brightness = 0.5 } = {}) {
    const sr = 44100;
    const beatSec = 60 / bpm;
    const totalBeats = comp.bars * comp.beatsPerBar;
    const dur = totalBeats * beatSec + 1;
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const out = ctx.createGain(); out.gain.value = 0.8;
    const compNode = ctx.createDynamicsCompressor();
    compNode.threshold.value = -12; compNode.ratio.value = 3; compNode.knee.value = 10;
    out.connect(compNode); compNode.connect(ctx.destination);

    const hit = (buffer, t, vel, rate = 1, maxDur = 0, lpHz = 0) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer; src.playbackRate.value = rate;
      const g = ctx.createGain(); g.gain.setValueAtTime(vel, t);
      let node = src;
      if (lpHz) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lpHz; src.connect(lp); node = lp; }
      node.connect(g); g.connect(out);
      const d = maxDur || Math.min(buffer.duration / rate, 1.2);
      g.gain.setTargetAtTime(0.0001, t + d * 0.85, 0.04);
      src.start(t); src.stop(t + d + 0.3);
    };

    const midiOf = (buffer, fallback) => {
      try {
        const ch = buffer.getChannelData(0);
        const mid = ch.subarray(Math.floor(ch.length * 0.1), Math.floor(ch.length * 0.1) + 4096);
        const f0 = global.LT_DSP?.detectPitch(mid, buffer.sampleRate);
        if (f0 && f0 > 30 && f0 < 1200) return 69 + 12 * Math.log2(f0 / 440);
      } catch { /* noop */ }
      return fallback;
    };
    const rateTo = (srcMidi, target) => Math.pow(2, (target - srcMidi) / 12);
    const bassAnchor = kit.bassSrc ? midiOf(kit.bassSrc.buffer, 45) : 45;
    const leadAnchor = kit.chordSrc ? midiOf(kit.chordSrc.buffer, 60) : 60;

    for (const n of comp.drums) {
      const role = drumRoleOf(n.gm);
      const k = kit[role];
      if (!k) continue;
      hit(k.buffer, n.startBeat * beatSec, n.vel * 0.85, 1 + (Math.random() - 0.5) * 0.02);
    }
    for (const n of comp.bass) {
      if (!kit.bassSrc) continue;
      const len = Math.max(0.15, (n.endBeat - n.startBeat) * beatSec);
      hit(kit.bassSrc.buffer, n.startBeat * beatSec, n.vel * 0.6, rateTo(bassAnchor, n.pitch), len, 500 + brightness * 2200);
    }
    for (const n of comp.melody) {
      if (!kit.chordSrc) continue;
      const len = Math.max(0.12, (n.endBeat - n.startBeat) * beatSec);
      hit(kit.chordSrc.buffer, n.startBeat * beatSec, n.vel * 0.4, rateTo(leadAnchor, n.pitch), len, 900 + brightness * 4000);
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
    return { buffer, meta: { bpm, bars: comp.bars, transposed: comp.transposed, key: comp.key } };
  }

  global.LT_NEURAL = {
    drumGroove, trioSample, trioInterpolate, melodySample, renderTrio, drumRoleOf, ensure,
    get status() { return statusMsg; },
  };
})(window);
