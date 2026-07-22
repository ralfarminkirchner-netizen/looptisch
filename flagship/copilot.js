/**
 * LOOPTiSCH Co-Pilot — context-aware KI helper.
 * Watches every click + project state → proposes next sensible steps,
 * executes full process chains on one click.
 *
 * Honest labeling: suggestions are deterministic rules over real state
 * (not fake "AI"). Chains are named and visible in the tool log.
 */
(function (global) {
  'use strict';

  let LT = null; // window.LT context, set by init()

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ——— shared helpers ———
  function importBuffer(buffer, name, extra = {}) {
    const { project, engine, Analyze } = LT;
    const analysis = Analyze.analyzeAudioBuffer(buffer, { name });
    const bufferId = project.nextId('buf');
    engine.storeBuffer(bufferId, buffer);
    const meta = project.import_sample({ name, bufferId, analysis });
    const s = project.findSample(meta.id);
    Object.assign(s, extra);
    return meta;
  }

  function selectedPadSample() {
    return LT.project.pads[LT.project.selectedPad] || null;
  }

  function bufferOf(sample) {
    return sample?.bufferId ? LT.engine.getBuffer(sample.bufferId) : null;
  }

  function styleFromEssence(sig) {
    return {
      bpm: sig.bpm && sig.bpm > 40 ? sig.bpm : 92,
      key: sig.key && sig.key !== '—' ? sig.key : 'Am',
      energy: clamp01(sig.energy ?? 0.6),
      swing: sig.swing ?? 54,
      brightness: clamp01((sig.brightness_centroid_hz ?? 3000) / 6000),
    };
  }

  // ——— chains (Prozessketten) ———
  const state = { lastForge: null, lastEssence: null, busy: false };

  async function runChain(name, steps, opts = {}) {
    if (state.busy) { LT.toast('Co-Pilot arbeitet schon…'); return null; }
    state.busy = true;
    LT.addMsg('Co-Pilot', `Kette: ${name} (${steps.length} Schritte)`);
    try {
      let out = null;
      for (const [label, fn] of steps) {
        LT.toast('▶ ' + label);
        out = await fn(out);
        await sleep(120);
      }
      LT.toast('✓ ' + name);
      // hörbar machen: Ergebnis spielt sofort, nicht nur Text
      if (opts.autoplay !== false && !LT.transport.playing) {
        LT.engine.ensure();
        LT.transport.toggle();
        LT.renderAll();
        LT.toast('▶ hör rein — ' + name);
      }
      return out;
    } catch (err) {
      LT.addMsg('Co-Pilot', `Kette ${name} Fail: ${err.message || err}`);
      LT.toast('Kette abgebrochen: ' + (err.message || err));
      return null;
    } finally {
      state.busy = false;
      refresh();
    }
  }

  /** pick best real sample per role from library */
  function pickRoleSample(type) {
    const cands = LT.project.library.filter((s) => s.real && s.type === type);
    return cands.length ? cands[(Math.random() * cands.length) | 0] : null;
  }

  /** Matchering 2.0 lokal: target vs reference → mastered AudioBuffer */
  async function matcheringMaster(target, ref) {
    const [ta, ra] = await Promise.all([
      LT_ESSENCE.wavFromBuffer(target).arrayBuffer(),
      LT_ESSENCE.wavFromBuffer(ref).arrayBuffer(),
    ]);
    const r = await fetch('api/master', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wav_target: LT_ESSENCE.b64encode(ta), wav_ref: LT_ESSENCE.b64encode(ra) }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'master failed');
    const raw = LT_ESSENCE.b64decodeToBytes(d.wav_mastered);
    const buf = await LT.engine.ctx.decodeAudioData(raw.buffer);
    LT.addMsg('Master', `Matchering ✓ ${d.engine} · Referenz nur als Analyse, kein Referenz-Audio im Output`);
    return buf;
  }

  /** shared: trio render + import + chops + automix (used by track/morph/mastered) */
  async function renderAndImport(comp, kit, name, extraMsg = '') {
    const { buffer, meta } = await LT_NEURAL.renderTrio(comp, kit, {
      bpm: LT.project.bpm, brightness: 0.5,
    });
    const m = importBuffer(buffer, name, {
      license: 'magenta VAE (Apache 2.0) komposition · gerendert via Library-Samples',
    });
    LT.addMsg('Neural', `${name} ✓ ${comp.totalNotes} Noten → ${buffer.duration.toFixed(1)}s${extraMsg} · ${m.onsets} onsets`);
    return { m, buffer, meta };
  }

  /** MAGNET: Sample auf Projekt einrasten — trim → BPM-Stretch → Key-Tune → norm */
  async function magnetFit(sample, buf, onProgress) {
    const sr = buf.sampleRate;
    let chans = LT_DSP.toChannels(buf);
    const steps = [];
    chans = LT_DSP.trimSilence(chans, sr); steps.push('trim');
    const bpm = sample.bpm || 0;
    if (bpm > 40 && Math.abs(bpm - LT.project.bpm) > 2) {
      const ratio = bpm / LT.project.bpm;
      chans = await LT_DSP.wsola(chans, sr, ratio, onProgress);
      sample.bpm = LT.project.bpm; sample.stretch = 1;
      steps.push(`bpm ${bpm}→${LT.project.bpm}`);
    }
    if (sample.type === 'melodic') {
      const sig = LT_ESSENCE.signatureFromBuffer(LT_DSP.fromChannels(LT.engine.ctx, chans, sr), { name: sample.name });
      if (sig.key !== '—' && sig.key !== LT.project.key) {
        chans = await LT_DSP.tuneToScale(chans, sr, LT.project.key, 0.9, onProgress);
        steps.push(`tune ${sig.key}→${LT.project.key}`);
      }
    }
    chans = LT_DSP.normalize(chans); steps.push('norm');
    return { chans, steps };
  }

  const chains = {
    /** neural_morph: 2 VAE-Seeds → Latent-Interpolation ×4 → alle Varianten in Library */
    neural_morph: () => runChain('VAE MORPH (Latent-Interpolation)', [
      ['Zwei Seeds + interpolate ×4', async () => {
        const r = await LT_NEURAL.trioInterpolate({
          temperature: 1.0, steps: 4, key: LT.project.key,
          onStatus: (t) => LT.toast('magenta: ' + t),
        });
        return r;
      }],
      ['Kit aus echten Samples', async (r) => {
        const kit = await LT_FORGE.pickKit(LT.engine, LT.project, Math.random);
        if (!kit) throw new Error('kein Kit ladbar');
        return { r, kit };
      }],
      ['4 Morphs rendern + importieren', async ({ r, kit }) => {
        const names = [];
        for (const comp of r.morphs) {
          const { m, buffer, meta } = await renderAndImport(comp, kit, `vae-morph${comp.morphIndex}-${Date.now().toString(36)}`, ` · morph ${comp.morphIndex + 1}/4`);
          names.push(m.name);
          if (comp.morphIndex === 0) state.lastForge = { buffer, meta };
        }
        return names;
      }],
      ['Erste Morph ▶ Pads 9–16', async (names) => {
        const first = LT.project.library.find((s) => s.name === names[0].replace(/\.[^.]+$/, '')) || LT.project.library.find((s) => s.name.startsWith('vae-morph0'));
        if (first) {
          LT.project.selectedSampleId = first.id;
          LT.project.detect_onsets(first.id);
          LT.project.map_chops_to_pads(8);
        }
        LT.renderAll();
        LT.addMsg('Neural', `MORPH ✓ 4 kohärente Varianten in der Library: ${names.map((n) => n.slice(0, 14)).join(' · ')}`);
        return true;
      }],
      ['Auto Mix', async () => { LT_MASTER.autoMix(LT.project, LT.engine); LT.renderAll(); return true; }],
    ]),

    /** neural_melody: mel_2bar reine Melodie-Lane durch Lead-Sample */
    neural_melody: () => runChain('VAE MEL (mel_2bar Lane)', [
      ['mel_2bar Melodie', async () => {
        const comp = await LT_NEURAL.melodySample({
          temperature: 1.0, key: LT.project.key,
          onStatus: (t) => LT.toast('magenta: ' + t),
        });
        return comp;
      }],
      ['Lead-Sample laden', async (comp) => {
        const s = pickRoleSample('melodic');
        if (!s) throw new Error('kein melodisches Sample');
        const buffer = await LT_FORGE.loadBufferFor(LT.engine, s);
        if (!buffer) throw new Error('Lead nicht ladbar');
        return { comp, kit: { chordSrc: { sample: s, buffer } } };
      }],
      ['Render + Import', async ({ comp, kit }) => {
        // renderTrio mit leerem drums/bass: nur Melodie-Lane
        const { m } = await renderAndImport(
          { drums: [], bass: [], melody: comp.melody, bars: comp.bars, beatsPerBar: 4, transposed: comp.transposed, key: comp.key, totalNotes: comp.totalNotes },
          kit, `vae-mel-${Date.now().toString(36)}`, ' · melodie-only',
        );
        LT.renderAll();
        return m;
      }],
    ]),

    /** neural_mastered: VAE-Track → Matchering Referenz-Mastering aufs selektierte Pad */
    neural_mastered: () => runChain('VAE → REF-MASTER', [
      ['MusicVAE Trio', async () => {
        const comp = await LT_NEURAL.trioSample({
          temperature: 1.0, key: LT.project.key,
          onStatus: (t) => LT.toast('magenta: ' + t),
        });
        return comp;
      }],
      ['Kit + Render', async (comp) => {
        const kit = await LT_FORGE.pickKit(LT.engine, LT.project, Math.random);
        if (!kit) throw new Error('kein Kit ladbar');
        const { buffer } = await LT_NEURAL.renderTrio(comp, kit, { bpm: LT.project.bpm });
        state.lastForge = { buffer, meta: comp };
        return buffer;
      }],
      ['Matchering aufs Referenz-Pad', async (buffer) => {
        let ref = bufferOf(selectedPadSample());
        let refName = selectedPadSample()?.name;
        // Matchering braucht ≥ ~4s Referenz — sonst: längsten Loop der Library
        if (!ref || ref.duration < 4) {
          const loops = LT.project.library
            .filter((s) => s.real && s.type === 'loop' && (s.duration || 0) > 5)
            .sort((a, b) => (b.duration || 0) - (a.duration || 0));
          for (const cand of loops.slice(0, 5)) {
            ref = await LT_FORGE.loadBufferFor(LT.engine, cand).catch(() => null);
            if (ref && ref.duration >= 4) { refName = cand.name; break; }
            ref = null;
          }
          if (!ref) throw new Error('keine Referenz ≥4s ladbar');
          LT.addMsg('Master', `Referenz (Pad zu kurz): ${refName.slice(0, 40)} (${ref.duration.toFixed(1)}s)`);
        }
        return matcheringMaster(buffer, ref);
      }],
      ['Import mastered', async (buf) => {
        const m = importBuffer(buf, `vae-mastered-${Date.now().toString(36)}`, {
          license: 'magenta VAE (Apache 2.0) + matchering · referenz=analyse-only',
        });
        LT.project.detect_onsets(m.id);
        LT.project.map_chops_to_pads(8);
        LT.renderAll();
        return m;
      }],
    ]),

    /** neural_track: MusicVAE trio (melody+bass+drums) → real samples → import → chops */
    neural_track: () => runChain('VAE TRIO (MusicVAE → echte Samples)', [
      ['MusicVAE komponiert Trio', async () => {
        if (!global.LT_NEURAL) throw new Error('neural.js fehlt');
        const comp = await LT_NEURAL.trioSample({
          temperature: 1.0, key: LT.project.key,
          onStatus: (t) => LT.toast('magenta: ' + t),
        });
        return comp;
      }],
      ['Kit aus echten Samples', async (comp) => {
        const kit = await LT_FORGE.pickKit(LT.engine, LT.project, Math.random);
        if (!kit) throw new Error('kein Kit ladbar');
        return { comp, kit };
      }],
      ['Render durch echte Samples', async ({ comp, kit }) => {
        const { buffer, meta } = await LT_NEURAL.renderTrio(comp, kit, {
          bpm: LT.project.bpm, brightness: 0.5,
        });
        state.lastForge = { buffer, meta };
        const m = importBuffer(buffer, `vae-trio-${Date.now().toString(36)}`, {
          license: 'magenta VAE (Apache 2.0) komposition · gerendert via Library-Samples',
        });
        LT.addMsg('Neural', `VAE TRIO ✓ ${comp.totalNotes} Noten → ${buffer.duration.toFixed(1)}s · key ${LT.project.key} (shift ${comp.transposed}) · ${m.onsets} onsets`);
        return m;
      }],
      ['Chops ▶ Pads 9–16', async (m) => {
        LT.project.detect_onsets(m.id);
        const r = LT.project.map_chops_to_pads(8);
        LT.renderAll();
        return r;
      }],
      ['Auto Mix', async () => { LT_MASTER.autoMix(LT.project, LT.engine); LT.renderAll(); return true; }],
    ]),

    /** neural_kit: magenta DrumsRNN groove on REAL kit samples → pattern A1/A2 */
    neural_kit: () => runChain('NEURAL KIT (magenta DrumsRNN)', [
      ['Kit aus echten Samples', async () => {
        const roles = ['kick', 'snare', 'hat', 'perc'];
        const pads = {};
        for (let i = 0; i < roles.length; i++) {
          const s = pickRoleSample(roles[i]);
          if (!s) throw new Error('kein Sample für ' + roles[i]);
          LT.project.assign_pad(i, s.id);
          pads[roles[i]] = { pad: i, name: s.name };
        }
        LT.addMsg('Neural', 'Kit: ' + Object.entries(pads).map(([r, v]) => `${r}=P${v.pad + 1} ${v.name.slice(0, 16)}`).join(' · '));
        return pads;
      }],
      ['DrumsRNN Groove (Apache, im Browser)', async (pads) => {
        if (!global.LT_NEURAL) throw new Error('neural.js fehlt');
        const g = await LT_NEURAL.drumGroove({
          bars: 2, temperature: 1.15,
          onStatus: (t) => LT.toast('magenta: ' + t),
        });
        return { pads, g };
      }],
      ['Pattern A1+A2 schreiben', async ({ pads, g }) => {
        const rolePad = { kick: 0, snare: 1, hat: 2, perc: 3 };
        g.steps.forEach((roles, s) => {
          const pat = s < 16 ? 'A1' : 'A2';
          const step = s % 16;
          for (const [role, vel] of Object.entries(roles)) {
            if (vel > 0) {
              LT.project.patternId = pat;
              LT.project.set_step(rolePad[role], step, +vel.toFixed(2));
            }
          }
        });
        LT.project.patternId = 'A1';
        LT.renderAll();
        LT.addMsg('Neural', `Groove geschrieben: ${g.notes} Noten → A1+A2 (temp ${g.temperature}) · Apache-2.0 magenta`);
        return true;
      }],
      ['Auto Mix', async () => { LT_MASTER.autoMix(LT.project, LT.engine); LT.renderAll(); return true; }],
    ]),

    /** Forge original track → import → chop → pads 9–16 → automix */
    forge_to_pads: (preset) => runChain(`FORGE→PADS (${preset})`, [
      ['Forge rendert Original-Track (echte Samples)', async () => {
        const style = { ...(LT_FORGE.PRESETS[preset] || {}), seed: (Math.random() * 1e9) | 0 };
        const { buffer, meta } = await LT_FORGE.forgeSmart(style, { project: LT.project, engine: LT.engine });
        state.lastForge = { buffer, meta };
        if (meta.kit) LT.addMsg('Forge', 'Kit: ' + Object.entries(meta.kit).map(([r, n]) => `${r}=${String(n).slice(0, 18)}`).join(' · '));
        return { buffer, meta, preset };
      }],
      ['Analysieren + in Library', async ({ buffer, meta, preset: p }) => {
        const m = importBuffer(buffer, `forge-${p}-${meta.seed.toString(36)}`, {
          license: meta.license, essence: { origin: 'forge', seed: meta.seed },
        });
        LT.addMsg('Forge', `${m.name} · ${m.bpm || '?'} bpm · ${m.onsets} onsets · seed ${meta.seed} · ${meta.license || 'lizenzfrei'}`);
        return m;
      }],
      ['Chops erkennen', async (m) => {
        const r = LT.project.detect_onsets(m.id);
        return { m, chops: r.chops.length };
      }],
      ['Auf Pads 9–16 mappen', async ({ m }) => {
        const r = LT.project.map_chops_to_pads(8);
        return { m, mapped: r.mapped ?? 'ok' };
      }],
      ['Auto Mix', async (r) => { LT_MASTER.autoMix(LT.project, LT.engine); LT.renderAll(); return r; }],
    ]),

    /** Essence of selected pad → forge in that style → Δ measure → import */
    style_clone: () => runChain('STYLE-KLON (Essence→Forge→Δ)', [
      ['Essence des Pads messen', async () => {
        const s = selectedPadSample();
        const buf = bufferOf(s);
        if (!buf) throw new Error('Pad hat kein decodiertes Sample');
        const sig = LT_ESSENCE.signatureFromBuffer(buf, { name: s.name, origin: 'reference' });
        state.lastEssence = sig;
        LT.addMsg('Essence', `${s.name}: ${sig.bpm || '?'}bpm · ${sig.key} · energy ${sig.energy} · swing ${sig.swing}`);
        return sig;
      }],
      ['Forge im gemessenen Stil', async (sig) => {
        const { buffer, meta } = await LT_FORGE.forgeSmart(styleFromEssence(sig), { project: LT.project, engine: LT.engine });
        state.lastForge = { buffer, meta };
        return { sig, buffer, meta };
      }],
      ['Δ Treue messen', async ({ sig, buffer, meta }) => {
        const sig2 = LT_ESSENCE.signatureFromBuffer(buffer, { name: 'forge', origin: 'forge', license: meta.license });
        const delta = LT_ESSENCE.essenceDelta(sig, sig2);
        LT.addMsg('Essence', `Δ(ref, forge) = ${delta.distance} · similarity ${delta.similarity} — ${delta.ceiling}`);
        return { buffer, meta, delta };
      }],
      ['Import + mappen', async ({ buffer, meta }) => {
        const m = importBuffer(buffer, `clone-${meta.seed.toString(36)}`, { license: meta.license });
        LT.project.detect_onsets(m.id);
        LT.project.map_chops_to_pads(8);
        LT.renderAll();
        return m;
      }],
    ]),

    /** selected loop sample → chops → pads */
    loop_to_pads: () => runChain('LOOP→CHOPS→PADS', [
      ['Onsets', async () => {
        const s = selectedPadSample() || LT.project.library.find((x) => x.type === 'loop');
        if (!s) throw new Error('kein Loop gewählt');
        LT.project.selectedSampleId = s.id;
        const r = LT.project.detect_onsets(s.id);
        LT.addMsg('Co-Pilot', `${s.name}: ${r.chops.length} chops`);
        return r;
      }],
      ['Map 9–16', async () => { const r = LT.project.map_chops_to_pads(8); LT.renderAll(); return r; }],
    ]),

    /** finish: automix + automaster */
    finish: () => runChain('FINISH (Mix+Master)', [
      ['Auto Mix (Gain-Staging)', async () => {
        const r = LT_MASTER.autoMix(LT.project, LT.engine);
        LT.renderAll();
        return r;
      }],
      ['Auto Master an', async () => {
        if (LT.engine.masterSuite) {
          LT.engine.masterSuite.setEnabled(true, LT.engine);
          LT.addMsg('Master', `AUTO MASTER an · Ziel ${LT.engine.masterSuite.target} LUFS`);
        }
        LT.renderAll();
        return true;
      }],
    ]),

    /** magnet_pad: selektiertes Pad magnetisch einrasten (trim/stretch/tune/norm) */
    magnet_pad: () => runChain('MAGNET (auto-fit)', [
      ['Pad analysieren', async () => {
        const s = selectedPadSample();
        const buf = bufferOf(s);
        if (!buf) throw new Error('Pad ohne decodiertes Sample');
        return { s, buf };
      }],
      ['Magnetisch einrasten', async ({ s, buf }) => {
        const { chans, steps } = await magnetFit(s, buf, () => {});
        const nb = LT_DSP.fromChannels(LT.engine.ctx, chans, buf.sampleRate);
        LT.engine.storeBuffer(s.bufferId, nb);
        LT.addMsg('Magnet', `${s.name}: ${steps.join(' · ')} → ${nb.duration.toFixed(2)}s`);
        return steps;
      }],
    ], { autoplay: false }),

    /** ref_master: matchering 2.0 — last forge render vs selected pad reference (local) */
    ref_master: () => runChain('REF-MASTER (Matchering)', [
      ['Target + Referenz prüfen', async () => {
        if (!state.lastForge?.buffer) throw new Error('kein Forge-Render — erst FORGE drücken');
        const ref = bufferOf(selectedPadSample());
        if (!ref) throw new Error('Referenz-Pad ohne Sample');
        return { target: state.lastForge.buffer, ref };
      }],
      ['Matchering mastered (lokal)', async ({ target, ref }) => {
        const [ta, ra] = await Promise.all([
          LT_ESSENCE.wavFromBuffer(target).arrayBuffer(),
          LT_ESSENCE.wavFromBuffer(ref).arrayBuffer(),
        ]);
        const r = await fetch('api/master', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wav_target: LT_ESSENCE.b64encode(ta), wav_ref: LT_ESSENCE.b64encode(ra) }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'master failed');
        const raw = LT_ESSENCE.b64decodeToBytes(d.wav_mastered);
        const buf = await LT.engine.ctx.decodeAudioData(raw.buffer);
        LT.addMsg('Master', `Matchering ✓ ${d.engine} · Referenz nur als Analyse, kein Audio aus der Referenz im Output`);
        return buf;
      }],
      ['Import mastered', async (buf) => {
        const m = importBuffer(buf, `mastered-${state.lastForge.meta.seed.toString(36)}`, {
          license: 'matchering-master · target=forge (lizenzfrei) · referenz=analyse-only',
        });
        LT.project.detect_onsets(m.id);
        LT.renderAll();
        return m;
      }],
    ]),
  };

  // ——— suggestion rules ———
  function computeSuggestions() {
    const { project, transport } = LT;
    const out = [];
    const padsUsed = project.pads.filter(Boolean).length;
    const stepsUsed = Object.values(project.patterns).some((p) => p.tracks.some((t) => t.some((v) => v > 0)));
    const sel = selectedPadSample();
    const selBuf = bufferOf(sel);

    if (state.busy) return [{ label: '…', why: 'Kette läuft', kind: 'nav', run: null }];
    if (padsUsed === 0) {
      out.push({ label: 'NEURAL KIT ✦', why: 'keine Pads belegt — magenta baut Kit + Groove', kind: 'gen', run: () => chains.neural_kit() });
      out.push({ label: 'FORGE ▶ KIT', why: 'alternativ: prozeduraler Track aus echten Samples', kind: 'gen', run: () => chains.forge_to_pads('dusty-boombap') });
      out.push({ label: 'PANDRUM spielen', why: 'sofort musikalisch, kein Setup', kind: 'nav', run: () => LT.setMode('pandrum') });
      return out;
    }
    if (sel && selBuf && (sel.type === 'loop' || (sel.duration ?? 0) > 2)) {
      out.push({ label: 'LOOP ▶ PADS', why: `${sel.name.slice(0, 18)} ist ein Loop — in Chops legen`, kind: 'proc', run: () => chains.loop_to_pads() });
      out.push({ label: 'MAGNET', why: `auf ${project.bpm}bpm/${project.key} einrasten`, kind: 'proc', run: () => chains.magnet_pad() });
      out.push({ label: 'STYLE-KLON', why: 'Stil messen → Forge baut ähnlichen', kind: 'gen', run: () => chains.style_clone() });
      return out;
    }
    if (sel && selBuf && sel.type === 'melodic') {
      out.push({ label: 'TUNE ▶ KEY', why: `melodisch — auf ${project.key} snappen`, kind: 'proc', run: () => document.querySelector('#btnFlexTune')?.click() });
      out.push({ label: 'STYLE-KLON', why: 'Stil-Vorlage für Forge', kind: 'gen', run: () => chains.style_clone() });
    }
    if (!stepsUsed) {
      out.push({ label: 'FIRST BEAT', why: 'Pattern ist leer — Grundgerüst bauen', kind: 'gen', run: () => LT.startMission('first_beat') });
      out.push({ label: 'NEURAL KIT ✦', why: 'oder magenta Groove generieren', kind: 'gen', run: () => chains.neural_kit() });
      return out.slice(0, 3);
    }
    if (!transport.playing) {
      out.push({ label: '▶ PLAY', why: 'Pattern hat Steps — anhören', kind: 'nav', run: () => { LT.engine.ensure(); LT.transport.toggle(); LT.renderAll(); } });
      out.push({ label: 'FINISH', why: 'Mix + Master zum Abschluss', kind: 'master', run: () => chains.finish() });
      out.push({ label: 'VAE MORPH', why: '4 Variationen zum Weiterbauen', kind: 'gen', run: () => chains.neural_morph() });
    } else {
      out.push({ label: '⏹ STOP', why: 'läuft gerade', kind: 'nav', run: () => { LT.transport.stop(); LT.renderAll(); } });
      out.push({ label: 'HALL +', why: 'Raum auf den Mix', kind: 'master', run: () => {
        const r = LT.engine.rack; if (r) { r.setEnabled('reverb', true); r.setAmount('reverb', 0.45); }
        document.querySelector('.fx-chip[data-fx="reverb"]')?.classList.add('on');
        LT.toast('FX: HALL an');
      } });
      out.push({ label: 'FINISH', why: 'Mix + Master', kind: 'master', run: () => chains.finish() });
    }
    return out.slice(0, 3);
  }

  // ——— UI ———
  let rootEl = null;
  let lastSig = '';
  function render(sugs) {
    if (!rootEl) return;
    // Stabilität: nur neu rendern, wenn sich die Vorschläge WIRKLICH ändern
    const sig = sugs.map((s) => s.label).join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    rootEl.innerHTML = `<div class="cop-h"><b>CO-PILOT</b><span>${state.busy ? 'arbeitet…' : '3 nächste Schritte'}</span></div>`
      + sugs.map((s, i) => `<button type="button" class="cop-chip kind-${s.kind || 'nav'}" data-i="${i}" ${s.run ? '' : 'disabled'}>
          <b>${s.label}</b>${s.why ? `<span>${s.why}</span>` : ''}</button>`).join('');
    rootEl.querySelectorAll('.cop-chip').forEach((chip) => {
      chip.onclick = () => { const s = sugs[+chip.dataset.i]; if (s?.run) s.run(); };
    });
  }

  let refreshTimer = null;
  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => render(computeSuggestions()), 60);
  }

  function init(ltContext) {
    LT = ltContext;
    // expose internals app.js didn't export
    if (!LT.toast) console.warn('[copilot] LT.toast missing — patch app.js export');
    // mount UI at top of crew column
    const crew = document.querySelector('.crew-col');
    if (crew) {
      rootEl = document.createElement('div');
      rootEl.id = 'copilot';
      rootEl.className = 'copilot';
      crew.insertBefore(rootEl, crew.children[1] || null);
    }
    // watch everything
    LT.project.on(() => refresh());
    document.addEventListener('click', () => refresh(), true);
    setInterval(refresh, 5000);
    refresh();
    global.LT_COPILOT_API = { chains, refresh, computeSuggestions, state };
    return global.LT_COPILOT_API;
  }

  global.LT_COPILOT = { init, chains };
})(window);
