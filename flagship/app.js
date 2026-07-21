/**
 * LOOPTiSCH v3 UI — cooperative missions + plans + undo
 */
(function () {
  'use strict';

  const { AudioEngine, Project, Transport, AgentRuntime, synthWaveform } = window.LoopTisch;
  const Analyze = window.LoopTischAnalyze;
  const Coop = window.LoopTischCoop;

  const project = new Project();
  const engine = new AudioEngine();
  project.attachEngine(engine);
  Coop.installCoopTools(project, engine);
  const history = new Coop.History(project);
  const runner = new Coop.PlanRunner(project, history);
  const transport = new Transport(project, engine);
  const agents = new AgentRuntime(project);

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  let libFilter = 'all';
  let libQuery = '';
  let playheadStep = 0;
  let playheadBar = 0;
  let tapTimes = [];
  let llmHealth = { ollama_up: false, model: '?' };
  let pendingPlan = null;

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 1800);
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function logTool(entry) {
    const root = $('#toolLog');
    const line = document.createElement('div');
    if (!entry.ok) line.className = 'err';
    const name = entry.name || entry.tool || '?';
    line.innerHTML = `<span class="fn">${escapeHtml(name)}</span> <span class="arg">${escapeHtml(JSON.stringify(entry.args || {}))}</span> ${
      entry.ok ? '→ ' + short(entry.result) : '✗ ' + escapeHtml(entry.error || '')
    }`;
    root.appendChild(line);
    root.scrollTop = root.scrollHeight;
  }
  function short(v) {
    if (v == null) return 'ok';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 72 ? s.slice(0, 70) + '…' : s;
  }
  function addMsg(who, text, user = false) {
    const root = $('#msgs');
    const d = document.createElement('div');
    d.className = 'msg ' + (user ? 'user' : 'bot');
    d.innerHTML = `<div class="who">${escapeHtml(who)}</div>${escapeHtml(text)}`;
    root.appendChild(d);
    root.scrollTop = root.scrollHeight;
  }
  function setAgentStatus(s) {
    $('#agentStatus').textContent = String(s).toUpperCase();
  }
  function updateUndoBtns() {
    const u = $('#btnUndo');
    const r = $('#btnRedo');
    if (u) u.disabled = !history.canUndo();
    if (r) r.disabled = !history.canRedo();
    u && (u.style.opacity = history.canUndo() ? '1' : '0.35');
    r && (r.style.opacity = history.canRedo() ? '1' : '0.35');
  }

  // ——— Missions UI ———
  function renderMissions() {
    const root = $('#missions');
    if (!root) return;
    root.innerHTML = '';
    Coop.listMissions().forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mission' + (m.risk === 'S2' ? ' s2' : '');
      b.innerHTML = `<span class="ico">${m.icon}</span><b>${escapeHtml(m.title)}</b><span>${escapeHtml(m.blurb)}</span>`;
      b.onclick = () => startMission(m.id);
      root.appendChild(b);
    });
  }

  function showPlan(plan, stepStates = []) {
    pendingPlan = plan;
    const panel = $('#planPanel');
    panel.hidden = false;
    $('#planAgent').textContent = plan.agent || 'Host';
    $('#planSay').textContent = plan.say || 'Plan';
    const stepsEl = $('#planSteps');
    const steps = plan.steps || [];
    stepsEl.innerHTML = '';
    if (!steps.length && plan.options) {
      stepsEl.innerHTML = '<div class="plan-step wait"><span class="n">·</span><span class="why">Wähle eine Option unten</span><span class="st">GATE</span></div>';
    } else {
      steps.forEach((s, i) => {
        const st = stepStates[i] || 'wait';
        const row = document.createElement('div');
        row.className = 'plan-step ' + st;
        row.innerHTML = `<span class="n">${String(i + 1).padStart(2, '0')}</span>
          <span class="why">${escapeHtml(s.why || s.tool)} <span class="arg" style="color:var(--muted)">· ${escapeHtml(s.tool)}</span></span>
          <span class="st">${st.toUpperCase()}</span>`;
        stepsEl.appendChild(row);
      });
    }

    const opts = $('#planOptions');
    if (plan.options && plan.options.length) {
      opts.hidden = false;
      opts.innerHTML = '';
      plan.options.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'opt-card';
        b.innerHTML = `<b>${escapeHtml(o.label)}</b><span>${escapeHtml(o.blurb || '')}</span>`;
        b.onclick = () => applyOption(plan, o.id);
        opts.appendChild(b);
      });
    } else {
      opts.hidden = true;
      opts.innerHTML = '';
    }
  }

  function hidePlan() {
    $('#planPanel').hidden = true;
    pendingPlan = null;
  }

  function executePlan(plan) {
    if (plan.options && plan.options.length && !(plan.steps && plan.steps.length)) {
      showPlan(plan);
      addMsg(plan.agent || 'Host', plan.say || 'Wähle eine Option');
      setAgentStatus('gate');
      return { gated: true };
    }

    showPlan(plan, (plan.steps || []).map(() => 'wait'));
    const states = [];
    runner.on(() => {}); // clear? no - use one-shot via runSteps emit
    // Manual step loop for UI feedback
    if ((plan.steps || []).length) history.push(plan.mission || plan.say || 'plan');
    const results = [];
    (plan.steps || []).forEach((step, i) => {
      states[i] = 'run';
      showPlan(plan, states);
      try {
        const result = project.exec_tool(step.tool, step.args || {});
        results.push({ ok: true, step, result });
        logTool({ name: step.tool, args: step.args, ok: true, result });
        states[i] = 'ok';
      } catch (e) {
        const err = String(e.message || e);
        results.push({ ok: false, step, error: err });
        logTool({ name: step.tool, args: step.args, ok: false, error: err });
        states[i] = 'err';
        showPlan(plan, states);
        addMsg(plan.agent || 'Host', 'Schritt bei: ' + (step.why || step.tool));
        setAgentStatus('err');
        updateUndoBtns();
        renderAll();
        return;
      }
      showPlan(plan, states);
    });

    addMsg(plan.agent || 'Host', plan.say || 'Fertig.');
    setAgentStatus('idle');
    updateUndoBtns();
    renderAll();
    toast((plan.agent || 'Crew') + ' · done');
    return { ok: true, results };
  }

  function applyOption(plan, optionId) {
    const opt = (plan.options || []).find((o) => o.id === optionId);
    if (!opt) return;
    executePlan({
      mission: plan.mission,
      say: `${opt.label}: ${opt.blurb || plan.say || ''}`,
      agent: plan.agent || 'Remixer',
      steps: opt.steps || [],
    });
  }

  function startMission(id) {
    engine.ensure();
    const m = Coop.getMission(id);
    if (!m) { toast('unknown mission'); return; }
    setAgentStatus('run');
    addMsg('You', 'Mission: ' + m.title, true);
    const plan = m.build(project);
    executePlan(plan);
    if (id === 'drop_builder' || id === 'remix_night') setMode('arrange');
    if (id === 'break_to_kit') setMode('chop');
  }

  function doUndo() {
    const snap = history.undo();
    if (!snap) { toast('nichts zum Undo'); return; }
    renderAll();
    updateUndoBtns();
    toast('Undo · ' + (snap.label || 'state'));
    addMsg('System', 'Undo: ' + (snap.label || 'letzter Schritt'));
  }
  function doRedo() {
    const snap = history.redo();
    if (!snap) { toast('nichts zum Redo'); return; }
    renderAll();
    updateUndoBtns();
    toast('Redo');
  }

  let libPack = ''; // '' = alle Packs
  async function loadPackIndex(showToast) {
    try {
      const r = await fetch('library/_index.json?ts=' + Date.now());
      if (!r.ok) throw new Error('no_index');
      const idx = await r.json();
      const res = project.addPackIndex(idx);
      renderPackBar();
      renderLibrary();
      if (showToast) toast(`Library: ${res.packs} Packs · ${res.total} Samples`);
      return res;
    } catch {
      renderPackBar();
      return null;
    }
  }
  function renderPackBar() {
    const sel = $('#packSel');
    if (!sel) return;
    const packs = project.packs || [];
    sel.innerHTML =
      '<option value="">ALLE PACKS</option>' +
      packs.map((p) =>
        `<option value="${escapeHtml(p.slug)}"${libPack === p.slug ? ' selected' : ''}>${escapeHtml(
          (p.name || p.slug).toUpperCase().slice(0, 24))} · ${p.count}</option>`).join('');
    const btn = $('#btnLoadPack');
    if (btn) { btn.disabled = !libPack; btn.style.opacity = libPack ? '1' : '.35'; }
  }
  function audition(s) {
    engine.ensure();
    const playIt = () =>
      engine.playSample(s, { vel: 0.9, key: project.key, level: 1 });
    if (s.url && !engine.getBuffer(s.bufferId || s.id)) {
      toast('lade…');
      engine.loadUrl(s.bufferId || s.id, s.url).then(playIt).catch(() => playIt());
    } else playIt();
  }

  // ——— Render body ———
  function renderLibrary() {
    const list = $('#libList');
    const items = project.library.filter((s) => {
      if (libPack && s.pack !== libPack) return false;
      if (libFilter === 'real') { if (!s.real) return false; }
      else if (libFilter !== 'all' && s.type !== libFilter) return false;
      if (!libQuery) return true;
      const t = libQuery.toLowerCase();
      return s.name.toLowerCase().includes(t) || s.type.includes(t) ||
        s.tags.some((x) => x.includes(t)) || s.key.toLowerCase().includes(t) ||
        (s.pack || '').includes(t);
    });
    $('#libCount').textContent = String(items.length);
    list.innerHTML = '';
    const MAXROWS = 400;
    const rows = items.slice(0, MAXROWS);
    rows.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sample' + (project.selectedSampleId === s.id ? ' sel' : '');
      b.draggable = true;
      const conf = s.bpmConfidence != null ? ` · ${Math.round(s.bpmConfidence * 100)}%` : '';
      const dur = s.duration ? ` · ${s.duration.toFixed(1)}s` : '';
      b.innerHTML = `
        <span class="n">${s.real ? '<i class="real-dot"></i>' : ''}${escapeHtml(s.name)}</span>
        <span class="tag ${s.type}">${s.type}</span>
        <span class="meta">${s.bpm ? s.bpm + 'bpm' : '1-shot'}${dur} · ×${(s.stretch || 1).toFixed(2)}${s.rateStretch && (s.stretch || 1) !== 1 ? ' RATE' : ''}${s.real ? conf : ''}</span>
        <span class="aud" title="Probe hören">▶</span>`;
      b.addEventListener('click', (e) => {
        if (e.target.closest('.aud')) { audition(s); return; }
        project.selectedSampleId = s.id;
        history.push('assign');
        const doAssign = () => {
          project.assign_pad(project.selectedPad, s.id);
          if (project.isAudible(project.selectedPad)) {
            engine.playSample(project.pads[project.selectedPad], {
              vel: 0.9, key: project.key, level: project.levels[project.selectedPad],
            });
          }
          updateUndoBtns();
          renderAll();
          toast(`P${project.selectedPad + 1} ← ${s.name}`);
        };
        if (s.url && !engine.getBuffer(s.bufferId || s.id)) {
          engine.loadUrl(s.bufferId || s.id, s.url).then(doAssign).catch(doAssign);
        } else doAssign();
      });
      b.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/sample-id', s.id));
      list.appendChild(b);
    });
    if (items.length > MAXROWS) {
      const more = document.createElement('div');
      more.className = 'lib-more';
      more.textContent = `+${items.length - MAXROWS} weitere — Suche/Filter nutzen`;
      list.appendChild(more);
    }
  }

  const TYPE_COLORS = {
    kick: '#ff4d7e', snare: '#ffb84d', hat: '#4dd2ff', perc: '#9dff4d',
    melodic: '#c44dff', loop: '#4dffc3',
  };
  function drawPadWave(canvas, s) {
    const c2 = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const color = TYPE_COLORS[s.type] || '#ff4d7e';
    c2.clearRect(0, 0, W, H);
    let peaks = s.waveform;
    if (!peaks) {
      const buf = s.bufferId ? engine.getBuffer(s.bufferId) : null;
      if (buf) {
        try { peaks = Analyze.waveformPeaks(Analyze.monoFromBuffer(buf), 180); s.waveform = peaks; } catch { /* noop */ }
      } else if (s.url) {
        // async: decode then redraw pads once
        engine.loadUrl(s.bufferId || s.id, s.url).then(() => renderPads()).catch(() => {});
      }
    }
    if (!peaks) {
      // placeholder: type-colored pulse line
      c2.strokeStyle = color + '55';
      c2.beginPath(); c2.moveTo(0, H / 2); c2.lineTo(W, H / 2); c2.stroke();
      return;
    }
    const n = peaks.length;
    const bw = W / n;
    const grad = c2.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color + '99');
    c2.fillStyle = grad;
    const a0 = s.chopStart != null ? s.chopStart : 0;
    const a1 = s.chopEnd != null ? s.chopEnd : 1;
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, peaks[i]);
      const h = Math.max(1.5, v * (H - 6));
      const x = i * bw;
      c2.globalAlpha = (i / n >= a0 && i / n <= a1) ? 0.95 : 0.18;
      c2.fillRect(x, (H - h) / 2, Math.max(0.7, bw - 0.3), h);
    }
    c2.globalAlpha = 1;
  }

  function renderPads() {
    const root = $('#pads');
    root.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const s = project.pads[i];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad'
        + (s ? '' : ' empty')
        + (project.selectedPad === i ? ' sel' : '')
        + (project.muted[i] ? ' muted' : '');
      b.dataset.pad = String(i);
      b.dataset.type = s ? s.type : '';
      const flags = [];
      if (project.muted[i]) flags.push('<span class="flag m">M</span>');
      if (project.solo[i]) flags.push('<span class="flag s">S</span>');
      b.innerHTML = `
        <span class="idx">P${i + 1}</span>
        <span class="flags">${flags.join('')}</span>
        <canvas class="pad-wave" width="180" height="54" aria-hidden="true"></canvas>
        <span class="lbl">${s ? escapeHtml(s.name.replace(/_/g, ' ')) : 'empty'}</span>
        <span class="sub">${s ? `${s.type} · ×${(s.stretch || 1).toFixed(2)}` : 'drop sample'}</span>`;
      if (s) drawPadWave(b.querySelector('.pad-wave'), s);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        project.selectedPad = i;
        const rect = b.getBoundingClientRect();
        const y = (e.clientY - rect.top) / rect.height;
        const vel = Math.max(0.2, Math.min(1, 1 - y * 0.75));
        if (project.isAudible(i)) {
          engine.playSample(project.pads[i], {
            vel, key: project.key, level: project.levels[i],
          });
        }
        b.classList.add('hit');
        setTimeout(() => b.classList.remove('hit'), 70);
        if (transport.recording && transport.playing) {
          history.push('rec-step');
          project.set_step(i, playheadStep, vel);
          updateUndoBtns();
        }
        renderPads();
        renderInspector();
        renderSeq();
        renderMixer();
      });
      b.addEventListener('dragover', (e) => e.preventDefault());
      b.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/sample-id');
        if (id) {
          history.push('drop-pad');
          project.assign_pad(i, id);
          updateUndoBtns();
          renderAll();
          toast(`P${i + 1} ← drop`);
        }
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        history.push('mute');
        project.toggle_mute(i);
        updateUndoBtns();
        renderPads();
        renderSeq();
        renderMixer();
      });
      root.appendChild(b);
    }
  }

  function renderMixer() {
    const root = $('#mixer');
    if (!root) return;
    root.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const row = document.createElement('div');
      row.className = 'mix-row';
      row.innerHTML = `<span>${i + 1}</span>`;
      const sl = document.createElement('input');
      sl.type = 'range';
      sl.min = 0; sl.max = 100;
      sl.value = Math.round(project.levels[i] * 100);
      sl.title = `P${i + 1} level`;
      sl.addEventListener('change', () => history.push('level'));
      sl.addEventListener('input', () => {
        project.set_level(i, sl.value / 100);
      });
      row.appendChild(sl);
      root.appendChild(row);
    }
  }

  function renderSeq() {
    const grid = $('#seqGrid');
    const pat = project.pattern;
    const ph = transport.playing ? playheadStep : -1;
    let html = `<div class="cell head"></div>`;
    for (let s = 0; s < 16; s++) html += `<div class="cell head">${s + 1}</div>`;
    for (let pad = 0; pad < 16; pad++) {
      const sample = project.pads[pad];
      const labOn = project.selectedPad === pad ? ' on' : '';
      const muted = project.muted[pad] ? ' muted' : '';
      html += `<div class="seq-lab${labOn}${muted}" data-pad="${pad}" data-type="${sample ? sample.type : ''}"><span class="dot"></span>P${pad + 1}${
        sample ? ' ' + sample.type.slice(0, 3) : ''
      }</div>`;
      for (let step = 0; step < 16; step++) {
        const on = pat.tracks[pad][step] > 0;
        html += `<button type="button" class="cell${on ? ' on' : ''}${step % 4 === 0 ? ' bar' : ''}${ph === step ? ' ph' : ''}" data-pad="${pad}" data-step="${step}"></button>`;
      }
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.seq-lab').forEach((el) => {
      el.addEventListener('click', () => {
        project.selectedPad = +el.dataset.pad;
        renderPads(); renderInspector(); renderSeq();
      });
      el.addEventListener('dblclick', () => {
        history.push('mute');
        project.toggle_mute(+el.dataset.pad);
        updateUndoBtns();
        renderPads(); renderSeq();
      });
    });
    grid.querySelectorAll('button.cell').forEach((el) => {
      el.addEventListener('click', () => {
        const pad = +el.dataset.pad;
        const step = +el.dataset.step;
        const cur = project.pattern.tracks[pad][step];
        history.push('step');
        project.set_step(pad, step, cur ? 0 : 1);
        project.selectedPad = pad;
        updateUndoBtns();
        renderSeq(); renderPads(); renderInspector();
      });
    });
  }

  function renderArrange() {
    const root = $('#arrange');
    const cycle = [null, 'A1', 'A2', 'B1'];
    let html = `<div class="arr-lab"></div>`;
    for (let b = 0; b < 8; b++) html += `<div class="arr-head">B${b + 1}</div>`;
    html += `<div class="arr-lab">CLIP</div>`;
    for (let b = 0; b < 8; b++) {
      const v = project.arrangement[b];
      const ph = transport.playing && playheadBar === b && project.arrangement.some(Boolean) ? ' ph' : '';
      html += `<button type="button" class="arr-cell${v ? ' filled' : ''}${ph}" data-bar="${b}">${v || '·'}</button>`;
    }
    root.innerHTML = html;
    root.querySelectorAll('.arr-cell').forEach((el) => {
      el.addEventListener('click', () => {
        const bar = +el.dataset.bar;
        const cur = project.arrangement[bar];
        const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
        history.push('arrange');
        project.set_arrangement_bar(bar, next);
        updateUndoBtns();
        renderArrange();
      });
    });
  }

  function renderInspector() {
    const s = project.pads[project.selectedPad];
    const dl = $('#inspDl');
    if (!s) {
      dl.innerHTML = `
        <div><dt>Pad</dt><dd>P${project.selectedPad + 1}</dd></div>
        <div><dt>Sample</dt><dd>empty</dd></div>
        <div><dt>Hint</dt><dd>Mission · Import · Drop</dd></div>`;
      $('#chopName').textContent = 'no sample';
      return;
    }
    dl.innerHTML = `
      <div><dt>Pad</dt><dd>P${project.selectedPad + 1}</dd></div>
      <div><dt>Sample</dt><dd>${escapeHtml(s.name)}</dd></div>
      <div><dt>Type</dt><dd>${s.type}${s.real ? ' · real' : ''}</dd></div>
      <div><dt>Pack</dt><dd>${s.pack ? escapeHtml(s.pack) : '—'}</dd></div>
      <div><dt>BPM</dt><dd>${s.bpm || '—'} → ${project.bpm}</dd></div>
      <div><dt>Stretch</dt><dd>×${(s.stretch || 1).toFixed(3)}${s.rateStretch && (s.stretch || 1) !== 1 ? ' · RATE' : ''}</dd></div>
      <div><dt>Level</dt><dd>${Math.round(project.levels[project.selectedPad] * 100)}%</dd></div>
      <div><dt>Mute</dt><dd>${project.muted[project.selectedPad] ? 'ON' : 'off'}</dd></div>
      <div><dt>Tags</dt><dd>${s.tags.slice(0, 5).join(', ')}</dd></div>`;
    $('#chopName').textContent = s.name;
  }

  function renderWave() {
    const canvas = $('#wave');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 1200;
    const cssH = 220;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW, h = cssH;

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--well').trim() || '#111';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'oklch(0.25 0.02 280)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = (i / 8) * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }

    const sample =
      project.pads[project.selectedPad] ||
      project.findSample(project.selectedSampleId) ||
      project.library.find((x) => x.real && x.type === 'loop') ||
      project.library.find((x) => x.type === 'loop');

    let data;
    if (sample?.waveform?.length) data = sample.waveform;
    else if (sample?.bufferId && engine.getBuffer(sample.bufferId) && Analyze) {
      data = Analyze.waveformPeaks(Analyze.monoFromBuffer(engine.getBuffer(sample.bufferId)), 700);
      sample.waveform = data;
    } else data = synthWaveform(sample).data;

    const mid = h / 2;
    const real = !!(sample && sample.real);
    ctx.beginPath();
    const n = data.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = mid - (data[i] || 0) * (h * 0.4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = (i / (n - 1)) * w;
      ctx.lineTo(x, mid + (data[i] || 0) * (h * 0.4));
    }
    ctx.closePath();
    ctx.fillStyle = real ? 'oklch(0.68 0.22 355 / 0.22)' : 'oklch(0.82 0.12 195 / 0.15)';
    ctx.fill();
    ctx.strokeStyle = real ? 'oklch(0.72 0.22 355)' : 'oklch(0.82 0.12 195)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    const marks = project.chops.length ? project.chops : sample?.onsets || [];
    marks.forEach((p, i) => {
      const x = p * w;
      ctx.strokeStyle = 'oklch(0.82 0.12 195)';
      ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, h - 6); ctx.stroke();
      ctx.fillStyle = 'oklch(0.82 0.12 195)';
      ctx.font = '10px IBM Plex Mono, monospace';
      ctx.fillText(String(i + 1), x + 3, 14);
    });

    const src = project.chopMeta?.source || (real ? 'real' : 'synth');
    $('#chopMeta').textContent = sample
      ? `${sample.name} · ${marks.length} chops · ${sample.bpm || '—'} bpm · ×${(sample.stretch || 1).toFixed(3)} · ${src}`
      : 'Import or select a loop';
  }

  function renderTransport() {
    $('#bpmIn').value = project.bpm;
    $('#keyIn').value = project.key;
    $('#swingIn').value = project.swing;
    $('#swingVal').textContent = project.swing;
    $('#patLabel').textContent = project.patternId;
    $('#bankLabel').textContent = project.bank;
    $('#btnPlay').setAttribute('aria-pressed', transport.playing);
    const bar = String(playheadBar + 1).padStart(2, '0');
    const step = String(playheadStep + 1).padStart(2, '0');
    $('#clock').textContent = `${bar}.${step}`;
    const elapsed = transport.playing ? (performance.now() - transport.startedAt) / 1000 : 0;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    $('#clockTime').textContent = `${mm}:${ss}`;
  }

  function renderMeters() {
    const m = engine.meter;
    $('#mL').style.width = Math.min(100, m.l * 160) + '%';
    $('#mR').style.width = Math.min(100, m.r * 160) + '%';
    requestAnimationFrame(renderMeters);
  }

  function renderAll() {
    renderLibrary();
    renderPads();
    renderMixer();
    renderSeq();
    renderArrange();
    renderInspector();
    renderTransport();
    if (project.mode === 'chop') renderWave();
  }

  function setMode(mode) {
    project.mode = mode;
    $$('.mode-seg button').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    });
    $$('.view').forEach((v) => {
      const on = v.dataset.view === mode;
      v.classList.toggle('on', on);
      v.hidden = !on;
    });
    if (mode === 'chop') renderWave();
  }

  // ——— Import / LLM ———
  async function importFiles(fileList, assignToPad = null) {
    const files = [...fileList].filter((f) => /audio|\.wav|\.aif|\.mp3|\.ogg|\.flac/i.test(f.type + f.name));
    if (!files.length) { toast('No audio'); return []; }
    engine.ensure();
    history.push('import');
    setAgentStatus('analyze');
    const imported = [];
    for (const file of files) {
      try {
        const ab = await file.arrayBuffer();
        const audioBuffer = await engine.decodeFile(ab);
        const analysis = Analyze.analyzeAudioBuffer(audioBuffer, { name: file.name });
        const bufferId = project.nextId('buf');
        engine.storeBuffer(bufferId, audioBuffer);
        const meta = project.import_sample({ name: file.name, bufferId, analysis });
        imported.push(meta);
        logTool({ name: 'import_sample', args: { name: file.name }, ok: true, result: meta });
        if (assignToPad != null) {
          project.assign_pad(assignToPad, meta.id);
          assignToPad = Math.min(15, assignToPad + 1);
        }
        addMsg('Librarian', `Import ${meta.name}: ${meta.type}, ${meta.bpm || '1-shot'} bpm, ${meta.onsets} onsets`);
      } catch (err) {
        addMsg('Librarian', `Fail ${file.name}: ${err.message || err}`);
        logTool({ name: 'import_sample', args: { name: file.name }, ok: false, error: String(err.message || err) });
      }
    }
    setAgentStatus('idle');
    updateUndoBtns();
    renderAll();
    if (imported.length) {
      toast(`${imported.length} analyzed`);
      setMode('chop');
      // Offer next mission
      addMsg('Host', 'Sample da. Nächste Mission: Break → Kit — oder First Beat.');
    }
    return imported;
  }

  async function refreshHealth() {
    try {
      const r = await fetch('api/health');
      if (!r.ok) throw new Error('no');
      llmHealth = await r.json();
      $('#llmMeta').textContent = llmHealth.ollama_up ? llmHealth.model : 'ollama offline';
    } catch {
      llmHealth = { ollama_up: false, model: 'static' };
      $('#llmMeta').textContent = 'static · local agents';
      const t = $('#useLlm');
      if (t) t.checked = false;
    }
  }

  async function runAgent(text, hint) {
    if (!text.trim()) return;
    engine.ensure();
    setAgentStatus('run');
    addMsg('You', text, true);
    const useLlm = $('#useLlm')?.checked !== false;

    const applyServerPlan = (plan) => {
      const normalized = {
        mission: plan.mission || 'chat',
        say: plan.say || 'ok',
        agent: plan.agent || 'Host',
        steps: plan.steps || (plan.tools || []).map((t) => ({
          tool: t.name || t.tool,
          args: t.args || {},
          why: t.why || t.name || t.tool,
          risk: t.risk || 'S1',
        })),
        options: plan.options || null,
      };
      if (plan.fallback) normalized.say = (normalized.say || '') + ' · local';
      executePlan(normalized);
      const blob = text + ' ' + (normalized.say || '');
      if (/drop|form|arrang/i.test(blob)) setMode('arrange');
      if (/chop|slice|break/i.test(blob)) setMode('chop');
    };

    try {
      if (useLlm) {
        const res = await fetch('api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: hint ? `[${hint}] ${text}` : text,
            snapshot: project.snapshot_for_llm(),
            use_llm: true,
          }),
        });
        const plan = await res.json();
        applyServerPlan(plan);
      } else {
        // local deterministic via server fallback shape
        const out = agents.run(text, hint);
        const steps = out.calls
          .filter((c) => c.ok)
          .map((c) => ({ tool: c.name, args: c.args, why: c.name, risk: 'S1' }));
        // agents already mutated — rebuild UI + fake plan for transparency
        // Undo: push was not taken; push empty and re-run via tools would double.
        // Better: map agent results into display only
        showPlan({
          agent: out.agent,
          say: out.say.join(' · '),
          steps: out.calls.map((c) => ({ tool: c.name, args: c.args, why: c.name })),
        }, out.calls.map((c) => (c.ok ? 'ok' : 'err')));
        out.calls.forEach(logTool);
        out.say.forEach((line) => addMsg(out.agent, line));
        setAgentStatus('idle');
        renderAll();
        toast(out.agent + ' · local');
      }
    } catch (err) {
      addMsg('System', 'LLM fail → local mission. ' + (err.message || err));
      // try mission guess
      const q = text.toLowerCase();
      if (/genre|house|remix|style/.test(q)) startMission('genre_skin');
      else if (/drop|form/.test(q)) startMission('drop_builder');
      else if (/chop|break/.test(q)) startMission('break_to_kit');
      else if (/fix|dünn|thin|mix/.test(q)) startMission('fix_mix');
      else startMission('first_beat');
    }
  }

  // ——— Events ———
  $('#btnPlay').onclick = () => {
    engine.ensure();
    transport.toggle();
    renderTransport();
  };
  $('#btnStop').onclick = () => {
    transport.stop();
    playheadStep = 0; playheadBar = 0;
    renderTransport(); renderSeq(); renderArrange();
  };
  $('#btnRec').onclick = () => {
    transport.recording = !transport.recording;
    $('#btnRec').setAttribute('aria-pressed', transport.recording);
    toast(transport.recording ? 'REC on' : 'REC off');
  };
  $('#bpmIn').onchange = () => {
    history.push('bpm');
    project.set_bpm(+$('#bpmIn').value);
    updateUndoBtns();
    renderAll();
  };
  $('#keyIn').onchange = () => {
    history.push('key');
    project.set_key($('#keyIn').value);
    updateUndoBtns();
    renderInspector();
  };
  $('#swingIn').oninput = () => {
    project.set_swing(+$('#swingIn').value);
    $('#swingVal').textContent = project.swing;
  };
  $('#swingIn').onchange = () => { history.push('swing'); updateUndoBtns(); };
  $('#driveIn').oninput = () => engine.setDrive(+$('#driveIn').value / 100);
  $('#volIn').oninput = () => engine.setMasterVol(+$('#volIn').value / 100);
  $('#btnTap').onclick = () => {
    const now = performance.now();
    tapTimes.push(now);
    tapTimes = tapTimes.filter((t) => now - t < 3000).slice(-6);
    if (tapTimes.length >= 2) {
      let sum = 0;
      for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i - 1];
      const bpm = Math.round(60000 / (sum / (tapTimes.length - 1)));
      history.push('tap');
      project.set_bpm(bpm);
      updateUndoBtns();
      renderAll();
      toast('TAP ' + bpm);
    }
  };
  $('#btnUndo').onclick = doUndo;
  $('#btnRedo').onclick = doRedo;
  $('#btnPlanUndo').onclick = doUndo;
  $('#btnPlanDismiss').onclick = hidePlan;
  $('#btnPlanPlay').onclick = () => {
    engine.ensure();
    if (!transport.playing) transport.start();
    renderTransport();
  };

  $$('.mode-seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  $$('[data-pat]').forEach((b) => {
    b.onclick = () => { project.patternId = b.dataset.pat; renderAll(); };
  });
  $$('[data-bank]').forEach((b) => {
    b.onclick = () => { project.bank = b.dataset.bank; $('#bankLabel').textContent = project.bank; };
  });
  $('#btnClearPat').onclick = () => {
    history.push('clear-pat');
    project.clear_pattern();
    updateUndoBtns();
    renderSeq();
    toast('pattern cleared');
  };
  $('#btnArrClear').onclick = () => {
    history.push('arr-clear');
    project.arrangement = Array(8).fill(null);
    project.emit('arrange');
    updateUndoBtns();
    renderArrange();
  };
  $('#btnArrBuild').onclick = () => startMission('drop_builder');
  $('#btnDetect').onclick = () => {
    const s = project.pads[project.selectedPad] || project.library.find((x) => x.type === 'loop');
    if (s) {
      history.push('detect');
      const r = project.detect_onsets(s.id);
      logTool({ name: 'detect_onsets', args: { id: s.id }, ok: true, result: r });
      updateUndoBtns();
      renderWave();
      toast('onsets ' + r.chops.length);
    }
  };
  $('#btnMapChops').onclick = () => startMission('break_to_kit');
  $('#btnRescan').onclick = async () => {
    toast('scan library…');
    try {
      await fetch('api/rescan', { method: 'POST' });
    } catch { /* static fallback */ }
    const res = await loadPackIndex(true);
    addMsg('Librarian', res
      ? `Rescan: ${res.packs} Packs · ${res.total} Samples in der Library.`
      : 'Kein Library-Index — library/packs/ ist leer.');
  };
  const packSel = $('#packSel');
  if (packSel) packSel.onchange = () => {
    libPack = packSel.value;
    renderPackBar();
    renderLibrary();
  };
  const btnLoadPack = $('#btnLoadPack');
  if (btnLoadPack) btnLoadPack.onclick = () => {
    if (!libPack) return;
    history.push('pack-kit');
    try {
      const r = project.load_pack_kit(libPack);
      logTool({ name: 'load_pack_kit', args: { pack: libPack }, ok: true, result: r });
      toast(`Kit: ${libPack} · ${r.count} Pads`);
      addMsg('Librarian', `Kit aus ${libPack}: ${r.count} Pads belegt.`);
    } catch (e) {
      logTool({ name: 'load_pack_kit', args: { pack: libPack }, ok: false, error: String(e.message || e) });
      toast('Pack hat nichts Brauchbares');
    }
    updateUndoBtns();
    renderAll();
  };

  $('#libSearch').oninput = (e) => { libQuery = e.target.value; renderLibrary(); };
  $$('#filters button').forEach((b) => {
    b.onclick = () => {
      libFilter = b.dataset.f;
      $$('#filters button').forEach((x) => x.classList.toggle('on', x === b));
      renderLibrary();
    };
  });

  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#chatIn').value;
    $('#chatIn').value = '';
    runAgent(v);
  };
  $$('.crew').forEach((b) => {
    b.onclick = () => {
      $$('.crew').forEach((c) => c.classList.remove('busy'));
      b.classList.add('busy');
      const mid = b.dataset.mission;
      if (mid) startMission(mid);
      else if (b.dataset.prompt) runAgent(b.dataset.prompt, b.querySelector('b')?.textContent);
      setTimeout(() => b.classList.remove('busy'), 400);
    };
  });
  $('#btnClearLog').onclick = () => { $('#toolLog').innerHTML = ''; };
  $('#fileIn').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };

  const overlay = $('#dropOverlay');
  const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dragHideTimer = null;
  const showOverlay = () => { overlay.hidden = false; };
  const hideOverlay = () => { clearTimeout(dragHideTimer); overlay.hidden = true; };
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    showOverlay();
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    showOverlay();
    // auto-hide: wenn der Drag das Fenster verlässt oder abbricht,
    // feuert kein dragover mehr → Overlay schließt sich selbst
    clearTimeout(dragHideTimer);
    dragHideTimer = setTimeout(hideOverlay, 200);
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) hideOverlay(); // Drag verlässt Fenster
  });
  window.addEventListener('dragend', hideOverlay);
  overlay.addEventListener('click', hideOverlay); // wegklickbar
  window.addEventListener('drop', (e) => {
    hideOverlay();
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const padEl = e.target.closest?.('.pad');
    const padIdx = padEl ? +padEl.dataset.pad : project.selectedPad;
    importFiles(e.dataTransfer.files, Number.isFinite(padIdx) ? padIdx : 0);
  });

  const keyMap = {
    '1': 0, '2': 1, '3': 2, '4': 3,
    q: 4, w: 5, e: 6, r: 7,
    a: 8, s: 9, d: 10, f: 11,
    z: 12, x: 13, c: 14, v: 15,
  };
  window.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input, select, textarea')) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (ev.code === 'Space') {
      ev.preventDefault();
      engine.ensure();
      transport.toggle();
      renderTransport();
      return;
    }
    if (ev.key === 'Escape') {
      hideOverlay();
      transport.stop(); playheadStep = 0; playheadBar = 0;
      renderTransport(); renderSeq();
      return;
    }
    if (ev.key === 'm' || ev.key === 'M') {
      history.push('mute');
      project.toggle_mute(project.selectedPad);
      updateUndoBtns();
      renderPads(); renderSeq(); renderInspector();
      return;
    }
    const pad = keyMap[ev.key.toLowerCase()];
    if (pad != null) {
      project.selectedPad = pad;
      if (project.isAudible(pad)) {
        engine.playSample(project.pads[pad], {
          vel: ev.shiftKey ? 1 : 0.88,
          key: project.key,
          level: project.levels[pad],
        });
      }
      const el = $$('.pad')[pad];
      if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 70); }
      if (transport.recording && transport.playing) {
        history.push('rec');
        project.set_step(pad, playheadStep, 0.9);
        updateUndoBtns();
      }
      renderPads(); renderInspector(); renderSeq();
    }
  });

  transport.onTick = (step, bar) => {
    playheadStep = step;
    playheadBar = bar;
    $$('#seqGrid .cell.ph').forEach((c) => c.classList.remove('ph'));
    $$(`#seqGrid button.cell[data-step="${step}"]`).forEach((c) => c.classList.add('ph'));
    renderTransport();
    if (project.mode === 'arrange') {
      $$('#arrange .arr-cell').forEach((c) => {
        c.classList.toggle('ph', +c.dataset.bar === bar && project.arrangement.some(Boolean));
      });
    }
    for (let p = 0; p < 16; p++) {
      if (project.pattern.tracks[p][step] && project.pads[p] && project.isAudible(p)) {
        const el = $$('.pad')[p];
        if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 55); }
      }
    }
  };

  // boot
  engine.ensure();
  engine.setDrive(0.22);
  engine.setMasterVol(0.78);
  renderMissions();
  addMsg('LOOPTiSCH', 'v4 · echte Packs in der Library · Missionen oben · Crew rechts · Undo jederzeit.');
  renderAll();
  loadPackIndex(false).then((res) => {
    if (res && res.added) {
      addMsg('Librarian', `${res.packs} Packs · ${res.added} echte Samples indexiert. Mission „Pack → Kit“ probieren.`);
    }
    renderAll();
    // Boot-Erlebnis: nie leer starten — echtes Kit sofort spielbar
    if (project.pads.every((p) => !p) && window.LT_COPILOT_API) {
      addMsg('Co-Pilot', 'Start-Kit: Forge rendert mit echten Samples — gleich spielbar.');
      window.LT_COPILOT_API.chains.forge_to_pads('dusty-boombap');
    }
  });
  updateUndoBtns();
  renderMeters();
  refreshHealth();
  setInterval(refreshHealth, 15000);

  window.LT = {
    project, engine, transport, agents, history, runner,
    renderAll, runAgent, startMission, importFiles, loadPackIndex, Analyze, Coop,
    toast, addMsg, setMode, renderMixer, renderPads, renderInspector,
  };

  // ——— STYLE FORGE wiring ———
  (function initForge() {
    if (!window.LT_FORGE) return;
    const preset = () => $('#forgePreset')?.value || 'dusty-boombap';
    const status = (t) => { const el = $('#forgeStatus'); if (el) el.textContent = t; };
    const deltaEl = () => $('#forgeDelta');

    $('#btnForge') && ($('#btnForge').onclick = () => {
      window.LT_COPILOT_API?.chains.forge_to_pads(preset());
    });
    $('#btnForgeOnly') && ($('#btnForgeOnly').onclick = async () => {
      status('rendere…');
      try {
        const { buffer, meta } = await LT_FORGE.forgeSmart({ ...LT_FORGE.PRESETS[preset()], seed: (Math.random() * 1e9) | 0 }, { project, engine });
        const analysis = Analyze.analyzeAudioBuffer(buffer, { name: 'forge' });
        const bufferId = project.nextId('buf');
        engine.storeBuffer(bufferId, buffer);
        const m = project.import_sample({ name: `forge-${preset()}-${meta.seed.toString(36)}`, bufferId, analysis });
        const s = project.findSample(m.id);
        s.license = meta.license;
        status(`✓ ${m.name} · ${buffer.duration.toFixed(1)}s · ${m.bpm || '?'} bpm · ${m.onsets} onsets · seed ${meta.seed} · ${meta.license}`);
        addMsg('Forge', `Render fertig: ${m.name} (nur importiert — Co-Pilot kann mappen)`);
        renderAll();
      } catch (err) { status('Fail: ' + (err.message || err)); }
    });
    $('#btnStyleClone') && ($('#btnStyleClone').onclick = () => window.LT_COPILOT_API?.chains.style_clone());
    $('#btnEssencePad') && ($('#btnEssencePad').onclick = () => {
      const s = project.pads[project.selectedPad];
      const buf = s?.bufferId ? engine.getBuffer(s.bufferId) : null;
      if (!buf) { toast('Pad mit decodiertem Sample wählen'); return; }
      const sig = LT_ESSENCE.signatureFromBuffer(buf, { name: s.name, origin: 'reference' });
      addMsg('Essence', `${s.name}: ${sig.bpm || '?'}bpm · KEY ${sig.key} (${sig.key_confidence}) · energy ${sig.energy} · density ${sig.onset_density}/s · swing ${sig.swing}`);
      status(`Essence ${s.name}: ${sig.bpm || '—'}bpm · ${sig.key} · E ${sig.energy} · D ${sig.onset_density}/s · SW ${sig.swing}`);
      window.LT_COPILOT_API && (window.LT_COPILOT_API.state.lastEssence = sig);
      if (deltaEl()) deltaEl().textContent = '';
    });

    // engine-Δ: forged vs pad essence (server bridge, honest fallback client-side)
    window.LT_measureTreue = async (forgedBuffer, refBuffer) => {
      try {
        const [a, b] = [LT_ESSENCE.wavFromBuffer(refBuffer), LT_ESSENCE.wavFromBuffer(forgedBuffer)];
        const [ra, rb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
        const r = await fetch('api/essence/delta', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wav_a: LT_ESSENCE.b64encode(ra), wav_b: LT_ESSENCE.b64encode(rb) }),
        });
        const d = await r.json();
        if (d.ok && d.pairs?.length) return { engine: true, distance: d.pairs[0].distance, similarity: d.pairs[0].similarity, relation: d.pairs[0].relation };
      } catch (e) { /* static fallback */ }
      const sa = LT_ESSENCE.signatureFromBuffer(refBuffer, {});
      const sb = LT_ESSENCE.signatureFromBuffer(forgedBuffer, {});
      const dd = LT_ESSENCE.essenceDelta(sa, sb);
      return { engine: false, distance: dd.distance, similarity: dd.similarity };
    };
  })();

  // ——— CO-PILOT boot ———
  if (window.LT_COPILOT) window.LT_COPILOT.init(window.LT);

  // ——— FX LAB: rack, flex, master ———
  (function initLab() {
    const rack = () => engine.rack;
    const suite = () => engine.masterSuite;

    // FX chips
    const rackEl = $('#fxRack');
    if (rackEl && rack()) {
      rackEl.innerHTML = rack().slots.map((s) => `
        <div class="fx-chip" data-fx="${s.id}">
          <button type="button" class="fx-name">${s.name}</button>
          <input type="range" min="0" max="100" value="${Math.round(s.amount * 100)}" />
        </div>`).join('');
      rackEl.querySelectorAll('.fx-chip').forEach((chip) => {
        const id = chip.dataset.fx;
        chip.querySelector('.fx-name').onclick = () => {
          const on = !chip.classList.contains('on');
          chip.classList.toggle('on', on);
          rack().setEnabled(id, on);
        };
        chip.querySelector('input').oninput = (e) => rack().setAmount(id, e.target.value / 100);
      });
    }

    // FLEX: offline DSP on selected pad buffer
    const prog = $('#flexProg');
    const progBar = prog?.querySelector('i');
    const setProg = (v) => { if (!prog) return; prog.hidden = v >= 1; progBar.style.width = Math.round(v * 100) + '%'; };
    const padBuf = () => {
      const s = project.pads[project.selectedPad];
      const buf = s && s.bufferId ? engine.getBuffer(s.bufferId) : null;
      return { s, buf };
    };
    const updateFlexTarget = () => {
      const { s, buf } = padBuf();
      $('#flexTarget').textContent = s
        ? `Pad ${project.selectedPad + 1} · ${s.name}${buf ? '' : ' · (lädt beim ersten Hit)'}`
        : 'kein Pad gewählt — Pad anklicken';
    };
    project.on(() => updateFlexTarget());
    updateFlexTarget();

    async function applyFlex(fn, label) {
      const { s, buf } = padBuf();
      if (!s || !buf) { toast('FLEX: Pad mit Sample wählen'); return; }
      engine.ensure();
      setProg(0.01);
      try {
        const chans = LT_DSP.toChannels(buf);
        const out = await fn(chans, buf.sampleRate);
        const nb = LT_DSP.fromChannels(engine.ctx, out, buf.sampleRate);
        engine.storeBuffer(s.bufferId, nb);
        addMsg('Flex', `${label}: ${s.name} · ${nb.duration.toFixed(2)}s`);
        toast('FLEX ✓ ' + label);
      } catch (err) {
        addMsg('Flex', 'Fail: ' + (err.message || err));
      }
      setProg(1);
      renderInspector();
    }

    document.querySelectorAll('[data-flex]').forEach((b) => {
      b.onclick = () => {
        const kind = b.dataset.flex;
        if (kind === 'reverse') applyFlex((c) => LT_DSP.reverse(c), 'REVERSE');
        if (kind === 'trim') applyFlex((c, sr) => LT_DSP.trimSilence(c, sr), 'TRIM');
        if (kind === 'norm') applyFlex((c) => LT_DSP.normalize(c), 'NORMALIZE');
      };
    });
    document.querySelectorAll('[data-stretch]').forEach((b) => {
      b.onclick = () => {
        const r = +b.dataset.stretch;
        applyFlex(async (c, sr) => {
          const out = await LT_DSP.wsola(c, sr, r, setProg);
          const { s } = padBuf();
          if (s && s.bpm) { s.bpm = +(s.bpm / r).toFixed(1); s.stretch = +(project.bpm / s.bpm).toFixed(3); }
          return out;
        }, 'TIME ×' + r);
      };
    });
    $('#btnFlexBpm').onclick = () => {
      const { s } = padBuf();
      if (!s || !s.bpm) { toast('Sample hat kein BPM'); return; }
      const r = +(project.bpm / s.bpm).toFixed(3);
      applyFlex(async (c, sr) => {
        const out = await LT_DSP.wsola(c, sr, r, setProg);
        s.bpm = project.bpm; s.stretch = 1;
        return out;
      }, `BPM ${s.bpm}→${project.bpm}`);
    };
    $('#flexPitch').oninput = (e) => { $('#flexPitchVal').textContent = e.target.value + ' st'; };
    $('#btnFlexPitch').onclick = () => {
      const st = +$('#flexPitch').value;
      if (!st) { toast('0 st — nichts zu tun'); return; }
      applyFlex((c, sr) => LT_DSP.pitchShift(c, sr, st, setProg), `PITCH ${st > 0 ? '+' : ''}${st}st`);
    };
    $('#flexTune').oninput = (e) => { $('#flexTuneVal').textContent = +e.target.value >= 95 ? 'hard' : e.target.value + '%'; };
    $('#btnFlexTune').onclick = () => {
      const strength = +$('#flexTune').value / 100;
      applyFlex((c, sr) => LT_DSP.tuneToScale(c, sr, project.key, strength, setProg), `TUNE→${project.key}`);
    };

    // MASTER
    const lufsEl = $('#lufsVal');
    if (suite()) {
      suite().onMeter = (lufs) => {
        if (project.mode === 'lab' && lufsEl) lufsEl.textContent = lufs <= -65 ? '—' : lufs.toFixed(1);
      };
    }
    $('#masterTarget').onchange = (e) => suite() && suite().setTarget(+e.target.value);
    $('#btnAutoMaster').onclick = (e) => {
      if (!suite()) return;
      const on = !suite().enabled;
      suite().setEnabled(on, engine);
      e.target.textContent = 'AUTO MASTER: ' + (on ? 'AN' : 'AUS');
      e.target.classList.toggle('on', on);
      toast(on ? `AUTO MASTER → ${suite().target} LUFS` : 'AUTO MASTER aus');
    };
    $('#btnAutoMix').onclick = () => {
      const res = LT_MASTER.autoMix(project, engine, (m) => logTool({ name: 'auto_mix', ok: true, result: m }));
      toast(`AUTO MIX ✓ ${res.length} Pads gestaged`);
      addMsg('Mixer', `Auto-Mix: ${res.length} Pads gain-gestaged (RMS-Rollen)`);
      renderMixer();
    };
    $('#btnRefMaster') && ($('#btnRefMaster').onclick = () => window.LT_COPILOT_API?.chains.ref_master());

    // Spectrum im Header
    const spec = $('#spec');
    if (spec && engine.analyser) {
      const sctx = spec.getContext('2d');
      const bins = new Uint8Array(engine.analyser.frequencyBinCount);
      const draw = () => {
        requestAnimationFrame(draw);
        engine.analyser.getByteFrequencyData(bins);
        const W = spec.width, H = spec.height, n = 42;
        sctx.clearRect(0, 0, W, H);
        const bw = W / n;
        for (let i = 0; i < n; i++) {
          const v = bins[Math.floor(Math.pow(i / n, 1.6) * bins.length)] / 255;
          const h = Math.max(1, v * H);
          const hue = 330 - v * 60;
          sctx.fillStyle = `hsla(${hue}, 90%, ${45 + v * 25}%, ${0.35 + v * 0.65})`;
          sctx.fillRect(i * bw + 0.5, H - h, bw - 1.5, h);
        }
      };
      draw();
    }
  })();
})();
