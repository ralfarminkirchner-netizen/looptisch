"""
Text stylometry: classical features + Burrows' Delta.

References:
- Burrows, J. (2002). 'Delta': a measure of stylistic difference.
- Eder, Rybicki, Kestemont — stylo (R)
- Programming Historian stylometry lesson
- Rank-Turbulence / JS-Delta generalizations (2026 research line)

Implementation is dependency-light (stdlib + numpy) for local-first use.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Iterable

import numpy as np

from .cell import SignatureCell, make_cell

_WORD_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ0-9']+", re.UNICODE)
_SENT_RE = re.compile(r"[.!?…]+")


# High-frequency function-ish words (EN+DE mixed stopband for bilingual Ralf corpora)
FUNCTION_WORDS = [
    # EN
    "the", "and", "to", "of", "a", "in", "that", "is", "it", "for", "as", "with",
    "on", "was", "be", "at", "by", "this", "have", "from", "or", "an", "but",
    "not", "are", "which", "you", "we", "they", "he", "she", "his", "her", "my",
    "i", "me", "if", "so", "what", "when", "who", "how", "all", "can", "will",
    "would", "could", "there", "their", "them", "than", "then", "into", "about",
    # DE
    "der", "die", "das", "und", "in", "den", "von", "zu", "mit", "sich", "des",
    "auf", "für", "ist", "im", "dem", "nicht", "ein", "eine", "als", "auch",
    "es", "an", "werden", "aus", "er", "hat", "dass", "sie", "nach", "wird",
    "bei", "einer", "um", "am", "sind", "noch", "wie", "einem", "über", "so",
    "zum", "war", "haben", "nur", "oder", "aber", "vor", "zur", "bis", "mehr",
    "durch", "man", "sein", "wurde", "sei", "ich", "du", "wir", "ihr", "mir",
    "mich", "uns", "euch", "ihm", "ihn", "ihnen", "wenn", "weil", "dann", "doch",
]


def tokenize_words(text: str) -> list[str]:
    return [w.lower() for w in _WORD_RE.findall(text)]


def sentence_count(text: str) -> int:
    parts = [p for p in _SENT_RE.split(text) if p.strip()]
    return max(1, len(parts))


@dataclass
class TextProfile:
    name: str
    text: str
    tokens: list[str]
    features: dict[str, float]
    vector: list[float]
    vector_keys: list[str]
    word_freq: Counter

    @property
    def n_tokens(self) -> int:
        return len(self.tokens)


def extract_text_features(text: str) -> dict[str, float]:
    tokens = tokenize_words(text)
    n = max(1, len(tokens))
    chars = max(1, len(text))
    sents = sentence_count(text)
    lengths = [len(t) for t in tokens] or [0]
    uniq = len(set(tokens))
    counts = Counter(tokens)

    # Hapax / dislegomena
    hapax = sum(1 for _, c in counts.items() if c == 1)
    dis = sum(1 for _, c in counts.items() if c == 2)

    # Punctuation rates
    punct = {
        "comma_rate": text.count(",") / chars,
        "semicolon_rate": text.count(";") / chars,
        "colon_rate": text.count(":") / chars,
        "dash_rate": (text.count("—") + text.count("–") + text.count("-")) / chars,
        "question_rate": text.count("?") / chars,
        "exclaim_rate": text.count("!") / chars,
        "quote_rate": (text.count('"') + text.count("„") + text.count("“")) / chars,
    }

    # Character n-gram entropy (order-2)
    bigrams = [text[i : i + 2] for i in range(max(0, len(text) - 1))]
    bg_counts = Counter(bigrams)
    bg_n = max(1, len(bigrams))
    entropy = 0.0
    for c in bg_counts.values():
        p = c / bg_n
        entropy -= p * math.log2(p)

    # Yule's K (vocabulary concentration)
    # K = 10^4 * (M2 - N) / N^2
    m2 = sum(c * c for c in counts.values())
    yule_k = 10000.0 * (m2 - n) / (n * n) if n > 1 else 0.0

    # Function word relative frequencies
    fw = {f"fw_{w}": counts.get(w, 0) / n for w in FUNCTION_WORDS}

    base = {
        "tokens": float(n),
        "types": float(uniq),
        "ttr": uniq / n,
        "avg_word_len": float(np.mean(lengths)),
        "std_word_len": float(np.std(lengths)),
        "avg_sent_len": n / sents,
        "hapax_ratio": hapax / n,
        "dis_ratio": dis / n,
        "yule_k": yule_k,
        "char_bigram_entropy": entropy,
        "digit_rate": sum(ch.isdigit() for ch in text) / chars,
        "upper_rate": sum(ch.isupper() for ch in text) / chars,
        **punct,
        **fw,
    }
    return base


def profile_text(name: str, text: str, feature_keys: list[str] | None = None) -> TextProfile:
    tokens = tokenize_words(text)
    features = extract_text_features(text)
    keys = feature_keys or sorted(features.keys())
    # ensure all keys exist
    vector = [float(features.get(k, 0.0)) for k in keys]
    return TextProfile(
        name=name,
        text=text,
        tokens=tokens,
        features=features,
        vector=vector,
        vector_keys=keys,
        word_freq=Counter(tokens),
    )


def burrows_delta(
    unknown: TextProfile,
    candidates: dict[str, TextProfile],
    word_list: list[str] | None = None,
    top_n: int = 150,
    min_std: float = 1e-6,
) -> dict[str, float]:
    """
    Classical Burrows' Delta (stabilized).

    1. Word list from CANDIDATES only (most frequent).
    2. Drop words with near-zero variance across candidates (prevents z explosions).
    3. z-score each profile; Delta = mean |z_u − z_c|.

    Lower = closer style. Not identity proof.
    """
    if not candidates:
        return {}

    # Build word list from candidates only
    if word_list is None:
        combined: Counter = Counter()
        for p in candidates.values():
            combined.update(p.word_freq)
        # Prefer closed-class if corpus tiny
        ranked = [w for w, _ in combined.most_common(max(top_n * 3, 50))]
        # inject function words present in candidates
        for w in FUNCTION_WORDS:
            if w not in ranked and any(p.word_freq.get(w, 0) > 0 for p in candidates.values()):
                ranked.append(w)
        word_list = ranked[: max(top_n, 20)]

    def rel_freq(profile: TextProfile, words: list[str]) -> dict[str, float]:
        n = max(1, profile.n_tokens)
        return {w: profile.word_freq.get(w, 0) / n for w in words}

    # Relative frequencies for all candidate docs
    cand_rels_full = {name: rel_freq(p, word_list) for name, p in candidates.items()}

    # Keep only words with usable variance / presence
    usable: list[str] = []
    means: dict[str, float] = {}
    stds: dict[str, float] = {}
    for w in word_list:
        vals = np.array([cand_rels_full[name][w] for name in cand_rels_full], dtype=float)
        # must appear in at least one candidate
        if float(vals.sum()) <= 0.0:
            continue
        mu = float(vals.mean())
        sd = float(vals.std(ddof=1)) if len(vals) > 1 else float(vals.std(ddof=0))
        if sd < min_std:
            # still allow if word is discriminative via presence elsewhere — skip zero-var
            continue
        usable.append(w)
        means[w] = mu
        stds[w] = sd

    # Fallback: if too few words, use function-word subset with additive smoothing variance
    if len(usable) < 5:
        usable = []
        means = {}
        stds = {}
        fw_present = [w for w in FUNCTION_WORDS if any(p.word_freq.get(w, 0) for p in candidates.values())]
        for w in fw_present[:60]:
            vals = np.array(
                [p.word_freq.get(w, 0) / max(1, p.n_tokens) for p in candidates.values()],
                dtype=float,
            )
            mu = float(vals.mean())
            sd = float(vals.std(ddof=1)) if len(vals) > 1 else 0.0
            sd = max(sd, 1e-4)  # controlled floor, not 1e-12
            usable.append(w)
            means[w] = mu
            stds[w] = sd

    if not usable:
        return {name: 999.0 for name in candidates}

    def z_vec(profile: TextProfile) -> np.ndarray:
        n = max(1, profile.n_tokens)
        return np.array(
            [(profile.word_freq.get(w, 0) / n - means[w]) / stds[w] for w in usable],
            dtype=float,
        )

    z_u = z_vec(unknown)
    out: dict[str, float] = {}
    for name, prof in candidates.items():
        z_c = z_vec(prof)
        out[name] = float(np.mean(np.abs(z_u - z_c)))
    return dict(sorted(out.items(), key=lambda kv: kv[1]))

def cosine_distance(a: list[float], b: list[float]) -> float:
    va = np.array(a, dtype=float)
    vb = np.array(b, dtype=float)
    na = np.linalg.norm(va)
    nb = np.linalg.norm(vb)
    if na < 1e-12 or nb < 1e-12:
        return 1.0
    return float(1.0 - np.dot(va, vb) / (na * nb))


def text_to_cell(
    name: str,
    text: str,
    *,
    actor: str = "agent:hermes",
    source_id: str | None = None,
) -> SignatureCell:
    prof = profile_text(name, text)
    # Compact vector: drop raw token count scale issues by excluding pure counts if needed
    # Keep all for interpretability; comparison layer can subset.
    body = {
        "source_name": name,
        "n_tokens": prof.n_tokens,
        "features": prof.features,
        "vector": prof.vector,
        "vector_keys": prof.vector_keys,
        "sample_preview": text[:400],
    }
    return make_cell(
        domain="text",
        title=name,
        body=body,
        actor=actor,
        method="stylometry.extract_text_features+profile",
        input_ids=[source_id] if source_id else [],
        notes=f"tokens={prof.n_tokens}",
    )


def compare_text_cells(a: SignatureCell, b: SignatureCell) -> dict[str, float]:
    va = a.body.get("vector") or []
    vb = b.body.get("vector") or []
    # Align by keys if possible
    ka = a.body.get("vector_keys") or []
    kb = b.body.get("vector_keys") or []
    if ka and kb and ka != kb:
        map_b = dict(zip(kb, vb))
        vb = [float(map_b.get(k, 0.0)) for k in ka]
        va = list(va)
    return {
        "cosine_distance": cosine_distance(va, vb),
        "l1": float(np.mean(np.abs(np.array(va) - np.array(vb)))) if va and vb else 1.0,
    }
