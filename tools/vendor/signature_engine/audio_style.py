"""
Audio signature features without librosa.

Uses numpy + scipy for spectral descriptors that approximate a producer/SFX fingerprint:
- spectral centroid / bandwidth / rolloff
- zero-crossing rate
- RMS energy envelope stats
- spectral flatness
- MFCC-lite via log-mel DCT
- attack time estimate

Suitable for short SFX and longer clips.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from scipy.fft import rfft, rfftfreq
from scipy.io import wavfile

from .cell import SignatureCell, make_cell


def _to_mono_float(data: np.ndarray) -> np.ndarray:
    x = data.astype(np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    # int PCM normalize
    max_abs = np.max(np.abs(x)) if x.size else 1.0
    if max_abs > 1.5:  # likely int
        x = x / max(max_abs, 1.0)
    return x


def load_wav(path: str | Path) -> tuple[int, np.ndarray]:
    sr, data = wavfile.read(str(path))
    return int(sr), _to_mono_float(data)


def frame_signal(x: np.ndarray, frame: int, hop: int) -> np.ndarray:
    if len(x) < frame:
        x = np.pad(x, (0, frame - len(x)))
    n = 1 + (len(x) - frame) // hop
    out = np.stack([x[i * hop : i * hop + frame] for i in range(n)], axis=0)
    return out


def spectral_features(x: np.ndarray, sr: int, frame: int = 1024, hop: int = 256) -> dict[str, float]:
    frames = frame_signal(x, frame, hop)
    window = np.hanning(frame)
    specs = np.abs(rfft(frames * window, axis=1)) + 1e-12
    freqs = rfftfreq(frame, 1.0 / sr)

    # centroid, bandwidth, rolloff, flatness per frame
    mag_sum = specs.sum(axis=1, keepdims=True)
    centroid = (specs * freqs).sum(axis=1) / mag_sum.ravel()
    bandwidth = np.sqrt(((freqs - centroid[:, None]) ** 2 * specs).sum(axis=1) / mag_sum.ravel())
    cumsum = np.cumsum(specs, axis=1)
    rolloff = []
    for i in range(specs.shape[0]):
        thr = 0.85 * cumsum[i, -1]
        idx = int(np.searchsorted(cumsum[i], thr))
        rolloff.append(freqs[min(idx, len(freqs) - 1)])
    rolloff = np.array(rolloff)
    geo = np.exp(np.mean(np.log(specs), axis=1))
    arith = np.mean(specs, axis=1)
    flatness = geo / arith

    # ZCR
    zc = np.mean(np.abs(np.diff(np.signbit(frames), axis=1)), axis=1)

    # RMS
    rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-12)

    # Attack: time to 90% peak from start
    env = np.abs(x)
    # smooth
    k = max(1, sr // 500)
    kernel = np.ones(k) / k
    env_s = np.convolve(env, kernel, mode="same")
    peak = float(np.max(env_s) + 1e-12)
    idx90 = int(np.argmax(env_s >= 0.9 * peak))
    attack = idx90 / sr

    # Duration / decay-ish
    thr_end = 0.05 * peak
    active = np.where(env_s >= thr_end)[0]
    dur = (active[-1] - active[0]) / sr if len(active) else len(x) / sr

    # Compact spectral shape descriptor (stable on short SFX; avoids fragile mel banks)
    # Log-spaced band energies
    n_bands = 12
    band_edges = np.geomspace(max(40.0, freqs[1] if len(freqs) > 1 else 40.0), sr / 2.0, n_bands + 1)
    band_means = []
    for b in range(n_bands):
        mask = (freqs >= band_edges[b]) & (freqs < band_edges[b + 1])
        if not np.any(mask):
            band_means.append(0.0)
        else:
            band_means.append(float(np.mean(specs[:, mask])))
    band_arr = np.array(band_means, dtype=float) + 1e-12
    band_arr = band_arr / band_arr.sum()

    feats: dict[str, float] = {
        "duration_s": float(len(x) / sr),
        "active_duration_s": float(dur),
        "attack_s": float(attack),
        "rms_mean": float(np.mean(rms)),
        "rms_std": float(np.std(rms)),
        "rms_max": float(np.max(rms)),
        "zcr_mean": float(np.mean(zc)),
        "centroid_mean": float(np.mean(centroid)),
        "centroid_std": float(np.std(centroid)),
        "bandwidth_mean": float(np.mean(bandwidth)),
        "rolloff_mean": float(np.mean(rolloff)),
        "flatness_mean": float(np.mean(flatness)),
        "peak_abs": float(np.max(np.abs(x))),
    }
    for i, v in enumerate(band_arr):
        feats[f"band{i}"] = float(v)
    return feats


def synthesize_tone_wav(
    path: str | Path,
    *,
    sr: int = 22050,
    freq: float = 440.0,
    dur: float = 0.4,
    kind: str = "sine",
    noise: float = 0.0,
    attack: float = 0.01,
    decay: float = 0.2,
) -> Path:
    """Utility to create demo wavs without external assets."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    if kind == "sine":
        y = np.sin(2 * np.pi * freq * t)
    elif kind == "saw":
        y = 2 * (t * freq - np.floor(0.5 + t * freq))
    elif kind == "square":
        y = np.sign(np.sin(2 * np.pi * freq * t))
    else:
        y = np.random.randn(len(t))
    if noise > 0:
        y = (1 - noise) * y + noise * np.random.randn(len(t))
    # envelope
    env = np.ones_like(t)
    a_n = max(1, int(attack * sr))
    d_n = max(1, int(decay * sr))
    env[:a_n] = np.linspace(0, 1, a_n)
    if d_n < len(env):
        env[-d_n:] = np.linspace(1, 0, d_n)
    y = 0.4 * y * env
    pcm = np.int16(np.clip(y, -1, 1) * 32767)
    wavfile.write(str(path), sr, pcm)
    return path


def audio_to_cell(
    path: str | Path,
    *,
    title: str | None = None,
    actor: str = "agent:hermes",
) -> SignatureCell:
    path = Path(path)
    sr, x = load_wav(path)
    feats = spectral_features(x, sr)
    keys = sorted(feats.keys())
    vector = [feats[k] for k in keys]
    # normalize-ish vector for comparison: z-score later in interfere
    body = {
        "source_path": str(path),
        "sample_rate": sr,
        "features": feats,
        "vector": vector,
        "vector_keys": keys,
    }
    return make_cell(
        domain="audio",
        title=title or path.stem,
        body=body,
        actor=actor,
        method="audio.spectral_features",
        input_ids=[str(path)],
        notes=f"sr={sr} dur={feats.get('duration_s', 0):.3f}s",
    )


def sfx_params_to_cell(params: dict[str, Any], *, title: str | None = None) -> SignatureCell:
    """
    Bridge from Modern SFX Lab JSON patches.
    Generator-style signature (S2), not rendered audio.
    """
    # Select numeric params into vector
    skip = {"name", "waveType"}
    keys = sorted(k for k, v in params.items() if k not in skip and isinstance(v, (int, float)))
    vector = [float(params[k]) for k in keys]
    # encode wave type as one-hot-ish extra dims
    waves = ["sine", "triangle", "sawtooth", "square", "fm"]
    for w in waves:
        keys.append(f"wave_{w}")
        vector.append(1.0 if params.get("waveType") == w else 0.0)
    body = {
        "params": params,
        "features": {k: vector[i] for i, k in enumerate(keys)},
        "vector": vector,
        "vector_keys": keys,
        "generator": "modern-sfx-lab",
    }
    return make_cell(
        domain="sfx",
        title=title or params.get("name") or "sfx-patch",
        body=body,
        method="sfx.params_to_vector",
        notes="generator params (not audio render)",
    )
