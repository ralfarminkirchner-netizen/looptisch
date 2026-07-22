/**
 * LOOPTiSCH PANDRUM v2 — digitale Handpan, ernsthaft.
 * - Sound: Oktav/Quint-Resonanzen + Shell-Boom + Body-Convolution + Warm-Filter
 * - Modelle: alle gängigen Handpan-Skalen (Kurd, Amara, Hijaz, Pygmy, …)
 * - Sample-Modus: jede Anschlagfläche = Sample-Slot (Auto-Fill + Drag&Drop)
 * - Root folgt Projekt-Key. Läuft durch die Master-FX-Kette.
 */
(function (global) {
  'use strict';

  const NOTE_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  /** Handpan-Modelle: Intervalle ab Root (Ring), Ding = Root-12 */
  const MODELS = {
    'kurd':       { name: 'KURD (nat. Moll)',    iv: [0, 2, 3, 5, 7, 8, 10, 12, 15] },
    'amara':      { name: 'AMARA / CELTIC',      iv: [0, 3, 5, 7, 10, 12, 15, 17, 19] },
    'hijaz':      { name: 'HIJAZ (orientalisch)', iv: [0, 1, 4, 5, 7, 8, 11, 12, 13] },
    'pygmy':      { name: 'PYGMY',               iv: [0, 3, 5, 8, 10, 12, 15, 17, 20] },
    'low-pygmy':  { name: 'LOW PYGMY',           iv: [0, 3, 5, 8, 10, 13, 15, 18, 20] },
    'integral':   { name: 'INTEGRAL',            iv: [0, 3, 5, 7, 10, 12, 14, 17, 19] },
    'akebono':    { name: 'AKEBONO (japanisch)', iv: [0, 2, 3, 7, 8, 12, 14, 15, 19] },
    'equinox':    { name: 'EQUINOX (Dur)',       iv: [0, 2, 4, 7, 9, 12, 14, 16, 19] },
    'sabye':      { name: 'SABYE (lydisch)',     iv: [0, 2, 4, 6, 7, 9, 11, 12, 14] },
    'aegean':     { name: 'AEGEAN',              iv: [0, 2, 3, 7, 8, 10, 12, 14, 15] },
  };

  function keyRoot(key) {
    const m = String(key || 'A').match(/^([A-G][#b]?)/);
    return NOTE_PC[m ? m[1] : 'A'] ?? 9;
  }

  /** Handpan-Synthese v2: echter Klangkörper */
  class PanVoice {
    constructor(ctx, destination) {
      this.ctx = ctx;
      // warm chain: voice → lowpass → body convolver → out
      this.lp = ctx.createBiquadFilter();
      this.lp.type = 'lowpass'; this.lp.frequency.value = 5800; this.lp.Q.value = 0.4;
      this.body = ctx.createConvolver();
      this.body.buffer = PanVoice.makeBodyIR(ctx);
      this.bodyGain = ctx.createGain(); this.bodyGain.gain.value = 0.22;
      this.out = ctx.createGain(); this.out.gain.value = 0.9;
      this.lp.connect(this.out);
      this.lp.connect(this.body); this.body.connect(this.bodyGain); this.bodyGain.connect(this.out);
      this.out.connect(destination);
    }
    static makeBodyIR(ctx) {
      const sr = ctx.sampleRate, len = Math.round(sr * 0.42);
      const buf = ctx.createBuffer(2, len, sr);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / len;
          const n = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2);
          lp += 0.14 * (n - lp); // dunkler, weicher Korpus
          d[i] = lp;
        }
      }
      return buf;
    }
    play(t, freq, vel) {
      const ctx = this.ctx;
      // Resonanzen: Grund + Oktave + Quinte (f·2·1.5) + Oberton
      const parts = [
        { r: 1.0,   g: 1.0,  d: 4.2 },
        { r: 2.0,   g: 0.52, d: 3.0 },
        { r: 2.99,  g: 0.26, d: 2.1 },
        { r: 4.16,  g: 0.10, d: 1.3 },
        { r: 5.43,  g: 0.05, d: 0.9 },
      ];
      for (const p of parts) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = freq * p.r * (1 + (Math.random() - 0.5) * 0.0025);
        // minimaler Strike-Bend (2–4 cents runter) = Membran
        o.frequency.setValueAtTime(freq * p.r * 1.004, t);
        o.frequency.exponentialRampToValueAtTime(freq * p.r, t + 0.03);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.max(0.001, vel * p.g), t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + p.d);
        o.connect(g); g.connect(this.lp);
        o.start(t); o.stop(t + p.d + 0.1);
      }
      // Shell-Boom (Korpus-Grund)
      const boom = ctx.createOscillator();
      boom.type = 'sine';
      boom.frequency.value = freq / 2;
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(vel * 0.18, t);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      boom.connect(bg); bg.connect(this.lp);
      boom.start(t); boom.stop(t + 1.5);
      // Mallet: gefilterter Anschlag-Noise
      const nb = ctx.createBuffer(1, 2205, ctx.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / 260);
      const ns = ctx.createBufferSource(); ns.buffer = nb;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq * 4.2; bp.Q.value = 0.9;
      const ng = ctx.createGain(); ng.gain.setValueAtTime(vel * 0.3, t);
      ns.connect(bp); bp.connect(ng); ng.connect(this.lp);
      ns.start(t);
    }
  }

  const DEGREE_COLORS = ['#4dd2ff', '#9dff4d', '#ffb84d', '#ff4d7e', '#c44dff', '#4dffc3', '#ffe24d', '#7d9dff', '#ff8a5c', '#5cff9d'];

  class Pandrum {
    constructor(engine, getKey) {
      this.engine = engine;
      this.getKey = getKey;
      this.model = 'kurd';
      this.mode = 'synth'; // 'synth' | 'sample'
      this.slots = new Map(); // midi → { sample, buffer, anchorMidi }
      this.rootEl = null;
      this._hallSuggested = false;
    }

    notes() {
      const root = 48 + keyRoot(this.getKey());
      const iv = MODELS[this.model].iv;
      return { ding: root - 12, ring: iv.map((s) => root + s).slice(0, 9) };
    }

    mount(rootEl, onMsg) {
      this.rootEl = rootEl;
      this.onMsg = onMsg;
      this.render();
    }

    render() {
      if (!this.rootEl) return;
      const { ding, ring } = this.notes();
      const label = (m) => NOTE_NAMES[m % 12] + Math.floor(m / 12 - 1);
      const R = 41;
      let html = `<div class="pan-stage">
        <div class="pan-toolbar">
          <select id="panModel" class="pan-sel" title="Handpan-Modell">${
            Object.entries(MODELS).map(([id, m]) =>
              `<option value="${id}"${id === this.model ? ' selected' : ''}>${m.name}</option>`).join('')
          }</select>
          <div class="seg-filters pan-mode">
            <button type="button" class="${this.mode === 'synth' ? 'on' : ''}" data-panmode="synth">SYNTH</button>
            <button type="button" class="${this.mode === 'sample' ? 'on' : ''}" data-panmode="sample">SAMPLES</button>
          </div>
          <button type="button" class="mini" id="panAutoFill" title="Library-Samples auf die Felder legen">AUTO-FILL</button>
        </div>
        <div class="pan-shell">`;
      html += `<button type="button" class="pan-field ding" data-midi="${ding}" style="--fc:${DEGREE_COLORS[0]}">
          <b>${label(ding)}</b><span>DING</span></button>`;
      ring.forEach((m, i) => {
        const ang = (i / ring.length) * 2 * Math.PI - Math.PI / 2;
        const x = 50 + Math.cos(ang) * R;
        const y = 50 + Math.sin(ang) * R;
        const sl = this.slots.get(m);
        html += `<button type="button" class="pan-field${sl ? ' loaded' : ''}" data-midi="${m}"
          style="left:${x}%; top:${y}%; --fc:${DEGREE_COLORS[(i + 1) % DEGREE_COLORS.length]}">
          <b>${label(m)}</b><span>${this.mode === 'sample' && sl ? sl.sample.name.slice(0, 10) : (i + 1)}</span></button>`;
      });
      html += `</div>
        <div class="pan-meta">
          <span class="pan-key">${this.getKey()} · ${MODELS[this.model].name}</span>
          <span class="pan-hint">${this.mode === 'synth'
            ? 'berühren = spielen · Velocity = Abstand zur Mitte · SYNTH-Korpus'
            : 'Felder = Sample-Slots · Sample aus Library hierher ziehen · AUTO-FILL füllt alles'}</span>
        </div>
      </div>`;
      this.rootEl.innerHTML = html;

      const sel = this.rootEl.querySelector('#panModel');
      sel.onchange = () => { this.model = sel.value; this.slots.clear(); this.render(); };
      this.rootEl.querySelectorAll('[data-panmode]').forEach((b) => {
        b.onclick = () => {
          this.mode = b.dataset.panmode;
          if (this.mode === 'sample' && !this.slots.size) this.autoFill();
          this.render();
        };
      });
      const af = this.rootEl.querySelector('#panAutoFill');
      if (af) af.onclick = () => { this.autoFill(true); this.render(); };

      this.rootEl.querySelectorAll('.pan-field').forEach((f) => {
        f.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          const rect = f.getBoundingClientRect();
          const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
          const dist = Math.min(1, Math.hypot(e.clientX - cx, e.clientY - cy) / (rect.width / 2));
          const vel = Math.max(0.35, 1 - dist * 0.7);
          this.hit(+f.dataset.midi, vel, f);
        });
        // Sample-Drop auf Feld
        f.addEventListener('dragover', (e) => e.preventDefault());
        f.addEventListener('drop', (e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData('text/sample-id');
          if (!id) return;
          this.assignSample(+f.dataset.midi, id).then(() => this.render());
        });
      });
    }

    async assignSample(midi, sampleId) {
      const s = global.LT?.project.findSample(sampleId);
      if (!s) return;
      const buffer = await global.LT_FORGE.loadBufferFor(this.engine, s).catch(() => null);
      if (!buffer) { if (this.onMsg) this.onMsg('Pandrum', 'Sample nicht ladbar: ' + s.name); return; }
      this.slots.set(midi, { sample: s, buffer, anchorMidi: detectAnchor(buffer) });
      if (this.onMsg) this.onMsg('Pandrum', `Feld ${NOTE_NAMES[midi % 12]} ← ${s.name}`);
    }

    /** Auto-Fill: melodische/perc Samples auf alle Felder */
    autoFill(force) {
      const lib = (global.LT?.project.library || []).filter((s) => s.real);
      const mel = lib.filter((s) => s.type === 'melodic');
      const percs = lib.filter((s) => s.type === 'perc' || s.type === 'snare');
      const pool = [...mel, ...percs];
      if (!pool.length) return;
      const { ding, ring } = this.notes();
      const all = [ding, ...ring];
      all.forEach((m, i) => {
        if (!force && this.slots.has(m)) return;
        const s = pool[(Math.random() * pool.length) | 0];
        global.LT_FORGE.loadBufferFor(this.engine, s).then((buffer) => {
          if (buffer) this.slots.set(m, { sample: s, buffer, anchorMidi: detectAnchor(buffer) });
          if (i === all.length - 1) this.render();
        }).catch(() => {});
      });
      if (this.onMsg) this.onMsg('Pandrum', `AUTO-FILL: ${all.length} Felder ← Library-Samples (Pitch folgt Feld)`);
    }

    hit(midi, vel, el) {
      const engine = this.engine;
      engine.ensure();
      if (!this._voice) {
        const dest = engine.ctx.createGain();
        dest.gain.value = 1;
        dest.connect(engine.input);
        this._voice = new PanVoice(engine.ctx, dest);
      }
      const t = engine.ctx.currentTime;
      const slot = this.mode === 'sample' ? this.slots.get(midi) : null;
      if (slot) {
        // Sample-Modus: rate-pitched auf Feld-Note
        const src = engine.ctx.createBufferSource();
        src.buffer = slot.buffer;
        src.playbackRate.value = Math.pow(2, (midi - slot.anchorMidi) / 12);
        const g = engine.ctx.createGain();
        g.gain.setValueAtTime(vel, t);
        g.gain.setTargetAtTime(0.0001, t + Math.min(slot.buffer.duration, 2.5) * 0.8, 0.2);
        src.connect(g); g.connect(this._voice.lp);
        src.start(t); src.stop(t + Math.min(slot.buffer.duration / src.playbackRate.value, 3));
      } else {
        this._voice.play(t, midiHz(midi), vel);
      }
      if (!this._hallSuggested && engine.rack) {
        this._hallSuggested = true;
        engine.rack.setEnabled('reverb', true);
        engine.rack.setAmount('reverb', 0.3);
        document.querySelector('.fx-chip[data-fx="reverb"]')?.classList.add('on');
        if (this.onMsg) this.onMsg('Pandrum', 'HALL 30% aktiviert — Handpan braucht Raum. Aus im FX·LAB.');
      }
      if (el) {
        el.classList.remove('ping');
        void el.offsetWidth;
        el.classList.add('ping');
      }
    }

    refreshKey() { this.slots.clear(); this.render(); }
  }

  /** Pitch-Anker eines Samples (Fallback 60) */
  function detectAnchor(buffer) {
    try {
      const ch = buffer.getChannelData(0);
      const mid = ch.subarray(Math.floor(ch.length * 0.1), Math.floor(ch.length * 0.1) + 4096);
      const f0 = global.LT_DSP?.detectPitch(mid, buffer.sampleRate);
      if (f0 && f0 > 30 && f0 < 1200) return 69 + 12 * Math.log2(f0 / 440);
    } catch { /* noop */ }
    return 60;
  }

  global.LT_PANDRUM = { Pandrum, MODELS };
})(window);
