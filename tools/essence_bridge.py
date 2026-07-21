#!/usr/bin/env python3
"""LOOPTiSCH ↔ Essence Engine bridge (local only).

CLI:
  cell  <wav> <title>            → SignatureCell JSON (audio_to_cell)
  delta <wavA> <wavB>            → interfere_set distance/similarity JSON

Uses Ralf's signature-of-style engine. Run with the hermes venv python
(numpy+scipy): ~/.hermes/hermes-agent/venv/bin/python
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SOS = Path.home() / "Projects" / "signature-of-style"
sys.path.insert(0, str(SOS))

from signature_engine import audio_to_cell  # noqa: E402
from signature_engine.interfere import interfere_set  # noqa: E402


def cmd_cell(wav: str, title: str) -> dict:
    cell = audio_to_cell(wav, title=title)
    return {
        "ok": True,
        "id": cell.id,
        "fingerprint": cell.fingerprint(),
        "vector": dict(zip(cell.body.get("vector_keys", []), cell.body.get("vector", []))),
        "claim_ceiling": "Signature = Hypothesenbuendel, kein Identitaetsbeweis.",
    }


def cmd_delta(wav_a: str, wav_b: str) -> dict:
    a = audio_to_cell(wav_a, title="A")
    b = audio_to_cell(wav_b, title="B")
    pairs = interfere_set([a, b], same_domain_only=False)
    return {"ok": True, "pairs": pairs}


if __name__ == "__main__":
    mode = sys.argv[1]
    try:
        if mode == "cell":
            print(json.dumps(cmd_cell(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "clip")))
        elif mode == "delta":
            print(json.dumps(cmd_delta(sys.argv[2], sys.argv[3])))
        else:
            print(json.dumps({"ok": False, "error": "unknown mode"}))
            sys.exit(2)
    except Exception as exc:  # honest failure, never silent
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        sys.exit(1)
