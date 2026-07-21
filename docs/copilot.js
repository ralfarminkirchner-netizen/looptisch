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

  async function runChain(name, steps) {
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

  const chains = {
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

    if (state.busy) return [{ label: '…', hint: 'Kette läuft', run: null }];
    if (padsUsed === 0) {
      out.push({ label: 'FORGE ▶ KIT', hint: 'Original-Track generieren + auf Pads', run: () => chains.forge_to_pads('dusty-boombap') });
      out.push({ label: 'FIRST BEAT', hint: 'Crew-Mission', run: () => LT.startMission('first_beat') });
      out.push({ label: 'PACK ▶ PADS', hint: 'echte Samples', run: () => document.querySelector('#btnLoadPack')?.click() });
      return out;
    }
    if (sel && selBuf && (sel.type === 'loop' || (sel.duration ?? 0) > 2)) {
      out.push({ label: 'LOOP ▶ PADS', hint: 'chops mappen 9–16', run: () => chains.loop_to_pads() });
      out.push({ label: 'STYLE-KLON', hint: 'Essence → Forge → Δ', run: () => chains.style_clone() });
      out.push({ label: 'TUNE ▶ KEY', hint: `snap ${project.key}`, run: () => document.querySelector('#btnFlexTune')?.click() });
      return out;
    }
    if (sel && selBuf && sel.type === 'melodic') {
      out.push({ label: 'TUNE ▶ KEY', hint: `snap ${project.key}`, run: () => document.querySelector('#btnFlexTune')?.click() });
      out.push({ label: 'STYLE-KLON', hint: 'Essence → Forge', run: () => chains.style_clone() });
    }
    if (!stepsUsed) {
      out.push({ label: 'FIRST BEAT', hint: 'Pattern bauen', run: () => LT.startMission('first_beat') });
      out.push({ label: 'FORGE ▶ PADS', hint: 'frisches Kit', run: () => chains.forge_to_pads('deep-house') });
      return out.slice(0, 3);
    }
    if (!transport.playing) {
      out.push({ label: '▶ PLAY', hint: 'Space', run: () => { LT.engine.ensure(); LT.transport.toggle(); LT.renderAll(); } });
      out.push({ label: 'FINISH', hint: 'Auto Mix + Master', run: () => chains.finish() });
      out.push({ label: 'FORGE VARIATION', hint: 'neues Kit dazu', run: () => chains.forge_to_pads('club-drive') });
    } else {
      out.push({ label: '⏹ STOP', hint: '', run: () => { LT.transport.stop(); LT.renderAll(); } });
      out.push({ label: 'HALL +', hint: 'Reverb rein', run: () => {
        const r = LT.engine.rack; if (r) { r.setEnabled('reverb', true); r.setAmount('reverb', 0.45); }
        document.querySelector('.fx-chip[data-fx="reverb"]')?.classList.add('on');
        LT.toast('FX: HALL an');
      } });
      out.push({ label: 'FINISH', hint: 'Mix + Master', run: () => chains.finish() });
    }
    return out.slice(0, 3);
  }

  // ——— UI ———
  let rootEl = null;
  function render(sugs) {
    if (!rootEl) return;
    rootEl.innerHTML = `<div class="cop-h"><b>CO-PILOT</b><span>${state.busy ? 'arbeitet…' : 'schlägt vor'}</span></div>`
      + sugs.map((s, i) => `<button type="button" class="cop-chip" data-i="${i}" ${s.run ? '' : 'disabled'}>
          <b>${s.label}</b>${s.hint ? `<span>${s.hint}</span>` : ''}</button>`).join('');
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
