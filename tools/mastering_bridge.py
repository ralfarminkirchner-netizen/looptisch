#!/usr/bin/env python3
"""LOOPTiSCH mastering bridge — Matchering 2.0 reference mastering (local only).

CLI:
  master <target.wav> <reference.wav> <out.wav>

  target   = your mix (from LOOPTiSCH export)
  reference= any track whose sound you want to match (used ONLY as analysis
             reference — no audio from it ends up in the output; that keeps
             the result license-clean with respect to the reference)

Prints JSON: {"ok": true, "out": ..., "log": ...}
Run with the matchering venv: ~/Projects/loop-tisch/.venv-mg/bin/python
"""
from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stderr, redirect_stdout


def main() -> int:
    target, reference, out = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        import matchering as mg
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            mg.process(
                target=target,
                reference=reference,
                results=[mg.pcm16(out)],
            )
        print(json.dumps({"ok": True, "out": out, "log": buf.getvalue()[-600:]}))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
