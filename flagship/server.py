#!/usr/bin/env python3
"""
LOOPTiSCH local server
- Static files for flagship UI
- POST /api/chat → Ollama tool-calling (JSON plan) against Project API schema
- GET  /api/health
"""
from __future__ import annotations

import json
import os
import re
import sys
import traceback
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("LOOPTISCH_PORT", "8777"))
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
# Fast default; override with LOOPTISCH_MODEL=qwen3-coder:30b etc.
MODEL = os.environ.get("LOOPTISCH_MODEL", "llama3.1:latest")

TOOLS_DOC = """
Allowed tools (call only these names with JSON args):

set_bpm(n: number)
set_key(k: string)
set_swing(n: number)
assign_pad(padIndex: 0-15, sampleId: string)
clear_pads()
fill_pads_kit(style?: "dusty"|"hard"|"house"|"halftime")
load_pack_kit(pack: string)   // kit from one library pack slug (see list_packs)
list_packs()
set_step(pad: number, step: 0-15, vel?: number)
clear_pattern(id?: string)
write_groove(name: "boom_bap"|"halftime"|"four_on_floor")
set_arrangement_bar(bar: 0-7, patternId: "A1"|"A2"|"B1"|null)
build_drop_form()
detect_onsets(sampleId?: string)
map_chops_to_pads(startPad?: number)
apply_stretch(padIndex: number, mode?: "project"|"raw")
search_library(q: string)
list_library()
coach_fix_thin()
export_summary()
get_project_state()
balance_mix()
humanize(amount?: number)
ghost_notes()
sidechain_feel()
apply_genre(genre: "boom_bap"|"house"|"halftime")
suggest_next()
toggle_mute(pad: number)
set_level(pad: number, level: number)

Response JSON shape ONLY:
{
  "say": "short status for user (DE or EN)",
  "agent": "Host|Librarian|Chopper|Drummer|Arranger|Remixer|Mixer|Coach|Export",
  "steps": [ {"tool":"name", "args":{}, "why":"one short reason", "risk":"S0|S1|S2"} ],
  "options": null
}

OR when user must choose (genre, remix direction, A/B):
{
  "say": "...",
  "agent": "Remixer",
  "steps": [],
  "options": [
    {"id":"A","label":"...","blurb":"...","steps":[ {"tool":"...","args":{},"why":"...","risk":"S0"} ]}
  ]
}

Rules:
- Prefer missions via steps (1-6 tools).
- Use options for creative forks (genre/remix) — max 3 options.
- Never invent tool names.
- Cannot import audio files; user drops in UI.
- Keep say short, cooperative, non-jargony for laypeople.
"""

SYSTEM = f"""You are LOOPTiSCH Host — cooperative music crew orchestrator.
You help complete beginners AND producers. Complex studio work becomes simple steps.
You control a beat instrument ONLY via tools. You do NOT generate audio files.
Always respond with ONLY valid JSON (no markdown) matching the schema.
Prefer concrete tool steps over advice-only.
If the user is vague, pick a sensible default plan and say what you did.
{TOOLS_DOC}
"""


def ollama_chat(messages: list, model: str) -> str:
    url = f"{OLLAMA.rstrip('/')}/api/chat"
    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": 0.2,
            "num_predict": 500,
        },
        "format": "json",
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return (data.get("message") or {}).get("content") or ""


def extract_json(text: str) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("empty model response")
    # strip fences if any
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            raise
        return json.loads(m.group(0))


def fallback_plan(user_text: str) -> dict:
    """Deterministic backup if Ollama fails."""
    q = user_text.lower()
    if any(w in q for w in ("export", "stem", "bounce", "fertig")):
        return {
            "say": "Export-Plan + Balance.",
            "agent": "Export",
            "steps": [
                {"tool": "balance_mix", "args": {}, "why": "Final balance", "risk": "S0"},
                {"tool": "export_summary", "args": {}, "why": "Stems", "risk": "S0"},
            ],
            "options": None,
            "fallback": True,
        }
    if any(w in q for w in ("thin", "dünn", "muddy", "fix", "mix")):
        return {
            "say": "Mix-Fix: Sub, Balance, Humanize.",
            "agent": "Mixer",
            "steps": [
                {"tool": "coach_fix_thin", "args": {}, "why": "Sub/Snare", "risk": "S1"},
                {"tool": "balance_mix", "args": {}, "why": "Levels", "risk": "S0"},
                {"tool": "humanize", "args": {"amount": 0.12}, "why": "Feel", "risk": "S0"},
            ],
            "options": None,
            "fallback": True,
        }
    if any(w in q for w in ("genre", "house", "skin", "style", "remix")):
        return {
            "say": "Wähle ein Feel — ich stelle Groove & Drive.",
            "agent": "Remixer",
            "steps": [],
            "options": [
                {
                    "id": "boom",
                    "label": "Boom-Bap",
                    "blurb": "Dusty swing",
                    "steps": [
                        {"tool": "fill_pads_kit", "args": {"style": "dusty"}, "why": "kit", "risk": "S1"},
                        {"tool": "write_groove", "args": {"name": "boom_bap"}, "why": "groove", "risk": "S0"},
                        {"tool": "apply_genre", "args": {"genre": "boom_bap"}, "why": "feel", "risk": "S0"},
                    ],
                },
                {
                    "id": "house",
                    "label": "House",
                    "blurb": "Four-on-floor",
                    "steps": [
                        {"tool": "set_bpm", "args": {"n": 124}, "why": "tempo", "risk": "S0"},
                        {"tool": "write_groove", "args": {"name": "four_on_floor"}, "why": "pulse", "risk": "S0"},
                        {"tool": "apply_genre", "args": {"genre": "house"}, "why": "feel", "risk": "S0"},
                    ],
                },
                {
                    "id": "half",
                    "label": "Halftime Dark",
                    "blurb": "Space & weight",
                    "steps": [
                        {"tool": "set_swing", "args": {"n": 62}, "why": "swing", "risk": "S0"},
                        {"tool": "write_groove", "args": {"name": "halftime"}, "why": "pocket", "risk": "S0"},
                        {"tool": "apply_genre", "args": {"genre": "halftime"}, "why": "feel", "risk": "S0"},
                    ],
                },
            ],
            "fallback": True,
        }
    if any(w in q for w in ("drop", "arrang", "form", "8 bar")):
        return {
            "say": "8-Bar Drop-Form.",
            "agent": "Arranger",
            "steps": [
                {"tool": "write_groove", "args": {"name": "boom_bap"}, "why": "main", "risk": "S0"},
                {"tool": "build_drop_form", "args": {}, "why": "form", "risk": "S1"},
            ],
            "options": None,
            "fallback": True,
        }
    if any(w in q for w in ("chop", "slice", "onset", "break")):
        return {
            "say": "Chop → Pads.",
            "agent": "Chopper",
            "steps": [
                {"tool": "detect_onsets", "args": {}, "why": "onsets", "risk": "S0"},
                {"tool": "map_chops_to_pads", "args": {"startPad": 8}, "why": "map", "risk": "S1"},
            ],
            "options": None,
            "fallback": True,
        }
    # default first beat
    return {
        "say": "First Beat: Kit + Boom-Bap. Danach Play.",
        "agent": "Host",
        "steps": [
            {"tool": "fill_pads_kit", "args": {"style": "dusty"}, "why": "kit", "risk": "S1"},
            {"tool": "write_groove", "args": {"name": "boom_bap"}, "why": "groove", "risk": "S0"},
        ],
        "options": None,
        "fallback": True,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print(f"[looptisch] {self.address_string()} {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, obj: dict):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            ollama_ok = False
            try:
                with urllib.request.urlopen(f"{OLLAMA}/api/version", timeout=2) as r:
                    ollama_ok = r.status == 200
            except Exception:
                ollama_ok = False
            return self._json(
                200,
                {
                    "ok": True,
                    "model": MODEL,
                    "ollama": OLLAMA,
                    "ollama_up": ollama_ok,
                },
            )
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] == "/api/rescan":
            import subprocess
            try:
                proc = subprocess.run(
                    [sys.executable, str(ROOT / "library_scan.py")],
                    capture_output=True, text=True, timeout=300, cwd=str(ROOT),
                )
                idx_path = ROOT / "library" / "_index.json"
                data = {}
                if idx_path.exists():
                    data = json.loads(idx_path.read_text(encoding="utf-8"))
                return self._json(200, {
                    "ok": proc.returncode == 0,
                    "log": (proc.stdout or "")[-1200:],
                    "err": (proc.stderr or "")[-600:],
                    "packs": len(data.get("packs", [])),
                    "samples": len(data.get("samples", [])),
                })
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})
        # ——— Essence Engine bridge (local only) ———
        ess_path = self.path.split("?")[0]
        if ess_path in ("/api/essence/cell", "/api/essence/delta"):
            import subprocess, tempfile
            VENV_PY = str(Path.home() / ".hermes/hermes-agent/venv/bin/python")
            BRIDGE = str(ROOT.parent / "tools" / "essence_bridge.py")
            tmp_paths = []
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                if ess_path == "/api/essence/cell":
                    title = self.headers.get("X-Title", "clip")
                    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                        f.write(body); tmp_paths.append(f.name)
                    cmd = [VENV_PY, BRIDGE, "cell", tmp_paths[0], title]
                else:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    import base64
                    for key in ("wav_a", "wav_b"):
                        raw = base64.b64decode(payload.get(key) or "")
                        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                            f.write(raw); tmp_paths.append(f.name)
                    cmd = [VENV_PY, BRIDGE, "delta", tmp_paths[0], tmp_paths[1]]
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
                out = json.loads(proc.stdout or "{}")
                out["engine"] = "signature-of-style"
                return self._json(200 if out.get("ok") else 500, out)
            except Exception as e:
                return self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})
            finally:
                for p in tmp_paths:
                    try: Path(p).unlink()
                    except OSError: pass
        if self.path.split("?")[0] != "/api/chat":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid_json"})

        message = (payload.get("message") or "").strip()
        snapshot = payload.get("snapshot") or {}
        model = payload.get("model") or MODEL
        use_llm = payload.get("use_llm", True)

        if not message:
            return self._json(400, {"error": "empty_message"})

        if not use_llm:
            plan = fallback_plan(message)
            steps = plan.get("steps") or []
            plan["tools"] = [{"name": s.get("tool"), "args": s.get("args") or {}} for s in steps if s.get("tool")]
            return self._json(200, {"ok": True, **plan, "model": None})

        user_blob = {
            "user": message,
            "project": snapshot,
        }
        messages = [
            {"role": "system", "content": SYSTEM},
            {
                "role": "user",
                "content": json.dumps(user_blob, ensure_ascii=False)[:12000],
            },
        ]

        try:
            raw = ollama_chat(messages, model)
            plan = extract_json(raw)
            # normalize steps OR legacy tools[]
            steps = plan.get("steps")
            if not steps:
                legacy = plan.get("tools") or plan.get("tool_calls") or []
                steps = []
                for t in legacy:
                    if not isinstance(t, dict):
                        continue
                    name = t.get("name") or t.get("tool") or ""
                    args = t.get("args") or t.get("arguments") or t.get("parameters") or {}
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            args = {}
                    if name:
                        steps.append({"tool": name, "args": args, "why": t.get("why") or "", "risk": t.get("risk") or "S1"})
            else:
                norm_steps = []
                for t in steps:
                    if not isinstance(t, dict):
                        continue
                    name = t.get("tool") or t.get("name") or ""
                    args = t.get("args") or {}
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            args = {}
                    if name:
                        norm_steps.append({
                            "tool": name,
                            "args": args,
                            "why": t.get("why") or "",
                            "risk": t.get("risk") or "S1",
                        })
                steps = norm_steps

            options = plan.get("options")
            if options and isinstance(options, list):
                norm_opts = []
                for o in options[:3]:
                    if not isinstance(o, dict):
                        continue
                    osteps = []
                    for t in o.get("steps") or []:
                        if not isinstance(t, dict):
                            continue
                        name = t.get("tool") or t.get("name") or ""
                        args = t.get("args") or {}
                        if name:
                            osteps.append({"tool": name, "args": args, "why": t.get("why") or "", "risk": t.get("risk") or "S1"})
                    norm_opts.append({
                        "id": o.get("id") or o.get("label") or f"opt{len(norm_opts)+1}",
                        "label": o.get("label") or o.get("id") or "Option",
                        "blurb": o.get("blurb") or "",
                        "steps": osteps,
                    })
                options = norm_opts or None
            else:
                options = None

            out = {
                "ok": True,
                "say": plan.get("say") or plan.get("message") or "ok",
                "agent": plan.get("agent") or "Host",
                "steps": steps,
                "tools": [{"name": s["tool"], "args": s.get("args") or {}} for s in steps],  # legacy
                "options": options,
                "model": model,
                "raw": raw[:2000],
                "fallback": False,
            }
            return self._json(200, out)
        except Exception as e:
            print("[looptisch] LLM error:", e)
            traceback.print_exc()
            plan = fallback_plan(message)
            steps = plan.get("steps") or []
            plan["tools"] = [{"name": s.get("tool"), "args": s.get("args") or {}} for s in steps if s.get("tool")]
            plan["error"] = str(e)
            plan["ok"] = True
            plan["model"] = model
            return self._json(200, plan)


def main():
    os.chdir(ROOT)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"LOOPTiSCH → http://127.0.0.1:{PORT}/")
    print(f"  model={MODEL}  ollama={OLLAMA}")
    print(f"  health → http://127.0.0.1:{PORT}/api/health")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
