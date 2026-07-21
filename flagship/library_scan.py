#!/usr/bin/env python3
"""
LOOPTiSCH library scanner
Scannt flagship/library/packs/<slug>/ nach Audio-Dateien und schreibt
flagship/library/_index.json — statisch vom Server auslieferbar.

Felder pro Sample: id, name, path, pack, type, bpm, tags, duration, size, ext.
BPM aus Dateiname/Ordner (60-200), Type aus Heuristik, Dauer via wave/afinfo.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LIB = ROOT / "library"
PACKS = LIB / "packs"
OUT = LIB / "_index.json"

AUDIO_EXT = {".wav", ".aif", ".aiff", ".mp3", ".ogg", ".flac"}

TYPE_RULES = [
    ("kick", re.compile(r"\b(kick|kik|bd|bass\s?drum|bassdrum)\b|(^|[_\-])kd([_\-]|$)", re.I)),
    ("snare", re.compile(r"\b(snare|snr|clap|rimshot|rim|snap|sidestick)\b", re.I)),
    ("hat", re.compile(r"\b(hat|hh|hihat|hi[-_ ]?hat|cymbal|cym|ride|crash|shaker[-_ ]?hat)\b", re.I)),
    ("perc", re.compile(r"\b(perc|tom|conga|bongo|shaker|tamb(ourine)?|cowbell|wood|clave|guiro|bell|agogo|triangle|tabla|djembe)\b", re.I)),
    ("loop", re.compile(r"\b(loop|break|brk|groove|beat|rhythm|fill|drumloop)\b", re.I)),
    ("melodic", re.compile(r"\b(bass|sub|808|keys|piano|rhodes|lead|pluck|pad|chord|synth|melod|arp|vox|vocal|stab|string|guitar|flute|horn)\b", re.I)),
]

BPM_RE = re.compile(r"(?:^|[^0-9])((?:[6-9]\d|1\d\d|200))\s?(?:bpm|BPM)(?:[^0-9]|$)")
BPM_RE2 = re.compile(r"(?:^|[_\- ])((?:[6-9]\d|1\d\d|200))(?:[_\- ]|$)")

TAG_WORDS = {
    "dusty": re.compile(r"dust|vinyl|lofi|lo-fi|old|vintage", re.I),
    "hard": re.compile(r"hard|909|dist|punch|aggro", re.I),
    "open": re.compile(r"open|_oh\b|\boh\b", re.I),
    "closed": re.compile(r"closed|_ch\b|\bch\b", re.I),
    "sub": re.compile(r"\bsub\b|808", re.I),
    "bass": re.compile(r"\bbass\b|808", re.I),
    "break": re.compile(r"break|amen|funky", re.I),
    "clap": re.compile(r"clap", re.I),
    "room": re.compile(r"room|live|hall", re.I),
    "dry": re.compile(r"\bdry\b", re.I),
    "analog": re.compile(r"analog|analogue|machine|drm|tr[-_ ]?\d{3}", re.I),
    "house": re.compile(r"house|deep|garage", re.I),
}


def stable_id(relpath: str) -> str:
    h = hashlib.md5(relpath.encode("utf-8")).hexdigest()[:10]
    return f"pk_{h}"


def wav_duration(path: Path, use_afinfo: bool = False) -> float | None:
    """Fast path: stdlib wave only. afinfo is slow ×5000 files — opt-in."""
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as w:
                frames = w.getnframes()
                rate = w.getframerate()
                if rate:
                    return round(frames / float(rate), 3)
        except Exception:
            pass
    if not use_afinfo:
        return None
    try:
        out = subprocess.run(
            ["afinfo", str(path)], capture_output=True, text=True, timeout=3
        ).stdout
        m = re.search(r"estimated duration:\s*([\d.]+)", out)
        if m:
            return round(float(m.group(1)), 3)
    except Exception:
        pass
    return None


def guess_type(name: str, folder: str, duration: float | None) -> str:
    blob = f"{name} {folder}"
    for typ, rx in TYPE_RULES:
        if rx.search(blob):
            # long 'hat/kick/snare/perc' files are actually loops
            if typ in ("kick", "snare", "hat", "perc") and duration and duration > 2.5:
                return "loop"
            return typ
    if duration and duration > 2.5:
        return "loop"
    return "perc"


def parse_bpm(name: str, folder: str) -> int:
    for rx in (BPM_RE, BPM_RE2):
        m = rx.search(name) or rx.search(folder)
        if m:
            b = int(m.group(1))
            if 60 <= b <= 200:
                return b
    return 0


def parse_tags(name: str, folder: str, pack_slug: str) -> list[str]:
    blob = f"{name} {folder}"
    tags = [t for t, rx in TAG_WORDS.items() if rx.search(blob)]
    tags.append("real")
    tags.append("pack:" + pack_slug)
    return tags


def read_pack_info(pack_dir: Path) -> dict:
    info = {"name": pack_dir.name, "license": "", "source_url": ""}
    pj = pack_dir / "PACK-INFO.json"
    if pj.exists():
        try:
            data = json.loads(pj.read_text(encoding="utf-8"))
            info["name"] = data.get("name") or info["name"]
            info["license"] = data.get("license") or ""
            info["source_url"] = data.get("source_url") or ""
        except Exception:
            pass
    lic = pack_dir / "LICENSE.txt"
    if lic.exists() and not info["license"]:
        try:
            info["license"] = lic.read_text(encoding="utf-8", errors="ignore")[:400].strip()
        except Exception:
            pass
    return info


def scan() -> dict:
    samples: list[dict] = []
    packs: list[dict] = []
    if PACKS.exists():
        for pack_dir in sorted(p for p in PACKS.iterdir() if p.is_dir()):
            slug = pack_dir.name
            info = read_pack_info(pack_dir)
            count = 0
            for f in sorted(pack_dir.rglob("*")):
                if not f.is_file() or f.suffix.lower() not in AUDIO_EXT:
                    continue
                rel = f.relative_to(ROOT).as_posix()
                name = f.stem
                folder = f.parent.relative_to(pack_dir).as_posix() if f.parent != pack_dir else ""
                dur = wav_duration(f) if f.suffix.lower() in (".wav", ".aif", ".aiff", ".mp3", ".flac") else None
                typ = guess_type(name, folder, dur)
                bpm = parse_bpm(name, folder)
                samples.append(
                    {
                        "id": stable_id(rel),
                        "name": name,
                        "path": rel,
                        "pack": slug,
                        "type": typ,
                        "bpm": bpm,
                        "tags": parse_tags(name, folder, slug),
                        "duration": dur,
                        "size": f.stat().st_size,
                        "ext": f.suffix.lower().lstrip("."),
                    }
                )
                count += 1
            if count:
                packs.append({**info, "slug": slug, "count": count})
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "packs": packs,
        "samples": samples,
    }
    LIB.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


if __name__ == "__main__":
    data = scan()
    n = len(data["samples"])
    p = len(data["packs"])
    by_type: dict[str, int] = {}
    for s in data["samples"]:
        by_type[s["type"]] = by_type.get(s["type"], 0) + 1
    print(f"[library_scan] packs={p} samples={n} types={by_type}")
    print(f"[library_scan] wrote {OUT}")
    sys.exit(0)
