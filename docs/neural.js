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
      say('bereit');
      return { mm: global.mm, drums };
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

  global.LT_NEURAL = {
    drumGroove,
    ensure,
    get status() { return statusMsg; },
  };
})(window);
