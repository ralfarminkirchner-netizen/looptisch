# LOOPTiSCH — Cooperative Agent OS

> Nicht: Chat der über Musik redet.  
> Sondern: **Instrument + Crew**, die komplexe Studio-Arbeit in **gemeinsame, umkehrbare Schritte** zerlegt — so dass Laien mühelos und Profis nicht ausgebremst werden.

Stand: 2026-07-19 · Denk- und Bauebene (Flagship implementiert Kern davon)

---

## 1. These

Musiksoftware ist historisch an **Experten-Grammatik** gebunden (Routing, Busse, Theorie, Menüs).  
Generative KI löst das oft falsch: sie **ersetzt** den Menschen und raubt Grip.

**LOOPTiSCH-These:**  
Komplexität bleibt im System — aber der Mensch sieht nur:

1. **Absicht** („mach einen Drop aus dem Break“)  
2. **Vorschläge** (2–3 hörbare Optionen)  
3. **Freigabe / Undo**  
4. **Pads greifen**

Die Crew **führt aus, erklärt kurz, fragt nur wenn nötig**.

---

## 2. Drei Ebenen (immer gleichzeitig)

| Ebene | Wer | Was |
|-------|-----|-----|
| **Körper** | Mensch | Pads, Steps, Hören, Entscheiden |
| **Werkstatt** | Pro-Modus | Matrix, Mixer, Chop, Arrange — greifbar ohne Chat |
| **Crew** | Agenten | Multi-Step-Pläne, Diagnose, Remix-Pipelines |

**Regel:** Wenn die Crew tot ist, bleibt der Körper spielbar.  
**Regel:** Kein stiller Side-Effect — jede Mutation ist Tool-Call + Undo-Frame.

---

## 3. Kooperations-Protokoll (nicht verhandelbar)

### 3.1 Intent → Plan → Gate → Act → Review

```
User Intent
   ↓
Planner (LLM oder Mission-Template)
   ↓
Plan = [ Step{ tool|human, args, why, reversible } ]
   ↓
UI zeigt Schritte + „Warum“
   ↓
Gate: Auto-run safe steps | Ask on risk | Pick option A/B/C
   ↓
Executor ruft Project-API
   ↓
Review: hören · Undo · „noch was?“
```

### 3.2 Risikoklassen

| Klasse | Beispiele | Gate |
|--------|-----------|------|
| **S0 Safe** | set_swing, set_level, write_groove auf leerem Pat | Auto |
| **S1 Reversible** | fill kit, arrange form, chop map | Auto + 1-Click Undo |
| **S2 Choice** | Genre-Skin, 3 Arrangement-Varianten | **Optionskarten** |
| **S3 Destructive** | clear all, overwrite long work | Explicit confirm |

### 3.3 Mensch bleibt Editor-in-Chief

- Agent **schlägt vor**, Mensch **wählt / verwirft**  
- Generate = **Material**, nie finaler Hit ohne Pad-Entscheidung  
- Jede Mission endet mit **hörbarem Zustand** + Undo

---

## 4. Crew-Rollen (erweitert)

| Agent | Job | Laien-Satz |
|-------|-----|------------|
| **Host** | Versteht Absicht, wählt Mission | „Was willst du machen?“ |
| **Librarian** | Import, Tag, Find, Kit | „Finde dunkle Kicks“ |
| **Chopper** | Onsets, Pad-Maps, Slices | „Mach Pads aus dem Break“ |
| **Drummer** | Grooves, Velocity, Swing | „Boom-Bap fühlen“ |
| **Arranger** | Form 8/16/32 Bars, Energie-Kurve | „Bau Song-Form“ |
| **Remixer** | Halftime, Genre-Skin, Groove-Transfer | „Dunkler / treibender“ |
| **Mixer** | Levels, Mute, Space, Glue-Drive | „Klingt dünn/muddy“ |
| **Coach** | Erklärt 1 Satz + 1 Fix | „Warum klingt das so?“ |
| **Exporter** | Stems, Namen, Bounce-Plan | „Fertig für Social“ |

Host ist **Orchestrator**, nicht Alleskönner-Bot.

---

## 5. Missionen (Laien-Fronttür)

Mission = vordefinierter Plan mit Parametern + optionalen Gates.

| Mission | Input | Ergebnis |
|---------|-------|----------|
| **First Beat** | nichts / 1 Drop | Kit + Groove + Play |
| **Break → Kit** | Loop-Sample | Chops auf Pads + Groove |
| **Drop Builder** | Pattern | 8-Bar Form A1/A2/B1 |
| **Genre Skin** | Genre-Wahl | Swing, Groove, Energy, Drive |
| **Fix the Mix** | „dünn/muddy/harsh“ | Diagnose + Tool-Fixes |
| **Remix Night** | bestehendes Pattern | 3 Varianten zur Wahl |
| **Finish & Export** | Projekt | Naming + Stem-Liste + Checkliste |

Jede Mission ist in der UI ein **großer Knopf** — Chat ist optional, nicht Pflicht.

---

## 6. Komplex → mühelos (Beispiele)

### 6.1 „Ich hab nur einen YouTube-Break“
1. Drop File  
2. Mission **Break → Kit**  
3. Agent: analyze → chop → map pads → write groove → ask swing  
4. Mensch spielt Pads, behält 2 Chops, wirft Rest  
5. Undo jederzeit

### 6.2 „Mach das wie Club, aber warm“
1. Mission **Genre Skin** → Optionen: House / UKG / Deep  
2. Agent setzt BPM-Vorschlag, Swing, Groove, Drive, Arranger-Seed  
3. Mensch hört A/B, wählt  
4. Coach erklärt in einem Satz *warum* es wärmer wirkt (tiefer Kick + weniger Hat-Density)

### 6.3 „Song fertig aber langweilig“
1. Mission **Remix Night**  
2. Drei Pläne parallel als Preview-States (A Variation / B Breakdown / C Double-time hats)  
3. Apply one → Undo stack hält die anderen greifbar

---

## 7. Technik-Vertrag

### 7.1 Harte Project-API (einzige Mutations-Quelle)
Alles was State ändert = benanntes Tool.  
LLM darf **nur** Tools aus der Whitelist. Kein freier JS.

### 7.2 Undo Frame
Vor jedem Plan/S1+ Tool: Snapshot (JSON ohne AudioBuffer; Buffer-IDs bleiben).  
`undo()` / `redo()` first-class.

### 7.3 Plan Schema
```json
{
  "mission": "drop_builder",
  "say": "Ich baue eine 8-Bar-Form…",
  "steps": [
    { "id": "s1", "tool": "write_groove", "args": {"name":"boom_bap"}, "why": "Grundgroove", "risk": "S1" },
    { "id": "s2", "tool": "build_drop_form", "args": {}, "why": "Energie-Kurve", "risk": "S1" }
  ],
  "options": null
}
```
Oder Choice:
```json
{
  "options": [
    { "id": "A", "label": "Dilla swing", "steps": [...] },
    { "id": "B", "label": "Straight quantize", "steps": [...] }
  ]
}
```

### 7.4 Dual Surface
- **Laien:** Missions + große Optionskarten + Play  
- **Werkstatt:** volle Matrix (Power-User / Lernen durch Zusehen)

---

## 8. Was „viel mehr Funktionen“ heißt — ohne Feature-Bloat

Funktionen entstehen als **Agent-fähige Verben**, nicht als 40 Menüs:

| Verb | Unter der Haube |
|------|-----------------|
| `balance_mix` | Levels nach Typ/Energy |
| `apply_genre` | Groove+Swing+Drive+Hat-Density |
| `humanize` | Velocity-Jitter |
| `build_energy_curve` | Arrangement aus Energy-Map |
| `ghost_notes` | leise Offbeat-Hats |
| `sidechain_feel` | Kick vs Bass Velocity-Ducking-Pattern |
| `suggest_next` | nächster kreativer Schritt |
| `explain_state` | Coach-Readout |

Jedes Verb = Tool + Mission-Baustein + Undo.

---

## 9. Roadmap (ehrlich)

| Phase | Lieferobjekt |
|-------|----------------|
| **Jetzt (Flagship Coop)** | Missions UI, Plan-Runner, Undo, erweiterte Tools, Genre/Fix/Drop |
| **Nächste** | Echte Stem-Split, besserer Stretch, A/B Preview-Buffer |
| **Später** | Hörender Agent (Analyse des Mixdowns), MIDI-Out, Export-Bounce |
| **Nicht** | Zweites Logic · Cloud-Only · Agent der ohne Freigabe alles überschreibt |

---

## 10. Erfolgsmaß

Ein Laie ohne Notenlehre kann in **< 5 Minuten**:

1. Sample droppen  
2. Mission starten  
3. Variante wählen  
4. Drop hören  
5. Etwas per Pad ändern  
6. Undo / Export-Plan  

— und versteht *was passiert ist*, ohne Menüwald.

**Spaß = greifen & entscheiden. Arbeit = Crew.**
