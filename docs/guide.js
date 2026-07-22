/**
 * LOOPTiSCH GUIDE — KI-Overlay: kleine pulsierende ✦-Marker direkt an den
 * UI-Elementen, für die es einen passenden nächsten Schritt gibt.
 * Klick → Karte: Was · Warum · Was es bewirkt · [MACH ES] · [später].
 * Stabil: Marker ändern sich nur bei echtem State-Wechsel.
 */
(function (global) {
  'use strict';

  let LT = null;
  let layer = null;
  let popEl = null;
  let activeHints = new Map(); // id → { el, hint }
  let dismissed = new Set();
  let openPop = null;

  const padEl = (i) => document.querySelectorAll('.pad')[i] || null;

  /** Regeln: jede liefert 0..n Hints mit echtem Ziel-Element */
  function rules() {
    const { project, transport, engine } = LT;
    const H = [];
    const padsUsed = project.pads.filter(Boolean).length;
    const stepsUsed = Object.values(project.patterns).some((p) => p.tracks.some((t) => t.some((v) => v > 0)));

    // — PADS: pro Pad passender Schritt (gededuppt: 1 Badge pro Regel-Familie,
    //    bevorzugt das selektierte Pad — Übersicht vor Masse) —
    const fam = { loop: null, tune: null, magnet: null };
    project.pads.forEach((s, i) => {
      if (!s) return;
      const el = padEl(i);
      if (!el) return;
      const buf = s.bufferId ? engine.getBuffer(s.bufferId) : null;
      if (!buf) return;
      const prefer = i === project.selectedPad ? 1 : 0;
      if ((s.type === 'loop' || (s.duration ?? 0) > 2)) {
        const h = { id: `pad-loop`, el, title: 'LOOP ▶ PADS', kind: 'proc', prefer,
          why: `${s.name.slice(0, 22)} ist ein Loop`,
          effect: 'Zerlegt den Loop an den Onsets und legt 8 Chops auf Pads 9–16 — spielbar wie ein MPC-Kit.',
          run: () => { project.selectedPad = i; LT.LT_COPILOT_API?.chains.loop_to_pads(); } };
        if (!fam.loop || prefer > fam.loop.prefer) fam.loop = h;
      }
      if (s.type === 'melodic') {
        const h = { id: `pad-tune`, el, title: 'TUNE ▶ KEY', kind: 'proc', prefer,
          why: `${s.name.slice(0, 22)} ist melodisch`,
          effect: `Pitch-Korrektur auf ${project.key} (AutoTune-Stil) — das Sample passt harmonisch zum Projekt.`,
          run: () => { project.selectedPad = i; LT.setMode('lab'); setTimeout(() => document.querySelector('#btnFlexTune')?.click(), 300); } };
        if (!fam.tune || prefer > fam.tune.prefer) fam.tune = h;
      }
      if (s.bpm && Math.abs(s.bpm - project.bpm) > 2) {
        const dev = Math.abs(s.bpm - project.bpm);
        const h = { id: `pad-magnet`, el, title: 'MAGNET ◉', kind: 'proc', prefer: prefer + dev / 100,
          why: `${s.bpm} bpm ≠ Projekt ${project.bpm}`,
          effect: `Trim + WSOLA-Stretch auf ${project.bpm} bpm + Normalize — das Sample rastet zeitlich exakt ein.`,
          run: () => { project.selectedPad = i; LT.LT_COPILOT_API?.chains.magnet_pad(); } };
        if (!fam.magnet || h.prefer > fam.magnet.prefer) fam.magnet = h;
      }
    });
    for (const h of Object.values(fam)) if (h) H.push(h);

    // — TRANSPORT: Pattern liegt brach —
    const playBtn = document.querySelector('#btnPlay');
    if (playBtn && stepsUsed && !transport.playing) {
      H.push({ id: 'play', el: playBtn, title: '▶ HÖREN', kind: 'nav',
        why: 'Dein Pattern hat Steps',
        effect: 'Startet die Wiedergabe — hör dir an, was du gebaut hast.',
        run: () => { LT.engine.ensure(); LT.transport.toggle(); LT.renderAll(); } });
    }

    // — SEQ: Pads da, Pattern leer —
    const seqPanel = document.querySelector('.seq-panel');
    if (seqPanel && padsUsed > 0 && !stepsUsed) {
      H.push({ id: 'seq-empty', el: seqPanel, title: 'NEURAL KIT ✦', kind: 'gen',
        why: 'Pads belegt, Pattern leer',
        effect: 'magenta DrumsRNN schreibt eine 2-Bar-Groove auf deine Pads — du musst nichts programmieren.',
        run: () => LT.LT_COPILOT_API?.chains.neural_kit() });
    }

    // — FX: passende Effekte —
    const fxChip = (id) => document.querySelector(`.fx-chip[data-fx="${id}"]`);
    if (project.mode === 'pandrum' && fxChip('reverb') && !engine.rack?.slots.find((s) => s.id === 'reverb')?.enabled) {
      H.push({ id: 'fx-hall-pan', el: fxChip('reverb'), title: 'HALL für Pandrum', kind: 'master',
        why: 'Handpan ohne Raum klingt nackt',
        effect: 'Aktiviert HALL (Convolution-Reverb, 30%) — die Pandrum bekommt ihren charakteristischen Nachhall.',
        run: () => { engine.rack.setEnabled('reverb', true); engine.rack.setAmount('reverb', 0.3); fxChip('reverb')?.classList.add('on'); } });
    }
    const selPad = project.pads[project.selectedPad];
    if (project.mode === 'lab' && selPad && (selPad.type === 'loop' || (selPad.duration ?? 0) > 2) && fxChip('delay') && !engine.rack?.slots.find((s) => s.id === 'delay')?.enabled) {
      H.push({ id: 'fx-echo-loop', el: fxChip('delay'), title: 'ECHO 1/4', kind: 'master',
        why: `${selPad.name.slice(0, 20)} läuft als Loop`,
        effect: 'Stereo-Echo (0.32s/0.48s) mit gefilterten Wiederholungen — füllt die Lücken zwischen den Chops rhythmisch.',
        run: () => { engine.rack.setEnabled('delay', true); engine.rack.setAmount('delay', 0.35); fxChip('delay')?.classList.add('on'); } });
    }

    // — MASTER: Mix existiert, Master aus —
    const masterBtn = document.querySelector('#btnAutoMaster');
    if (masterBtn && padsUsed >= 3 && stepsUsed && !engine.masterSuite?.enabled) {
      H.push({ id: 'master', el: masterBtn, title: 'AUTO MASTER', kind: 'master',
        why: 'Mix spielt, Master aus',
        effect: '3-Band-Multiband-Kompression + adaptiver Gain auf −14 LUFS (Streaming-Ziel) — laut und sicher ohne Clipping.',
        run: () => masterBtn.click() });
    }

    // — PANDRUM-Tab: unberührt —
    const panTab = document.querySelector('[data-mode="pandrum"]');
    if (panTab && project.mode !== 'pandrum' && padsUsed === 0) {
      H.push({ id: 'pandrum-tab', el: panTab, title: 'PANDRUM', kind: 'nav',
        why: 'nichts belegt — Handpan ist sofort Musik',
        effect: 'Öffnet die digitale Handpan: 10 Skalen-Modelle, jede Berührung klingt richtig. Kein Setup nötig.',
        run: () => LT.setMode('pandrum') });
    }

    // — lastForge: REF-MASTER —
    const cop = global.LT_COPILOT_API;
    const labTab = document.querySelector('[data-mode="lab"]');
    if (labTab && cop?.state.lastForge && project.mode !== 'lab') {
      H.push({ id: 'refmaster', el: labTab, title: 'REF-MASTER', kind: 'master',
        why: 'ein Render wartet ungemastert',
        effect: 'Matchering 2.0: dein Render wird an einer Referenz gemessen (EQ/Loudness/Dynamics) — Radio-Fertig.',
        run: () => { LT.setMode('lab'); setTimeout(() => document.querySelector('#btnRefMaster')?.click(), 300); } });
    }

    return H.filter((h) => h.el && !dismissed.has(h.id)).slice(0, 8);
  }

  function ensureLayer() {
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'guideLayer';
      document.body.appendChild(layer);
    }
    return layer;
  }

  function closePop() {
    if (popEl) { popEl.remove(); popEl = null; }
    openPop = null;
  }

  function openHint(hint, badge) {
    closePop();
    openPop = hint.id;
    const r = badge.getBoundingClientRect();
    popEl = document.createElement('div');
    popEl.className = 'guide-pop kind-' + (hint.kind || 'nav');
    popEl.innerHTML = `
      <div class="gp-title">${hint.title}</div>
      <div class="gp-why">${hint.why}</div>
      <div class="gp-effect">${hint.effect}</div>
      <div class="gp-actions">
        <button type="button" class="gp-go">MACH ES</button>
        <button type="button" class="gp-later">später</button>
      </div>`;
    document.body.appendChild(popEl);
    const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
    let x = Math.min(window.innerWidth - pw - 10, Math.max(10, r.left + window.scrollX - pw / 2 + 8));
    let y = r.bottom + window.scrollY + 8;
    if (y + ph > window.scrollY + window.innerHeight - 10) y = r.top + window.scrollY - ph - 8;
    popEl.style.left = x + 'px';
    popEl.style.top = y + 'px';
    popEl.querySelector('.gp-go').onclick = () => { closePop(); hint.run(); };
    popEl.querySelector('.gp-later').onclick = () => {
      dismissed.add(hint.id);
      try { sessionStorage.setItem('lt-guide-dismissed', JSON.stringify([...dismissed])); } catch { /* noop */ }
      closePop(); refresh(true);
    };
  }

  function render(hints) {
    const lay = ensureLayer();
    const seen = new Set();
    for (const h of hints) {
      seen.add(h.id);
      let rec = activeHints.get(h.id);
      if (!rec) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'guide-badge kind-' + (h.kind || 'nav');
        b.textContent = '✦';
        b.title = h.title;
        b.onclick = (e) => { e.stopPropagation(); openHint(h, b); };
        lay.appendChild(b);
        rec = { el: b };
        activeHints.set(h.id, rec);
      }
      rec.hint = h;
      // Ziel unsichtbar (versteckter View)? → Badge ausblenden
      const r = h.el.getBoundingClientRect();
      const visible = r.width > 0 || r.height > 0;
      rec.el.style.display = visible ? 'grid' : 'none';
      if (!visible) continue;
      rec.el.style.left = (r.right + window.scrollX - 6) + 'px';
      rec.el.style.top = (r.top + window.scrollY - 6) + 'px';
    }
    // veraltete entfernen
    for (const [id, rec] of activeHints) {
      if (!seen.has(id)) { rec.el.remove(); activeHints.delete(id); }
    }
  }

  let timer = null;
  function refresh(now) {
    clearTimeout(timer);
    timer = setTimeout(() => render(rules()), now ? 0 : 80);
  }

  function reposition() {
    for (const rec of activeHints.values()) {
      if (!rec.hint?.el?.isConnected) { continue; }
      const r = rec.hint.el.getBoundingClientRect();
      const visible = r.width > 0 || r.height > 0;
      rec.el.style.display = visible ? 'grid' : 'none';
      if (!visible) continue;
      rec.el.style.left = (r.right + window.scrollX - 6) + 'px';
      rec.el.style.top = (r.top + window.scrollY - 6) + 'px';
    }
  }

  function init(ltContext) {
    LT = ltContext;
    try { dismissed = new Set(JSON.parse(sessionStorage.getItem('lt-guide-dismissed') || '[]')); } catch { /* noop */ }
    LT.project.on(() => refresh());
    document.addEventListener('click', (e) => {
      if (popEl && !popEl.contains(e.target) && !e.target.classList?.contains('guide-badge')) closePop();
      refresh();
    }, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    setInterval(() => refresh(), 6000);
    refresh(true);
    global.LT_GUIDE_API = { refresh, dismiss: (id) => { dismissed.add(id); refresh(true); } };
  }

  global.LT_GUIDE = { init };
})(window);
