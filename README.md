# LOOPTiSCH

Cooperative beat instrument — MPC pads, multi-track sequencer, arrangement, chop lab, AI crew.

## Live (GitHub Pages)

**https://ralfarminkirchner-netizen.github.io/looptisch/**

Static deploy = app + curated Demo Kit (~5 MB real SampleRadar one-shots).  
Full 2.5 GB library stays local (not in git).

## Local (full library)

```bash
cd flagship
python3 library_scan.py   # after packs land in library/packs/
python3 server.py         # http://127.0.0.1:8777/
```

Optional: Ollama `llama3.1:latest` for LLM crew (`api/chat`).

## Layout

| Path | Role |
|------|------|
| `docs/` | GitHub Pages root (static) |
| `flagship/` | Dev server + full library path |
| `VISION-COOP.md` | Cooperative Agent OS |

## License samples

MusicRadar SampleRadar free packs — royalty-free for music production. See `docs/library/PACKS-LICENSE.md`.
