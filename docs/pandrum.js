/**
 * LOOPTiSCH PANDRUM — digitale Handpan.
 * Modal-Synthese (inharmonische Partials, lange Decays) — klingt nach echtem
 * Steeldrum/PANTAM, jede Note passt (Skala = Projekt-Key). Kein Menü nötig:
 * Tab öffnen, Felder berühren, Musik.
 * Läuft durch die Master-FX-Kette (HALL darauf = magisch).
 */
(function (global) {
  'use strict';

  const NOTE_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10];
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function keyInfo(key) {
    const m = String(key || 'Am').match(/^([A-G][#b]?)(m)?/);
    const root = NOTE_PC[m ? m[1] : 'A'] ?? 9;
    return { root, scale: m && m[2] ? SCALE_MINOR : SCALE_MAJOR, minor: !!(m && m[2]) };
  }

  /** Handpan-Feld: modal partials + mallet thump */
  function handpanNote(ctx, out, t, freq, vel) {
    const partials = [1, 2.76, 5.404, 8.93];
    const gains = [1.0, 0.45, 0.22, 0.09];
    const decays = [3.8, 2.4, 1.5, 0.9];
    for (let i = 0; i < partials.length; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * partials[i] * (1 + (Math.random() - 0.5) * 0.0012);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, vel * gains[i]), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decays[i]);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + decays[i] + 0.1);
    }
    // mallet: kurzer gefilterter Noise-Anschlag
    const nb = ctx.createBuffer(1, 2205, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / 300);
    const ns = ctx.createBufferSource(); ns.buffer = nb;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq * 3; bp.Q.value = 1.2;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(vel * 0.35, t);
    ns.connect(bp); bp.connect(ng); ng.connect(out);
    ns.start(t);
  }

  const DEGREE_COLORS = ['#4dd2ff', '#9dff4d', '#ffb84d', '#ff4d7e', '#c44dff', '#4dffc3', '#ffe24d', '#7d9dff', '#ff8a5c'];

  class Pandrum {
    constructor(engine, getKey) {
      this.engine = engine;
      this.getKey = getKey;
      this.fields = [];
      this.rootEl = null;
      this._hallSuggested = false;
    }

    /** Skala → Feld-Noten: Ding (root-12) + Spirale über 2 Oktaven */
    notes() {
      const { root, scale } = keyInfo(this.getKey());
      const base = 48 + root; // C3-Bereich je nach Key
      const ding = base - 12;
      const ring = [];
      let deg = 0, oct = 0;
      while (ring.length < 8) {
        ring.push(base + oct * 12 + scale[deg % scale.length]);
        deg++;
        if (deg % scale.length === 0) oct++;
      }
      return { ding, ring };
    }

    mount(rootEl, onMsg) {
      this.rootEl = rootEl;
      this.onMsg = onMsg;
      this.render();
    }

    render() {
      if (!this.rootEl) return;
      const { ding, ring } = this.notes();
      const key = this.getKey();
      const label = (m) => NOTE_NAMES[m % 12] + Math.floor(m / 12 - 1);
      const R = 42; // % Radius
      let html = `<div class="pan-stage">
        <div class="pan-shell">`;
      // Ding center
      html += `<button type="button" class="pan-field ding" data-midi="${ding}" style="--fc:${DEGREE_COLORS[0]}">
          <b>${label(ding)}</b><span>DING</span></button>`;
      ring.forEach((m, i) => {
        const ang = (i / ring.length) * 2 * Math.PI - Math.PI / 2;
        const x = 50 + Math.cos(ang) * R;
        const y = 50 + Math.sin(ang) * R;
        html += `<button type="button" class="pan-field" data-midi="${m}"
          style="left:${x}%; top:${y}%; --fc:${DEGREE_COLORS[(i + 1) % DEGREE_COLORS.length]}">
          <b>${label(m)}</b><span>${i + 1}</span></button>`;
      });
      html += `</div>
        <div class="pan-meta">
          <span class="pan-key">${key}</span>
          <span class="pan-hint">berühren = spielen · Velocity = Abstand zur Mitte · läuft durch FX-Kette</span>
        </div>
      </div>`;
      this.rootEl.innerHTML = html;

      this.rootEl.querySelectorAll('.pan-field').forEach((f) => {
        f.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          const rect = f.getBoundingClientRect();
          const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
          const dist = Math.min(1, Math.hypot(e.clientX - cx, e.clientY - cy) / (rect.width / 2));
          const vel = Math.max(0.35, 1 - dist * 0.7);
          this.hit(+f.dataset.midi, vel, f);
        });
      });
    }

    hit(midi, vel, el) {
      const engine = this.engine;
      engine.ensure();
      const t = engine.ctx.currentTime;
      // durch die FX-Kette: eigenes Send-Gain in engine.input
      if (!this._send) {
        this._send = engine.ctx.createGain();
        this._send.gain.value = 0.9;
        this._send.connect(engine.input);
      }
      handpanNote(engine.ctx, this._send, t, midiHz(midi), vel);
      // HALL beim ersten Mal sanft dazu (und ehrlich sagen)
      if (!this._hallSuggested && engine.rack) {
        this._hallSuggested = true;
        engine.rack.setEnabled('reverb', true);
        engine.rack.setAmount('reverb', 0.3);
        document.querySelector('.fx-chip[data-fx="reverb"]')?.classList.add('on');
        if (this.onMsg) this.onMsg('Pandrum', 'HALL 30% auf der FX-Kette aktiviert — Handpan braucht Raum. Aus im FX·LAB.');
      }
      if (el) {
        el.classList.remove('ping');
        void el.offsetWidth;
        el.classList.add('ping');
      }
    }

    refreshKey() { this.render(); }
  }

  global.LT_PANDRUM = { Pandrum };
})(window);
