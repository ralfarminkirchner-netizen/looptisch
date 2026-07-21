/**
 * LOOPTiSCH v2 Engine
 * High-quality procedural voices + real sample bus + Project API for agents.
 */
(function (global) {
  'use strict';

  const NOTE_FREQ = {
    C: 261.63, 'C#': 277.18, Db: 277.18, D: 293.66, 'D#': 311.13, Eb: 311.13,
    E: 329.63, F: 349.23, 'F#': 369.99, Gb: 369.99, G: 392.0, 'G#': 415.3,
    Ab: 415.3, A: 440.0, 'A#': 466.16, Bb: 466.16, B: 493.88,
  };
  function keyRoot(key) {
    const m = String(key || 'A').match(/^([A-G][#b]?)/);
    return m ? m[1] : 'A';
  }

  const CATALOG = [
    { id: 'k1', name: 'Kick_Dust_A', type: 'kick', bpm: 92, key: '—', tags: ['dusty', 'punch', 'mono'], energy: 0.72 },
    { id: 'k2', name: 'Kick_Sub_Round', type: 'kick', bpm: 90, key: '—', tags: ['sub', 'clean', 'round'], energy: 0.68 },
    { id: 'k3', name: 'Kick_Hard_909', type: 'kick', bpm: 125, key: '—', tags: ['hard', 'club'], energy: 0.9 },
    { id: 's1', name: 'Snare_Room_Crack', type: 'snare', bpm: 92, key: '—', tags: ['room', 'crack'], energy: 0.78 },
    { id: 's2', name: 'Snare_Rim_Tight', type: 'snare', bpm: 88, key: '—', tags: ['rim', 'tight'], energy: 0.58 },
    { id: 's3', name: 'Clap_Layer', type: 'snare', bpm: 100, key: '—', tags: ['clap', 'wide'], energy: 0.72 },
    { id: 'h1', name: 'HH_Closed_Metal', type: 'hat', bpm: 0, key: '—', tags: ['closed', 'metal'], energy: 0.42 },
    { id: 'h2', name: 'HH_Open_Air', type: 'hat', bpm: 0, key: '—', tags: ['open', 'air'], energy: 0.48 },
    { id: 'h3', name: 'HH_Pedal', type: 'hat', bpm: 0, key: '—', tags: ['pedal'], energy: 0.32 },
    { id: 'p1', name: 'Perc_Shaker', type: 'perc', bpm: 0, key: '—', tags: ['shaker', 'grain'], energy: 0.38 },
    { id: 'p2', name: 'Perc_Rimshot', type: 'perc', bpm: 0, key: '—', tags: ['rim', 'dry'], energy: 0.52 },
    { id: 'p3', name: 'Perc_Conga', type: 'perc', bpm: 94, key: '—', tags: ['conga', 'warm'], energy: 0.55 },
    { id: 'm1', name: 'Bass_Sub_Am', type: 'melodic', bpm: 92, key: 'Am', tags: ['bass', 'sub', 'dark'], energy: 0.62 },
    { id: 'm2', name: 'Rhodes_Loop_Am', type: 'melodic', bpm: 86, key: 'Am', tags: ['keys', 'warm', 'loopish'], energy: 0.52 },
    { id: 'm3', name: 'Lead_Pluck_Cm', type: 'melodic', bpm: 100, key: 'Cm', tags: ['pluck', 'bright'], energy: 0.55 },
    { id: 'l1', name: 'Break_AmenLite', type: 'loop', bpm: 138, key: '—', tags: ['break', 'chop-me', 'classic'], energy: 0.85 },
    { id: 'l2', name: 'Break_FunkyDrummer', type: 'loop', bpm: 102, key: '—', tags: ['break', 'groove'], energy: 0.8 },
    { id: 'l3', name: 'Pad_Atmosphere', type: 'loop', bpm: 80, key: 'Am', tags: ['pad', 'wide', 'dark'], energy: 0.35 },
  ];

  function makeSoftClipCurve(amount, n = 2048) {
    const curve = new Float32Array(n);
    const k = 1 + amount * 40;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.input = null; // voices land here
      this.drive = null;
      this.comp = null;
      this.master = null;
      this.analyser = null;
      this.meter = { l: 0, r: 0 };
      this.driveAmount = 0.22;
      this.masterVol = 0.78;
      this.buffers = new Map();
      this._noiseCache = new Map();
      this._pending = new Map(); // url decode in-flight
    }

    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();

        this.input = this.ctx.createGain();
        this.input.gain.value = 1;

        this.drive = this.ctx.createWaveShaper();
        this.drive.curve = makeSoftClipCurve(this.driveAmount);
        this.drive.oversample = '2x';

        this.comp = this.ctx.createDynamicsCompressor();
        this.comp.threshold.value = -18;
        this.comp.knee.value = 12;
        this.comp.ratio.value = 3.2;
        this.comp.attack.value = 0.003;
        this.comp.release.value = 0.12;

        // brickwall limiter — glue + safety ceiling
        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -3.5;
        this.limiter.knee.value = 0;
        this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.001;
        this.limiter.release.value = 0.08;

        this.master = this.ctx.createGain();
        this.master.gain.value = this.masterVol;

        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.65;

        // input -> [fx rack] -> [master suite] -> drive -> comp -> limiter -> master -> analyser -> out
        if (window.LT_FX && window.LT_MASTER) {
          this.rack = window.LT_FX.createRack(this.ctx);
          this.masterSuite = window.LT_MASTER.create(this.ctx);
          this.input.connect(this.rack.input);
          this.rack.output.connect(this.masterSuite.input);
          this.masterSuite.output.connect(this.drive);
        } else {
          this.input.connect(this.drive);
        }
        this.drive.connect(this.comp);
        this.comp.connect(this.limiter);
        this.limiter.connect(this.master);
        this.master.connect(this.analyser);
        this.analyser.connect(this.ctx.destination);

        this._runMeter();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    setDrive(amount01) {
      this.driveAmount = Math.max(0, Math.min(1, amount01));
      if (this.drive) this.drive.curve = makeSoftClipCurve(this.driveAmount);
    }

    setMasterVol(v01) {
      this.masterVol = Math.max(0, Math.min(1, v01));
      if (this.master) {
        const t = this.ctx.currentTime;
        this.master.gain.setTargetAtTime(this.masterVol, t, 0.02);
      }
    }

    storeBuffer(id, buf) { this.buffers.set(id, buf); return id; }
    getBuffer(id) { return this.buffers.get(id) || null; }

    /** Encode path segments so spaces/[brackets]/unicode load on static hosts. */
    static encodeAssetPath(path) {
      if (!path) return path;
      // already absolute URL
      if (/^https?:\/\//i.test(path)) return path;
      return String(path)
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
    }

    /** Fetch + decode a library/pack sample by URL. Cached + de-duped. */
    loadUrl(id, url) {
      if (this.buffers.has(id)) return Promise.resolve(this.buffers.get(id));
      if (this._pending.has(id)) return this._pending.get(id);
      const ctx = this.ensure();
      const href = AudioEngine.encodeAssetPath(url);
      const p = fetch(href)
        .then((r) => {
          if (!r.ok) throw new Error('fetch_' + r.status + ':' + href);
          return r.arrayBuffer();
        })
        .then((ab) => ctx.decodeAudioData(ab.slice(0)))
        .then((buf) => {
          this.buffers.set(id, buf);
          this._pending.delete(id);
          return buf;
        })
        .catch((e) => {
          this._pending.delete(id);
          throw e;
        });
      this._pending.set(id, p);
      return p;
    }

    /** Fire-and-forget preload so the sequencer never waits on disk. */
    preload(samples) {
      const jobs = (samples || [])
        .filter((s) => s && s.url && !this.buffers.has(s.bufferId || s.id))
        .map((s) => this.loadUrl(s.bufferId || s.id, s.url).catch(() => null));
      return Promise.all(jobs);
    }

    async decodeFile(arrayBuffer) {
      const ctx = this.ensure();
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    }

    _noise(seconds) {
      const ctx = this.ensure();
      const key = Math.round(seconds * 1000);
      if (this._noiseCache.has(key)) return this._noiseCache.get(key);
      const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        // slight brown-ish for body noise
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        d[i] = white * 0.7 + last * 0.3;
      }
      this._noiseCache.set(key, buf);
      return buf;
    }

    _env(g, t0, a, d, s, r, peak = 1) {
      const t = t0;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + Math.max(0.001, a));
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * s), t + a + Math.max(0.001, d));
      return t + a + d; // sustain starts; caller schedules release
    }

    _out(vel = 1) {
      const ctx = this.ensure();
      const g = ctx.createGain();
      g.gain.value = Math.max(0.001, Math.min(1.5, vel));
      g.connect(this.input);
      return g;
    }

    playVoice(type, opts = {}) {
      const ctx = this.ensure();
      const t0 = ctx.currentTime + (opts.when || 0);
      const vel = Math.max(0.05, Math.min(1, opts.vel ?? 0.9));
      const open = !!opts.open || /open/i.test(opts.name || '');
      const root = NOTE_FREQ[keyRoot(opts.key)] || 110;
      const stretch = Math.max(0.5, Math.min(2, opts.stretch || 1));
      const out = this._out(vel * (opts.level ?? 1));

      if (type === 'kick') {
        // Body sine pitch drop
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(1800, t0);
        f.frequency.exponentialRampToValueAtTime(140, t0 + 0.08);
        f.Q.value = 0.7;
        o.type = 'sine';
        const startF = opts.hard ? 180 : 140;
        o.frequency.setValueAtTime(startF, t0);
        o.frequency.exponentialRampToValueAtTime(38, t0 + 0.09 / stretch);
        og.gain.setValueAtTime(0.0001, t0);
        og.gain.exponentialRampToValueAtTime(1.0, t0 + 0.002);
        og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42 / stretch);
        o.connect(f); f.connect(og); og.connect(out);
        o.start(t0); o.stop(t0 + 0.5);

        // Sub layer
        const sub = ctx.createOscillator();
        const sg = ctx.createGain();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(70, t0);
        sub.frequency.exponentialRampToValueAtTime(36, t0 + 0.12);
        sg.gain.setValueAtTime(0.0001, t0);
        sg.gain.exponentialRampToValueAtTime(0.85, t0 + 0.004);
        sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5 / stretch);
        sub.connect(sg); sg.connect(out);
        sub.start(t0); sub.stop(t0 + 0.55);

        // Click transient
        const clk = ctx.createOscillator();
        const cg = ctx.createGain();
        clk.type = 'triangle';
        clk.frequency.value = opts.hard ? 2200 : 1400;
        cg.gain.setValueAtTime(0.0001, t0);
        cg.gain.exponentialRampToValueAtTime(0.35 * vel, t0 + 0.0008);
        cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.018);
        clk.connect(cg); cg.connect(out);
        clk.start(t0); clk.stop(t0 + 0.03);

        // Noise tick
        const ns = ctx.createBufferSource();
        ns.buffer = this._noise(0.04);
        const ng = ctx.createGain();
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1500;
        ng.gain.setValueAtTime(0.2 * vel, t0);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.025);
        ns.connect(hp); hp.connect(ng); ng.connect(out);
        ns.start(t0);
      } else if (type === 'snare') {
        // Tonal body
        const o1 = ctx.createOscillator();
        const o2 = ctx.createOscillator();
        const tg = ctx.createGain();
        o1.type = 'triangle';
        o2.type = 'sine';
        o1.frequency.value = 180 + (opts.rim ? 40 : 0);
        o2.frequency.value = 330;
        tg.gain.setValueAtTime(0.0001, t0);
        tg.gain.exponentialRampToValueAtTime(0.55, t0 + 0.002);
        tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14 / stretch);
        o1.connect(tg); o2.connect(tg); tg.connect(out);
        o1.start(t0); o2.start(t0);
        o1.stop(t0 + 0.2); o2.stop(t0 + 0.2);

        // Noise crack + body
        const ns = ctx.createBufferSource();
        ns.buffer = this._noise(0.28);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = opts.clap ? 1600 : 2200;
        bp.Q.value = opts.clap ? 0.5 : 0.85;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 700;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t0);
        ng.gain.exponentialRampToValueAtTime(0.85, t0 + 0.0015);
        ng.gain.exponentialRampToValueAtTime(0.12, t0 + 0.05);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + (opts.clap ? 0.22 : 0.18) / stretch);
        ns.connect(bp); bp.connect(hp); hp.connect(ng); ng.connect(out);
        ns.start(t0);

        if (opts.clap) {
          // multi-flash clap
          [0.012, 0.024, 0.038].forEach((off, i) => {
            const n2 = ctx.createBufferSource();
            n2.buffer = this._noise(0.05);
            const g2 = ctx.createGain();
            g2.gain.setValueAtTime(0.35 * (1 - i * 0.2), t0 + off);
            g2.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.04);
            n2.connect(g2); g2.connect(out);
            n2.start(t0 + off);
          });
        }
      } else if (type === 'hat') {
        const ns = ctx.createBufferSource();
        ns.buffer = this._noise(open ? 0.45 : 0.12);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = open ? 7500 : 9000;
        bp.Q.value = 0.6;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = open ? 5000 : 7000;
        const ng = ctx.createGain();
        const end = open ? 0.32 : 0.045;
        ng.gain.setValueAtTime(0.0001, t0);
        ng.gain.exponentialRampToValueAtTime(0.55, t0 + 0.001);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + end / stretch);
        // metallic partials
        [1, 1.34, 1.77].forEach((m, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'square';
          o.frequency.value = 2800 * m;
          g.gain.setValueAtTime(0.04 / (i + 1), t0);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + end * 0.7);
          o.connect(g); g.connect(out);
          o.start(t0); o.stop(t0 + end + 0.02);
        });
        ns.connect(bp); bp.connect(hp); hp.connect(ng); ng.connect(out);
        ns.start(t0);
      } else if (type === 'perc') {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(420 + (opts.detune || 0), t0);
        o.frequency.exponentialRampToValueAtTime(90, t0 + 0.09);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.7, t0 + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2 / stretch);
        o.connect(g); g.connect(out);
        o.start(t0); o.stop(t0 + 0.25);
        const ns = ctx.createBufferSource();
        ns.buffer = this._noise(0.06);
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.25, t0);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);
        ns.connect(ng); ng.connect(out);
        ns.start(t0);
      } else if (type === 'melodic') {
        const base = (root / (opts.bass ? 2 : 1)) * Math.pow(2, (opts.detune || 0) / 12);
        const partials = opts.bass
          ? [{ f: 1, g: 0.7, type: 'sine' }, { f: 2, g: 0.2, type: 'sine' }]
          : [
              { f: 1, g: 0.35, type: 'sawtooth' },
              { f: 2, g: 0.18, type: 'sine' },
              { f: 3, g: 0.08, type: 'sine' },
            ];
        const filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.setValueAtTime(opts.bass ? 400 : 1400, t0);
        filt.frequency.exponentialRampToValueAtTime(opts.bass ? 180 : 500, t0 + 0.35);
        filt.Q.value = 1.1;
        const fg = ctx.createGain();
        fg.gain.setValueAtTime(0.0001, t0);
        fg.gain.exponentialRampToValueAtTime(0.9, t0 + 0.01);
        fg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.65 / stretch);
        filt.connect(fg); fg.connect(out);
        partials.forEach((p) => {
          const o = ctx.createOscillator();
          o.type = p.type;
          o.frequency.value = base * p.f * stretch;
          const g = ctx.createGain();
          g.gain.value = p.g;
          o.connect(g); g.connect(filt);
          o.start(t0); o.stop(t0 + 0.7);
        });
      } else {
        // loop stub — rhythmic layers
        const hits = [0, 0.11, 0.23, 0.34, 0.5, 0.61, 0.73, 0.84];
        hits.forEach((off, i) => {
          const isKick = i % 4 === 0;
          const isSnare = i % 4 === 2;
          if (isKick) this.playVoice('kick', { when: off, vel: vel * 0.85, level: opts.level });
          else if (isSnare) this.playVoice('snare', { when: off, vel: vel * 0.7, level: opts.level });
          else this.playVoice('hat', { when: off, vel: vel * 0.4, level: opts.level });
        });
        return;
      }
    }

    playBuffer(bufferId, opts = {}) {
      const buf = this.getBuffer(bufferId);
      if (!buf) return false;
      const ctx = this.ensure();
      const t0 = ctx.currentTime + (opts.when || 0);
      const vel = Math.max(0.05, Math.min(1.2, (opts.vel ?? 0.9) * (opts.level ?? 1)));
      const rate = Math.max(0.25, Math.min(4, opts.playbackRate || 1));

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;

      const g = ctx.createGain();
      // anti-click fade
      const fade = 0.003;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vel, t0 + fade);

      // light highpass for dark mud control on loops
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = opts.hp || 20;

      // subtle presence shelf
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 4000;
      shelf.gain.value = opts.presence || 1.5;

      src.connect(hp);
      hp.connect(shelf);
      shelf.connect(g);
      g.connect(this.input);

      const offset = Math.max(0, Math.min(buf.duration - 0.001, opts.offset || 0));
      let playDur = opts.duration != null ? opts.duration : (buf.duration - offset) / rate;
      playDur = Math.max(0.02, playDur);
      const endT = t0 + playDur;
      g.gain.setValueAtTime(vel, Math.max(t0 + fade, endT - 0.02));
      g.gain.exponentialRampToValueAtTime(0.0001, endT);
      src.start(t0, offset, playDur * rate + 0.02);
      return true;
    }

    playSample(sample, opts = {}) {
      if (!sample) return;
      const level = opts.level ?? 1;
      // pack sample not decoded yet → decode then play (first hit may be late once)
      if (sample.url && !(sample.bufferId && this.getBuffer(sample.bufferId))) {
        const id = sample.bufferId || sample.id;
        this.loadUrl(id, sample.url)
          .then(() => {
            sample.bufferId = id;
            this.playSample(sample, opts);
          })
          .catch(() => this.playVoice(sample.type, { ...opts, level, name: sample.name }));
        return;
      }
      if (sample.bufferId && this.getBuffer(sample.bufferId)) {
        let rate = 1;
        const stretch = sample.stretch || opts.stretch || 1;
        if (sample.bpm && sample.bpm > 0 && stretch && stretch !== 1) rate = stretch;
        if (sample.chopStart != null && sample.chopEnd != null) {
          const buf = this.getBuffer(sample.bufferId);
          const start = sample.chopStart * buf.duration;
          const end = sample.chopEnd * buf.duration;
          this.playBuffer(sample.bufferId, {
            ...opts,
            level,
            offset: start,
            duration: Math.max(0.02, end - start),
            playbackRate: rate,
            presence: sample.type === 'hat' ? 3 : 1.5,
          });
          return;
        }
        this.playBuffer(sample.bufferId, {
          ...opts,
          level,
          playbackRate: rate,
          presence: sample.type === 'loop' ? 2 : 1.2,
        });
        return;
      }
      const name = sample.name || '';
      this.playVoice(sample.type, {
        ...opts,
        level,
        name,
        open: /open/i.test(name),
        clap: /clap/i.test(name),
        rim: /rim/i.test(name),
        hard: /hard|909/i.test(name),
        bass: /bass|sub/i.test(name) || sample.tags?.includes('bass'),
        key: sample.key !== '—' ? sample.key : opts.key,
        stretch: sample.stretch || opts.stretch || 1,
      });
    }

    _runMeter() {
      const data = new Uint8Array(this.analyser.fftSize);
      const tick = () => {
        this.analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        this.meter.l = peak;
        this.meter.r = peak * (0.88 + Math.random() * 0.12);
        requestAnimationFrame(tick);
      };
      tick();
    }
  }

  function emptyPattern(len = 16, tracks = 16) {
    return {
      id: 'A1',
      length: len,
      tracks: Array.from({ length: tracks }, () => Array(len).fill(0)),
    };
  }

  class Project {
    constructor() {
      this.bpm = 92;
      this.key = 'Am';
      this.swing = 58;
      this.bank = 'A';
      this.patternId = 'A1';
      this.library = CATALOG.map((s) => ({
        ...s,
        stretch: s.bpm && s.bpm !== 92 ? +(92 / s.bpm).toFixed(3) : 1,
      }));
      this.pads = Array(16).fill(null);
      this.levels = Array(16).fill(0.85);
      this.muted = Array(16).fill(false);
      this.solo = Array(16).fill(false);
      this.patterns = {
        A1: emptyPattern(16),
        A2: emptyPattern(16),
        B1: emptyPattern(16),
      };
      this.patterns.A1.id = 'A1';
      this.patterns.A2.id = 'A2';
      this.patterns.B1.id = 'B1';
      this.arrangement = Array(8).fill(null);
      this.selectedPad = 0;
      this.selectedSampleId = null;
      this.chops = [];
      this.chopMeta = null;
      this.mode = 'perform';
      this.patternLength = 16;
      this.listeners = new Set();
      this.engine = null;
      this._idSeq = 0;
    }

    attachEngine(engine) { this.engine = engine; return this; }
    nextId(prefix = 's') { this._idSeq += 1; return `${prefix}_${Date.now().toString(36)}_${this._idSeq}`; }
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type, detail) { this.listeners.forEach((fn) => fn({ type, detail, project: this })); }
    get pattern() { return this.patterns[this.patternId]; }
    findSample(id) { return this.library.find((s) => s.id === id) || null; }

    isAudible(pad) {
      const anySolo = this.solo.some(Boolean);
      if (anySolo) return this.solo[pad] && !this.muted[pad];
      return !this.muted[pad];
    }

    set_bpm(n) {
      this.bpm = Math.max(40, Math.min(220, Math.round(n)));
      this.library.forEach((s) => {
        if (s.bpm && s.bpm > 0) s.stretch = +(this.bpm / s.bpm).toFixed(3);
      });
      this.pads.forEach((p) => {
        if (p && p.bpm && p.bpm > 0) p.stretch = +(this.bpm / p.bpm).toFixed(3);
      });
      this.emit('bpm', this.bpm);
      return { bpm: this.bpm };
    }
    set_key(k) { this.key = k; this.emit('key', k); return { key: k }; }
    set_swing(n) {
      this.swing = Math.max(50, Math.min(75, Math.round(n)));
      this.emit('swing', this.swing);
      return { swing: this.swing };
    }
    set_level(pad, v) {
      this.levels[pad] = Math.max(0, Math.min(1, v));
      this.emit('mix');
      return { pad, level: this.levels[pad] };
    }
    toggle_mute(pad) {
      this.muted[pad] = !this.muted[pad];
      this.emit('mix');
      return { pad, muted: this.muted[pad] };
    }
    toggle_solo(pad) {
      this.solo[pad] = !this.solo[pad];
      this.emit('mix');
      return { pad, solo: this.solo[pad] };
    }

    assign_pad(padIndex, sampleId) {
      const s = this.findSample(sampleId);
      if (!s) throw new Error('sample_not_found:' + sampleId);
      const copy = { ...s };
      if (copy.bpm && copy.bpm > 0) copy.stretch = +(this.bpm / copy.bpm).toFixed(3);
      this.pads[padIndex] = copy;
      this.selectedPad = padIndex;
      this.emit('pads');
      return { pad: padIndex, sample: copy.name, stretch: copy.stretch };
    }
    clear_pads() {
      this.pads = Array(16).fill(null);
      this.emit('pads');
      return { ok: true };
    }
    /** Merge scanner _index.json (pack samples) into the library. Idempotent. */
    addPackIndex(index) {
      const packs = index?.packs || [];
      const rows = index?.samples || [];
      this.packs = packs;
      let added = 0;
      rows.forEach((r) => {
        if (this.findSample(r.id)) return;
        const bpm = r.bpm || 0;
        this.library.push({
          id: r.id,
          name: r.name,
          type: r.type || 'perc',
          bpm,
          key: '—',
          tags: r.tags || ['real'],
          energy: 0.7,
          stretch: bpm > 0 ? +(this.bpm / bpm).toFixed(3) : 1,
          bufferId: r.id,
          url: r.path, // loadUrl encodes segments; keep raw path for display/debug
          duration: r.duration || null,
          size: r.size || 0,
          pack: r.pack,
          real: true,
          rateStretch: bpm > 0,
        });
        added++;
      });
      this.emit('library');
      return { added, packs: packs.length, total: this.library.length };
    }

    _pickReal(type, scoreFn, packSlug) {
      let best = null;
      let bestScore = -1;
      this.library.forEach((s) => {
        if (!s.real || s.type !== type) return;
        if (packSlug && s.pack !== packSlug) return;
        const sc = scoreFn ? scoreFn(s) : 0;
        if (sc > bestScore) { bestScore = sc; best = s; }
      });
      return best;
    }

    fill_pads_kit(style = 'dusty') {
      this.clear_pads();
      const tagScore = (want, avoid = []) => (s) => {
        let sc = 0;
        (s.tags || []).forEach((t) => {
          if (want.includes(t)) sc += 2;
          if (avoid.includes(t)) sc -= 2;
        });
        return sc;
      };
      const scorers = {
        dusty: tagScore(['dusty', 'analog', 'room', 'dry'], ['house', 'hard']),
        hard: tagScore(['hard', 'analog', 'dry'], ['dusty']),
        house: tagScore(['house', 'dry'], ['dusty', 'hard']),
        halftime: tagScore(['hard', 'dry', 'sub'], ['house']),
      };
      const score = scorers[style] || scorers.dusty;
      const synthPick = (type, tag) =>
        this.library.find((s) => !s.real && s.type === type && (!tag || s.tags.includes(tag))) ||
        this.library.find((s) => !s.real && s.type === type);
      const pick = (type, tag) =>
        this._pickReal(type, score) || synthPick(type, tag);
      const realHat = (kind) =>
        this._pickReal('hat', (s) =>
          (kind === 'open' ? (s.tags.includes('open') ? 4 : -4) : s.tags.includes('closed') ? 4 : 0) + score(s));
      const map = [
        [0, pick('kick')],
        [1, this._pickReal('kick', score) || synthPick('kick', 'sub')],
        [2, pick('snare')],
        [3, this._pickReal('snare', (s) => (s.tags.includes('clap') ? 4 : 0) + score(s)) || synthPick('snare', 'clap')],
        [4, realHat('closed') || pick('hat')],
        [5, realHat('open') || synthPick('hat', 'open')],
        [6, pick('perc')],
        [7, this._pickReal('perc', score) || synthPick('perc', 'conga')],
        [8, this._pickReal('melodic', (s) => (s.tags.includes('bass') || s.tags.includes('sub') ? 4 : 0) + score(s)) || synthPick('melodic', 'bass')],
        [9, this._pickReal('loop', score) || pick('loop', 'break')],
        [10, this._pickReal('melodic', score) || synthPick('melodic', 'keys')],
        [11, this._pickReal('loop', score) || synthPick('loop', 'pad')],
      ];
      const placed = [];
      const used = [];
      const seen = new Set();
      map.forEach(([i, s]) => {
        if (s && s.real && seen.has(s.id)) {
          const alt = this.library.find((x) => x.real && x.type === s.type && !seen.has(x.id));
          if (alt) s = alt;
        }
        if (s) {
          seen.add(s.id);
          this.assign_pad(i, s.id);
          placed.push(`P${i + 1}=${s.name}`);
          if (s.url) used.push(s);
        }
      });
      if (this.engine && used.length) this.engine.preload(used);
      const realCount = this.pads.filter((p) => p && p.real).length;
      return { placed, style, real: realCount };
    }

    /** Load a playable kit from ONE pack (browser/mission entry point). */
    load_pack_kit(slug) {
      const pack = slug || (this.packs && this.packs[0] && this.packs[0].slug);
      if (!pack) throw new Error('no_packs');
      const inPack = (type) => this._pickReal(type, null, pack);
      const hatBy = (kind) =>
        this._pickReal('hat', (s) =>
          kind === 'open' ? (s.tags.includes('open') ? 4 : -4) : s.tags.includes('closed') ? 4 : 0) ||
        inPack('hat');
      const slots = {
        0: inPack('kick'), 1: inPack('kick'),
        2: inPack('snare'), 3: inPack('snare'),
        4: hatBy('closed'), 5: hatBy('open'),
        6: inPack('perc'), 7: inPack('perc'),
        8: inPack('melodic'), 9: inPack('loop'),
        10: inPack('melodic'), 11: inPack('loop'),
      };
      // de-dupe: avoid the same sample twice in a row if alternatives exist
      const seen = new Set();
      Object.keys(slots).forEach((k) => {
        const s = slots[k];
        if (s && seen.has(s.id)) {
          const alt = this.library.find((x) => x.real && x.pack === pack && x.type === s.type && !seen.has(x.id));
          slots[k] = alt || s;
        }
        if (slots[k]) seen.add(slots[k].id);
      });
      const placed = [];
      const used = [];
      Object.entries(slots).forEach(([i, s]) => {
        if (s) {
          this.assign_pad(+i, s.id);
          placed.push(`P${+i + 1}=${s.name}`);
          if (s.url) used.push(s);
        }
      });
      if (this.engine && used.length) this.engine.preload(used);
      if (!placed.length) throw new Error('pack_empty:' + pack);
      return { pack, placed, count: placed.length };
    }

    list_packs() {
      return (this.packs || []).map((p) => ({ slug: p.slug, name: p.name, count: p.count }));
    }


    set_step(pad, step, vel = 1) {
      const p = this.pattern;
      if (!p.tracks[pad] || step >= p.length) throw new Error('step_oob');
      p.tracks[pad][step] = vel ? Math.min(1, Math.max(0.1, vel)) : 0;
      this.emit('pattern');
      return { pad, step, vel: p.tracks[pad][step] };
    }
    clear_pattern(id) {
      const p = this.patterns[id || this.patternId];
      p.tracks = p.tracks.map(() => Array(p.length).fill(0));
      this.emit('pattern');
      return { pattern: p.id };
    }
    write_groove(name = 'boom_bap') {
      if (!this.pads[0]) this.fill_pads_kit('dusty');
      const p = this.pattern;
      p.tracks = p.tracks.map(() => Array(p.length).fill(0));
      const on = (pad, steps, vel = 1) => steps.forEach((s) => { p.tracks[pad][s] = vel; });
      if (name === 'boom_bap' || name === 'boom bap') {
        on(0, [0, 7, 10], 1);
        on(1, [10], 0.75);
        on(2, [4, 12], 1);
        on(3, [4, 11, 12, 14], 0.5);
        on(4, [0, 2, 4, 6, 8, 10, 12, 14], 0.72);
        on(4, [1, 5, 9, 13], 0.32);
        on(5, [6, 14], 0.55);
        on(6, [0, 4, 8, 12], 0.4);
        if (this.pads[8]) on(8, [0, 8], 0.88);
      } else if (name === 'halftime' || name === 'half time') {
        on(0, [0, 8], 1);
        on(2, [8], 1);
        on(4, [0, 4, 8, 12], 0.48);
        on(6, [2, 6, 10, 14], 0.42);
        if (this.pads[8]) on(8, [0], 0.9);
      } else if (name === 'four_on_floor' || name === 'four on floor') {
        on(0, [0, 4, 8, 12], 1);
        on(2, [4, 12], 0.9);
        on(4, Array.from({ length: 16 }, (_, i) => i), 0.5);
      } else {
        on(0, [0, 8], 1);
        on(2, [4, 12], 1);
        on(4, [0, 4, 8, 12], 0.55);
      }
      this.emit('pattern');
      return { groove: name, pattern: p.id };
    }

    set_arrangement_bar(bar, patternId) {
      if (bar < 0 || bar > 7) throw new Error('bar_oob');
      if (patternId && !this.patterns[patternId]) throw new Error('pat_missing');
      this.arrangement[bar] = patternId || null;
      this.emit('arrange');
      return { bar, patternId: this.arrangement[bar] };
    }
    build_drop_form() {
      const form = ['A1', 'A1', 'A2', 'A1', 'B1', 'B1', 'A1', 'A2'];
      const cur = this.patternId;
      this.patternId = 'A2';
      this.write_groove('boom_bap');
      this.pattern.tracks[0][6] = 0.85;
      this.pattern.tracks[2][14] = 0.75;
      this.patternId = 'B1';
      this.write_groove('halftime');
      this.patternId = cur;
      form.forEach((id, i) => { this.arrangement[i] = id; });
      this.emit('arrange');
      this.emit('pattern');
      return { form };
    }

    import_sample(payload) {
      const { name, bufferId, analysis } = payload || {};
      if (!name || !bufferId || !analysis) throw new Error('import_requires_name_buffer_analysis');
      const id = this.nextId('imp');
      const bpm = analysis.bpm || 0;
      const sample = {
        id,
        name: name.replace(/\.[^.]+$/, ''),
        type: analysis.type || 'perc',
        bpm,
        key: analysis.key || '—',
        tags: [...(analysis.tags || []), 'user', 'real'],
        energy: analysis.energy || 0.5,
        stretch: bpm > 0 ? +(this.bpm / bpm).toFixed(3) : 1,
        bufferId,
        duration: analysis.duration,
        onsets: analysis.onsets || [],
        waveform: analysis.waveform || null,
        features: analysis.features || null,
        bpmConfidence: analysis.bpmConfidence,
        real: true,
      };
      this.library.unshift(sample);
      this.selectedSampleId = id;
      this.emit('library');
      return {
        id, name: sample.name, type: sample.type, bpm: sample.bpm,
        stretch: sample.stretch, onsets: (sample.onsets || []).length, duration: sample.duration,
      };
    }

    detect_onsets(sampleId) {
      const s = this.findSample(sampleId) || this.pads[this.selectedPad];
      if (!s) throw new Error('no_sample');
      this.selectedSampleId = s.id;
      if (s.onsets && s.onsets.length) {
        this.chops = s.onsets.slice();
        this.chopMeta = { sample: s.name, source: 'stored', bpm: s.bpm };
        this.emit('chops');
        return { sample: s.name, chops: this.chops, bpm: s.bpm, source: 'stored' };
      }
      if (s.bufferId && this.engine && global.LoopTischAnalyze) {
        const buf = this.engine.getBuffer(s.bufferId);
        if (buf) {
          const a = global.LoopTischAnalyze.analyzeAudioBuffer(buf, { name: s.name });
          s.onsets = a.onsets;
          s.waveform = a.waveform;
          if (a.bpm && !s.bpm) {
            s.bpm = a.bpm;
            s.stretch = +(this.bpm / a.bpm).toFixed(3);
          }
          this.chops = a.onsets.slice();
          this.chopMeta = { sample: s.name, source: 'reanalyze', bpm: a.bpm };
          this.emit('chops');
          return { sample: s.name, chops: this.chops, bpm: a.bpm, source: 'reanalyze' };
        }
      }
      const n = s.type === 'loop' ? 8 : 4;
      this.chops = Array.from({ length: n }, (_, i) => +(i / n).toFixed(3));
      this.chopMeta = { sample: s.name, source: 'synthetic' };
      this.emit('chops');
      return { sample: s.name, chops: this.chops, source: 'synthetic' };
    }

    map_chops_to_pads(startPad = 8) {
      const src = this.findSample(this.selectedSampleId) || this.library.find((x) => x.type === 'loop');
      if (!src) throw new Error('no_loop');
      if (!this.chops.length) this.detect_onsets(src.id);
      const chops = this.chops;
      let mapped = 0;
      for (let i = 0; i < chops.length; i++) {
        const idx = startPad + i;
        if (idx > 15) break;
        const start = chops[i];
        const end = i + 1 < chops.length ? chops[i + 1] : Math.min(1, start + 0.12);
        const chopId = src.id + '_chop' + i;
        if (src.bufferId && this.engine && global.LoopTischAnalyze) {
          const full = this.engine.getBuffer(src.bufferId);
          if (full) {
            const sliced = global.LoopTischAnalyze.sliceBuffer(this.engine.ensure(), full, start, end);
            this.engine.storeBuffer(chopId, sliced);
          }
        }
        const hasSlice = this.engine && this.engine.getBuffer(chopId);
        const entry = {
          ...src,
          id: chopId,
          name: `${src.name}_c${i + 1}`,
          type: src.type === 'loop' ? 'perc' : src.type,
          tags: [...(src.tags || []).filter((t) => t !== 'loop'), 'chop'],
          chopStart: hasSlice ? undefined : start,
          chopEnd: hasSlice ? undefined : end,
          bufferId: hasSlice ? chopId : src.bufferId,
          stretch: src.bpm ? +(this.bpm / src.bpm).toFixed(3) : 1,
          real: !!src.real,
        };
        if (!this.findSample(chopId)) this.library.unshift(entry);
        this.pads[idx] = entry;
        mapped++;
      }
      this.emit('pads');
      this.emit('library');
      return { mapped, startPad };
    }

    apply_stretch(padIndex, mode = 'project') {
      const p = this.pads[padIndex];
      if (!p) throw new Error('empty_pad');
      if (mode === 'project' && p.bpm) p.stretch = +(this.bpm / p.bpm).toFixed(3);
      else p.stretch = 1;
      this.emit('pads');
      return { pad: padIndex, stretch: p.stretch };
    }
    search_library(q) {
      const t = String(q || '').toLowerCase();
      const hits = this.library.filter((s) =>
        !t || s.name.toLowerCase().includes(t) || s.type.includes(t) ||
        s.tags.some((x) => x.includes(t)) || s.key.toLowerCase().includes(t)
      );
      return { count: hits.length, ids: hits.map((h) => h.id) };
    }
    coach_fix_thin() {
      if (!this.pads[0]) this.fill_pads_kit();
      const sub = this.library.find((s) => s.tags.includes('sub'));
      if (sub) this.assign_pad(1, sub.id);
      const clap = this.library.find((s) => s.tags.includes('clap'));
      if (clap) this.assign_pad(3, clap.id);
      this.levels[0] = Math.max(this.levels[0], 0.95);
      this.levels[1] = Math.max(this.levels[1], 0.9);
      this.levels[2] = Math.max(this.levels[2], 0.92);
      const p = this.pattern;
      if (!p.tracks[0].some(Boolean)) this.write_groove('boom_bap');
      p.tracks[0] = p.tracks[0].map((v) => (v ? Math.max(v, 0.95) : v));
      p.tracks[2] = p.tracks[2].map((v) => (v ? 1 : v));
      this.emit('pattern');
      this.emit('mix');
      return {
        diagnosis: 'Zu wenig Sub + Snare-Körper.',
        fixes: ['Sub-Kick P2', 'Clap P4', 'Levels angehoben'],
      };
    }
    export_summary() {
      const used = this.pads.filter(Boolean).map((p) => p.name);
      return {
        project: `looptisch_${this.bpm}bpm_${this.key}`,
        bpm: this.bpm, key: this.key, pads: used,
        patterns: Object.keys(this.patterns), arrangement: this.arrangement,
        stems: used.map((n) => `${n}.wav`),
        note: 'Prototype: bounce metadata-only.',
      };
    }
    snapshot_for_llm() {
      return {
        bpm: this.bpm, key: this.key, swing: this.swing, patternId: this.patternId,
        selectedPad: this.selectedPad,
        library: this.library.slice(0, 40).map((s) => ({
          id: s.id, name: s.name, type: s.type, bpm: s.bpm, key: s.key, tags: s.tags, real: !!s.real,
        })),
        pads: this.pads.map((p, i) =>
          p ? { pad: i, id: p.id, name: p.name, type: p.type, muted: this.muted[i], level: this.levels[i] }
            : { pad: i, empty: true }
        ),
        arrangement: this.arrangement,
      };
    }
    exec_tool(name, args = {}) {
      const a = args || {};
      switch (name) {
        case 'set_bpm': return this.set_bpm(a.n ?? a.bpm);
        case 'set_key': return this.set_key(a.k ?? a.key);
        case 'set_swing': return this.set_swing(a.n ?? a.swing);
        case 'assign_pad': return this.assign_pad(a.padIndex ?? a.pad, a.sampleId ?? a.id);
        case 'clear_pads': return this.clear_pads();
        case 'fill_pads_kit': return this.fill_pads_kit(a.style || 'dusty');
        case 'set_step': return this.set_step(a.pad, a.step, a.vel ?? 1);
        case 'clear_pattern': return this.clear_pattern(a.id);
        case 'write_groove': return this.write_groove(a.name || a.groove || 'boom_bap');
        case 'set_arrangement_bar': return this.set_arrangement_bar(a.bar, a.patternId);
        case 'build_drop_form': return this.build_drop_form();
        case 'detect_onsets': return this.detect_onsets(a.sampleId || a.id);
        case 'map_chops_to_pads': return this.map_chops_to_pads(a.startPad ?? a.start ?? 8);
        case 'apply_stretch': return this.apply_stretch(a.padIndex ?? a.pad, a.mode || 'project');
        case 'search_library': return this.search_library(a.q || a.query || '');
        case 'coach_fix_thin': return this.coach_fix_thin();
        case 'export_summary': return this.export_summary();
        case 'list_library':
          return { items: this.library.slice(0, 30).map((s) => ({ id: s.id, name: s.name, type: s.type, bpm: s.bpm, real: !!s.real })) };
        case 'get_project_state': return this.snapshot_for_llm();
        case 'toggle_mute': return this.toggle_mute(a.pad ?? a.padIndex ?? 0);
        case 'set_level': return this.set_level(a.pad ?? a.padIndex ?? 0, a.level ?? a.v ?? 0.85);
        case 'load_pack_kit': return this.load_pack_kit(a.pack || a.slug || a.name);
        case 'list_packs': return { packs: this.list_packs() };
        default: throw new Error('unknown_tool:' + name);
      }
    }
  }

  class Transport {
    constructor(project, engine) {
      this.project = project;
      this.engine = engine;
      this.playing = false;
      this.recording = false;
      this.step = 0;
      this.bar = 0;
      this.timer = null;
      this.startedAt = 0;
      this.onTick = null;
    }
    stepMs() { return (60 / this.project.bpm / 4) * 1000; }
    swingOffset(stepIndex) {
      if (stepIndex % 2 === 1) {
        const amount = (this.project.swing - 50) / 50;
        return this.stepMs() * amount * 0.55;
      }
      return 0;
    }
    currentPatternId() {
      if (this.project.arrangement.some(Boolean) && this.project.arrangement[this.bar]) {
        return this.project.arrangement[this.bar];
      }
      return this.project.patternId;
    }
    playSteps(stepIndex) {
      const pat = this.project.patterns[this.currentPatternId()];
      if (!pat) return;
      for (let pad = 0; pad < 16; pad++) {
        const vel = pat.tracks[pad][stepIndex];
        if (vel && this.project.pads[pad] && this.project.isAudible(pad)) {
          this.engine.playSample(this.project.pads[pad], {
            vel,
            key: this.project.key,
            level: this.project.levels[pad],
            stretch: this.project.pads[pad].stretch || 1,
          });
        }
      }
    }
    scheduleNext() {
      if (!this.playing) return;
      const delay = this.stepMs() + this.swingOffset(this.step);
      this.timer = setTimeout(() => {
        this.playSteps(this.step);
        if (this.onTick) this.onTick(this.step, this.bar, this.currentPatternId());
        this.step += 1;
        if (this.step >= this.project.patternLength) {
          this.step = 0;
          if (this.project.arrangement.some(Boolean)) this.bar = (this.bar + 1) % 8;
        }
        this.scheduleNext();
      }, delay);
    }
    start() {
      this.engine.ensure();
      this.playing = true;
      this.step = 0;
      this.bar = 0;
      this.startedAt = performance.now();
      this.playSteps(0);
      if (this.onTick) this.onTick(0, 0, this.currentPatternId());
      this.step = 1;
      this.scheduleNext();
    }
    stop() {
      this.playing = false;
      clearTimeout(this.timer);
      this.step = 0;
      this.bar = 0;
      if (this.onTick) this.onTick(0, 0, this.currentPatternId());
    }
    toggle() {
      if (this.playing) this.stop();
      else this.start();
      return this.playing;
    }
  }

  class AgentRuntime {
    constructor(project) {
      this.project = project;
      this.log = [];
    }
    tool(name, args, fn) {
      const entry = { t: Date.now(), name, args, ok: true, result: null, error: null };
      try { entry.result = fn(); }
      catch (e) { entry.ok = false; entry.error = String(e.message || e); }
      this.log.push(entry);
      if (this.log.length > 200) this.log.shift();
      return entry;
    }
    run(text, agentHint) {
      const raw = String(text || '').trim();
      const q = raw.toLowerCase();
      const calls = [];
      const say = [];
      const agent = agentHint || this.inferAgent(q);
      const T = (name, args, fn) => { const e = this.tool(name, args, fn); calls.push(e); return e; };

      if (/export|stem|bounce/.test(q)) {
        const r = T('export_summary', {}, () => this.project.export_summary());
        say.push(`${agent}: ${r.result.project}`);
        return { agent, calls, say };
      }
      if (/thin|dünn|fix thin|warum/.test(q)) {
        const r = T('coach_fix_thin', {}, () => this.project.coach_fix_thin());
        say.push(`${agent}: ${r.result.diagnosis}`);
        return { agent, calls, say };
      }
      if (/half\s*time|halftime|dunkl|darker/.test(q)) {
        T('set_swing', { n: 62 }, () => this.project.set_swing(62));
        T('write_groove', { name: 'halftime' }, () => this.project.write_groove('halftime'));
        say.push(`${agent}: Halftime · Swing 62`);
        return { agent, calls, say };
      }
      if (/drop|8 bar|form|arrang/.test(q)) {
        if (!this.project.pads[0]) T('fill_pads_kit', { style: 'dusty' }, () => this.project.fill_pads_kit('dusty'));
        T('write_groove', { name: 'boom_bap' }, () => this.project.write_groove('boom_bap'));
        const r = T('build_drop_form', {}, () => this.project.build_drop_form());
        say.push(`${agent}: Form ${r.result.form.join('→')}`);
        return { agent, calls, say };
      }
      if (/chop|onset|slice|schneid/.test(q)) {
        const loop = this.project.library.find((s) => s.type === 'loop');
        if (loop) T('detect_onsets', { id: loop.id }, () => this.project.detect_onsets(loop.id));
        const r = T('map_chops_to_pads', { start: 8 }, () => this.project.map_chops_to_pads(8));
        say.push(`${agent}: ${r.result.mapped} chops mapped`);
        return { agent, calls, say };
      }
      if (/clear pad|pads leer/.test(q)) {
        T('clear_pads', {}, () => this.project.clear_pads());
        say.push(`${agent}: pads cleared`);
        return { agent, calls, say };
      }
      if (/swing/.test(q)) {
        const m = q.match(/(\d{2})/);
        const n = m ? +m[1] : 62;
        T('set_swing', { n }, () => this.project.set_swing(n));
        say.push(`${agent}: swing ${n}`);
        return { agent, calls, say };
      }
      if (/boom|bap|groove|kit|dusty|füll|fill|scan|retag/.test(q) || agent === 'Librarian' || agent === 'Arranger') {
        if (/kit|dusty|füll|fill|scan|retag|librarian/.test(q) || agent === 'Librarian') {
          T('fill_pads_kit', { style: /hard/.test(q) ? 'hard' : 'dusty' }, () =>
            this.project.fill_pads_kit(/hard/.test(q) ? 'hard' : 'dusty'));
          say.push(`${agent}: kit loaded`);
        }
        if (/boom|bap|groove|pattern|arranger/.test(q) || agent === 'Arranger') {
          T('write_groove', { name: 'boom_bap' }, () => this.project.write_groove('boom_bap'));
          say.push(`${agent}: boom bap on ${this.project.patternId}`);
        }
        if (!say.length) {
          T('fill_pads_kit', { style: 'dusty' }, () => this.project.fill_pads_kit('dusty'));
          say.push(`${agent}: kit loaded`);
        }
        return { agent, calls, say };
      }
      say.push(`${agent}: try dusty kit · boom bap · chop break · build drop · fix thin`);
      return { agent, calls, say };
    }
    inferAgent(q) {
      if (/chop|slice|onset/.test(q)) return 'Chopper';
      if (/arrang|drop|form|groove|boom|pattern/.test(q)) return 'Arranger';
      if (/remix|half|dark/.test(q)) return 'Remixer';
      if (/thin|warum|coach|fix/.test(q)) return 'Coach';
      if (/export|stem|bounce/.test(q)) return 'Export';
      return 'Librarian';
    }
  }

  function synthWaveform(sample) {
    const n = 512;
    const data = new Float32Array(n);
    const seed = (sample?.name || 'x').split('').reduce((a, c) => a + c.charCodeAt(0), 1);
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; return (s & 0xffff) / 0xffff; };
    for (let i = 0; i < n; i++) {
      const env = Math.sin((i / n) * Math.PI);
      data[i] = (rnd() * 2 - 1) * env * 0.7;
    }
    return { data, chops: [] };
  }

  global.LoopTisch = {
    AudioEngine, Project, Transport, AgentRuntime, CATALOG, synthWaveform, emptyPattern,
  };
})(window);
