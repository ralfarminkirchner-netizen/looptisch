/**
 * LOOPTiSCH Cooperative layer
 * Undo history · Missions · Plan execution · human gates
 */
(function (global) {
  'use strict';

  function cloneTracks(patterns) {
    const out = {};
    Object.keys(patterns).forEach((id) => {
      const p = patterns[id];
      out[id] = {
        id: p.id,
        length: p.length,
        tracks: p.tracks.map((row) => row.slice()),
      };
    });
    return out;
  }

  class History {
    constructor(project) {
      this.project = project;
      this.undoStack = [];
      this.redoStack = [];
      this.max = 50;
    }

    capture(label = '') {
      const p = this.project;
      return {
        label,
        t: Date.now(),
        bpm: p.bpm,
        key: p.key,
        swing: p.swing,
        patternId: p.patternId,
        selectedPad: p.selectedPad,
        selectedSampleId: p.selectedSampleId,
        levels: p.levels.slice(),
        muted: p.muted.slice(),
        solo: p.solo.slice(),
        arrangement: p.arrangement.slice(),
        patterns: cloneTracks(p.patterns),
        padIds: p.pads.map((x) => (x ? x.id : null)),
        chops: (p.chops || []).slice(),
        chopMeta: p.chopMeta ? { ...p.chopMeta } : null,
      };
    }

    restore(snap) {
      const p = this.project;
      p.bpm = snap.bpm;
      p.key = snap.key;
      p.swing = snap.swing;
      p.patternId = snap.patternId;
      p.selectedPad = snap.selectedPad;
      p.selectedSampleId = snap.selectedSampleId;
      p.levels = snap.levels.slice();
      p.muted = snap.muted.slice();
      p.solo = snap.solo.slice();
      p.arrangement = snap.arrangement.slice();
      // patterns
      Object.keys(snap.patterns).forEach((id) => {
        if (!p.patterns[id]) return;
        p.patterns[id].length = snap.patterns[id].length;
        p.patterns[id].tracks = snap.patterns[id].tracks.map((row) => row.slice());
      });
      // pads by id from library (or keep chop entries in library)
      p.pads = snap.padIds.map((id) => {
        if (!id) return null;
        const found = p.findSample(id);
        if (found) return { ...found };
        return null;
      });
      p.chops = (snap.chops || []).slice();
      p.chopMeta = snap.chopMeta;
      // refresh stretches
      p.library.forEach((s) => {
        if (s.bpm && s.bpm > 0) s.stretch = +(p.bpm / s.bpm).toFixed(3);
      });
      p.pads.forEach((s) => {
        if (s && s.bpm && s.bpm > 0) s.stretch = +(p.bpm / s.bpm).toFixed(3);
      });
      p.emit('restore');
      p.emit('pads');
      p.emit('pattern');
      p.emit('mix');
      p.emit('arrange');
    }

    push(label) {
      this.undoStack.push(this.capture(label));
      if (this.undoStack.length > this.max) this.undoStack.shift();
      this.redoStack = [];
      return this.undoStack.length;
    }

    undo() {
      if (!this.undoStack.length) return null;
      this.redoStack.push(this.capture('redo-point'));
      const snap = this.undoStack.pop();
      this.restore(snap);
      return snap;
    }

    redo() {
      if (!this.redoStack.length) return null;
      this.undoStack.push(this.capture('undo-point'));
      const snap = this.redoStack.pop();
      this.restore(snap);
      return snap;
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
  }

  /** Built-in missions — cooperative recipes for laypeople */
  const MISSIONS = [
    {
      id: 'first_beat',
      title: 'First Beat',
      blurb: 'Kit + Groove + Play — in 10 Sekunden hörbar',
      icon: '▶',
      risk: 'S1',
      build() {
        return {
          mission: 'first_beat',
          say: 'Ich lade ein Dusty Kit und schreibe einen Boom-Bap-Groove. Danach einfach Play.',
          agent: 'Host',
          steps: [
            { tool: 'fill_pads_kit', args: { style: 'dusty' }, why: 'Pads mit Kit füllen', risk: 'S1' },
            { tool: 'write_groove', args: { name: 'boom_bap' }, why: 'Grundgroove', risk: 'S0' },
            { tool: 'set_swing', args: { n: 58 }, why: 'Leichter Swing', risk: 'S0' },
          ],
        };
      },
    },
    {
      id: 'break_to_kit',
      title: 'Break → Kit',
      blurb: 'Loop analysieren, choppen, auf Pads legen, Groove',
      icon: '✂',
      risk: 'S1',
      build() {
        return {
          mission: 'break_to_kit',
          say: 'Break finden/choppen und zu spielbaren Pads machen.',
          agent: 'Chopper',
          steps: [
            { tool: 'fill_pads_kit', args: { style: 'dusty' }, why: 'Basis-Drums falls leer', risk: 'S1' },
            { tool: 'detect_onsets', args: {}, why: 'Transienten finden', risk: 'S0' },
            { tool: 'map_chops_to_pads', args: { startPad: 8 }, why: 'Chops → P9–P16', risk: 'S1' },
            { tool: 'write_groove', args: { name: 'boom_bap' }, why: 'Sofort spielbarer Groove', risk: 'S0' },
          ],
        };
      },
    },
    {
      id: 'drop_builder',
      title: 'Drop Builder',
      blurb: '8-Bar Songform mit Breakdown',
      icon: '▣',
      risk: 'S1',
      build() {
        return {
          mission: 'drop_builder',
          say: 'Ich baue eine 8-Bar-Form mit Drop und Breakdown.',
          agent: 'Arranger',
          steps: [
            { tool: 'write_groove', args: { name: 'boom_bap' }, why: 'Main groove A1', risk: 'S0' },
            { tool: 'build_drop_form', args: {}, why: 'A1/A2/B1 Form', risk: 'S1' },
          ],
        };
      },
    },
    {
      id: 'genre_skin',
      title: 'Genre Skin',
      blurb: 'Wähle Feel — wir stellen Groove, Swing, Drive',
      icon: '◎',
      risk: 'S2',
      build() {
        return {
          mission: 'genre_skin',
          say: 'Welche Richtung? Wähle eine Option — ich stelle Groove & Feel.',
          agent: 'Remixer',
          steps: [],
          options: [
            {
              id: 'boom',
              label: 'Boom-Bap',
              blurb: 'Dusty · Swing 58 · klassischer Kick/Snare',
              steps: [
                { tool: 'fill_pads_kit', args: { style: 'dusty' }, why: 'Dusty kit', risk: 'S1' },
                { tool: 'set_swing', args: { n: 58 }, why: 'Head-nod swing', risk: 'S0' },
                { tool: 'write_groove', args: { name: 'boom_bap' }, why: 'Classic pocket', risk: 'S0' },
                { tool: 'apply_genre', args: { genre: 'boom_bap' }, why: 'Levels & drive', risk: 'S0' },
              ],
            },
            {
              id: 'house',
              label: 'House',
              blurb: 'Four-on-floor · gerader · treibend',
              steps: [
                { tool: 'fill_pads_kit', args: { style: 'hard' }, why: 'Punch kit', risk: 'S1' },
                { tool: 'set_bpm', args: { n: 124 }, why: 'House tempo', risk: 'S0' },
                { tool: 'set_swing', args: { n: 50 }, why: 'Straight', risk: 'S0' },
                { tool: 'write_groove', args: { name: 'four_on_floor' }, why: 'Club pulse', risk: 'S0' },
                { tool: 'apply_genre', args: { genre: 'house' }, why: 'Hat density + drive', risk: 'S0' },
              ],
            },
            {
              id: 'halftime',
              label: 'Halftime Dark',
              blurb: 'Space · schwer · Swing 62',
              steps: [
                { tool: 'fill_pads_kit', args: { style: 'dusty' }, why: 'Dark kit base', risk: 'S1' },
                { tool: 'set_swing', args: { n: 62 }, why: 'Lazy swing', risk: 'S0' },
                { tool: 'write_groove', args: { name: 'halftime' }, why: 'Half-time pocket', risk: 'S0' },
                { tool: 'apply_genre', args: { genre: 'halftime' }, why: 'Space & sub', risk: 'S0' },
              ],
            },
          ],
        };
      },
    },
    {
      id: 'fix_mix',
      title: 'Fix the Mix',
      blurb: 'Klingt dünn, muddy oder scharf? Ein Tap.',
      icon: '✦',
      risk: 'S1',
      build() {
        return {
          mission: 'fix_mix',
          say: 'Ich diagnostiziere und balanciere den Mix.',
          agent: 'Mixer',
          steps: [
            { tool: 'coach_fix_thin', args: {}, why: 'Sub + Snare-Körper', risk: 'S1' },
            { tool: 'balance_mix', args: {}, why: 'Levels nach Instrument-Typ', risk: 'S0' },
            { tool: 'humanize', args: { amount: 0.12 }, why: 'Velocity lebendig', risk: 'S0' },
          ],
        };
      },
    },
    {
      id: 'remix_night',
      title: 'Remix Night',
      blurb: '3 Varianten — du wählst eine',
      icon: '⟳',
      risk: 'S2',
      build() {
        return {
          mission: 'remix_night',
          say: 'Drei Remix-Richtungen. Hör sie dir als Plan an und wähle.',
          agent: 'Remixer',
          steps: [],
          options: [
            {
              id: 'var_a',
              label: 'Ghost Hats',
              blurb: 'Mehr Bewegung in den Offbeats',
              steps: [
                { tool: 'ghost_notes', args: {}, why: 'Leise Offbeat-Hats', risk: 'S0' },
                { tool: 'humanize', args: { amount: 0.15 }, why: 'Human feel', risk: 'S0' },
              ],
            },
            {
              id: 'var_b',
              label: 'Breakdown',
              blurb: '8 Bars mit Luft und Drop',
              steps: [
                { tool: 'build_drop_form', args: {}, why: 'Form mit Breakdown', risk: 'S1' },
                { tool: 'set_swing', args: { n: 60 }, why: 'Slight push', risk: 'S0' },
              ],
            },
            {
              id: 'var_c',
              label: 'Club Push',
              blurb: 'Four-on-floor Energie',
              steps: [
                { tool: 'write_groove', args: { name: 'four_on_floor' }, why: 'Club pulse', risk: 'S0' },
                { tool: 'apply_genre', args: { genre: 'house' }, why: 'Drive & hats', risk: 'S0' },
                { tool: 'sidechain_feel', args: {}, why: 'Kick vs Bass Pocket', risk: 'S0' },
              ],
            },
          ],
        };
      },
    },
    {
      id: 'pack_kit',
      title: 'Pack → Kit',
      blurb: 'Spielbares Kit aus einem Sound-Pack',
      icon: '▤',
      risk: 'S2',
      build(project) {
        const packs = (project && project.packs) || [];
        if (!packs.length) {
          return {
            mission: 'pack_kit',
            say: 'Noch keine Packs in library/packs — Packs laden, dann RESCAN.',
            agent: 'Librarian',
            steps: [],
          };
        }
        const opts = packs.slice(0, 3).map((p) => ({
          id: p.slug,
          label: (p.name || p.slug).slice(0, 28),
          blurb: `${p.count} Samples · echte WAVs`,
          steps: [
            { tool: 'load_pack_kit', args: { pack: p.slug }, why: 'Kit aus ' + p.slug, risk: 'S1' },
            { tool: 'write_groove', args: { name: 'boom_bap' }, why: 'Sofort spielbar', risk: 'S0' },
          ],
        }));
        return {
          mission: 'pack_kit',
          say: 'Welches Pack stellt das Kit? Ich lege es auf die Pads.',
          agent: 'Librarian',
          steps: [],
          options: opts,
        };
      },
    },
    {
      id: 'finish_export',
      title: 'Finish & Export',
      blurb: 'Checkliste + Stem-Plan',
      icon: '↑',
      risk: 'S0',
      build() {
        return {
          mission: 'finish_export',
          say: 'Export-Plan und kurzer Qualitäts-Check.',
          agent: 'Export',
          steps: [
            { tool: 'balance_mix', args: {}, why: 'Final balance', risk: 'S0' },
            { tool: 'export_summary', args: {}, why: 'Stems & Namen', risk: 'S0' },
            { tool: 'suggest_next', args: {}, why: 'Nächster kreativer Schritt', risk: 'S0' },
          ],
        };
      },
    },
  ];

  class PlanRunner {
    constructor(project, history) {
      this.project = project;
      this.history = history;
      this.active = null;
      this.listeners = new Set();
    }

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type, detail) {
      this.listeners.forEach((fn) => fn({ type, detail }));
    }

    /**
     * Execute linear steps. Returns results.
     * @param {object} plan
     * @param {{skipHistory?: boolean}} opts
     */
    runSteps(plan, opts = {}) {
      const steps = plan.steps || [];
      if (!opts.skipHistory) this.history.push(plan.mission || plan.say || 'plan');
      const results = [];
      this.active = { plan, index: 0, status: 'running' };
      this.emit('start', { plan });

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        this.active.index = i;
        this.emit('step', { index: i, step, status: 'run' });
        try {
          const result = this.project.exec_tool(step.tool, step.args || {});
          results.push({ ok: true, step, result });
          this.emit('step', { index: i, step, status: 'ok', result });
        } catch (e) {
          const err = String(e.message || e);
          results.push({ ok: false, step, error: err });
          this.emit('step', { index: i, step, status: 'err', error: err });
          this.active.status = 'error';
          this.emit('done', { plan, results, ok: false });
          return { ok: false, results };
        }
      }
      this.active.status = 'done';
      this.emit('done', { plan, results, ok: true });
      return { ok: true, results };
    }

    /** Apply a chosen option from an S2 plan */
    runOption(plan, optionId) {
      const opt = (plan.options || []).find((o) => o.id === optionId);
      if (!opt) throw new Error('option_not_found');
      return this.runSteps({
        mission: plan.mission,
        say: opt.label,
        agent: plan.agent,
        steps: opt.steps,
      });
    }
  }

  function getMission(id) {
    return MISSIONS.find((m) => m.id === id) || null;
  }

  function listMissions() {
    return MISSIONS.map((m) => ({
      id: m.id,
      title: m.title,
      blurb: m.blurb,
      icon: m.icon,
      risk: m.risk,
    }));
  }

  /**
   * Extend Project with cooperative high-level tools if missing.
   */
  function installCoopTools(project, engine) {
    if (project._coopInstalled) return;
    project._coopInstalled = true;

    project.balance_mix = function () {
      const typeGain = {
        kick: 0.95, snare: 0.88, hat: 0.55, perc: 0.6, melodic: 0.7, loop: 0.75,
      };
      this.pads.forEach((p, i) => {
        if (!p) return;
        const base = typeGain[p.type] ?? 0.75;
        const energy = p.energy != null ? 0.7 + p.energy * 0.3 : 1;
        this.levels[i] = Math.max(0.25, Math.min(1, base * energy));
      });
      this.emit('mix');
      return { levels: this.levels.map((v, i) => (this.pads[i] ? +v.toFixed(2) : null)) };
    };

    project.humanize = function (amount = 0.12) {
      const a = Math.max(0, Math.min(0.4, amount));
      const p = this.pattern;
      p.tracks = p.tracks.map((row) =>
        row.map((v) => {
          if (!v) return 0;
          const j = (Math.random() * 2 - 1) * a;
          return Math.max(0.15, Math.min(1, v + j));
        })
      );
      this.emit('pattern');
      return { amount: a };
    };

    project.ghost_notes = function () {
      // add quiet hats on offbeats of pad 4 if present
      const hat = 4;
      if (!this.pads[hat]) {
        const h = this.library.find((s) => s.type === 'hat');
        if (h) this.assign_pad(hat, h.id);
      }
      const row = this.pattern.tracks[hat];
      for (let i = 1; i < 16; i += 2) {
        if (!row[i]) row[i] = 0.28;
      }
      this.emit('pattern');
      return { pad: hat, ghosts: true };
    };

    project.sidechain_feel = function () {
      // when kick hits, dip bass velocity on same step
      const kick = 0;
      const bass = 8;
      const p = this.pattern;
      if (!this.pads[bass]) {
        const b = this.library.find((s) => s.tags?.includes('bass') || s.type === 'melodic');
        if (b) this.assign_pad(bass, b.id);
      }
      for (let s = 0; s < 16; s++) {
        if (p.tracks[kick][s] && p.tracks[bass][s]) {
          p.tracks[bass][s] = Math.min(p.tracks[bass][s], 0.35);
        } else if (p.tracks[kick][s] && !p.tracks[bass][s]) {
          // light bass between kicks
          if (s % 4 === 2) p.tracks[bass][s] = 0.55;
        }
      }
      this.emit('pattern');
      return { kick, bass };
    };

    project.apply_genre = function (genre = 'boom_bap') {
      const g = String(genre || '').toLowerCase();
      if (engine) {
        if (g.includes('house')) engine.setDrive(0.35);
        else if (g.includes('half')) engine.setDrive(0.28);
        else engine.setDrive(0.22);
      }
      // level recipe
      this.pads.forEach((p, i) => {
        if (!p) return;
        if (g.includes('house')) {
          if (p.type === 'kick') this.levels[i] = 0.98;
          if (p.type === 'hat') this.levels[i] = 0.7;
          if (p.type === 'snare') this.levels[i] = 0.8;
        } else if (g.includes('half')) {
          if (p.type === 'kick') this.levels[i] = 1;
          if (p.type === 'hat') this.levels[i] = 0.4;
          if (p.type === 'melodic') this.levels[i] = 0.75;
        } else {
          if (p.type === 'kick') this.levels[i] = 0.95;
          if (p.type === 'snare') this.levels[i] = 0.9;
          if (p.type === 'hat') this.levels[i] = 0.5;
        }
      });
      this.emit('mix');
      return { genre: g };
    };

    project.suggest_next = function () {
      const hasPads = this.pads.some(Boolean);
      const hasGroove = this.pattern.tracks.some((row) => row.some(Boolean));
      const hasArr = this.arrangement.some(Boolean);
      const hasReal = this.library.some((s) => s.real);
      let next = 'first_beat';
      let reason = 'Starte mit einem hörbaren Beat.';
      if (hasPads && !hasGroove) {
        next = 'first_beat';
        reason = 'Pads da — Groove fehlt.';
      } else if (hasGroove && !hasArr) {
        next = 'drop_builder';
        reason = 'Groove steht — baue Form/Drop.';
      } else if (hasReal && hasGroove) {
        next = 'break_to_kit';
        reason = 'Echte Samples da — Chop nutzen.';
      } else if (hasArr) {
        next = 'remix_night';
        reason = 'Form da — Zeit für Varianten.';
      }
      return { next_mission: next, reason, checklist: { hasPads, hasGroove, hasArr, hasReal } };
    };

    // wire into exec_tool
    const prev = project.exec_tool.bind(project);
    project.exec_tool = function (name, args = {}) {
      const a = args || {};
      switch (name) {
        case 'balance_mix': return project.balance_mix();
        case 'humanize': return project.humanize(a.amount ?? a.n ?? 0.12);
        case 'ghost_notes': return project.ghost_notes();
        case 'sidechain_feel': return project.sidechain_feel();
        case 'apply_genre': return project.apply_genre(a.genre || a.name || 'boom_bap');
        case 'suggest_next': return project.suggest_next();
        default: return prev(name, args);
      }
    };
  }

  global.LoopTischCoop = {
    History,
    PlanRunner,
    MISSIONS,
    getMission,
    listMissions,
    installCoopTools,
  };
})(window);
