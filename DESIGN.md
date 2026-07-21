# DESIGN.md — LOOPTiSCH v2

## Mood
Black studio chassis after midnight. Hot magenta pad strike. Cold LED readouts.
Machine you hit — not a SaaS dashboard.

## Color strategy: Restrained dark product
Brand lives in **hit** (pad strike) and **data** (LEDs). Surfaces stay near-black cool neutral — not warm cream, not neon gradient soup.

```
--bg:        oklch(0.11 0.008 280)
--chassis:   oklch(0.15 0.01 280)
--well:      oklch(0.09 0.006 280)
--raised:    oklch(0.19 0.012 280)
--border:    oklch(0.28 0.015 280)
--ink:       oklch(0.94 0.01 100)
--muted:     oklch(0.58 0.02 280)
--hit:       oklch(0.68 0.22 355)   /* magenta strike */
--hit-dim:   oklch(0.38 0.12 355)
--data:      oklch(0.82 0.12 195)   /* LED cyan */
--ok:        oklch(0.78 0.15 150)
--warn:      oklch(0.8 0.14 75)
--danger:    oklch(0.62 0.2 25)
--rubber:    oklch(0.22 0.02 280)
```

## Type
- UI: "Geist" fallback Inter / system-ui — one family
- Data/LED: "JetBrains Mono"
- Labels 10–11 uppercase tracked; body 12–13; clock 14 mono bold

## Layout (hardware rack)
```
┌ TRANSPORT (chassis strip, meters, clock) ──────────────┐
├ LIBRARY well ┬ PAD DECK (hero) + LED SEQ ──┬ CREW DOCK ┤
│              │  mixer strip under pads      │           │
└──────────────┴──────────────────────────────┴───────────┘
```
Pads = focal silhouette. Everything else supports strike + groove.

## Sound posture
- Master bus: soft clip + light glue
- Voices: multi-layer (body + transient + noise)
- Real samples: gain stage + short attack fade + optional drive
- No clicky digital edges on pad release

## Motion
Pad hit ≤80ms visual. Playhead continuous. No page-load choreography.
