"""
Interference engine — compare signatures WITHOUT averaging them away.

Principles (from Text Interferometer + ESSENCE):
- show convergence, productive contradiction, minority signal
- never replace sources with a mean "truth"
- claim ceiling always attached to results
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np

from .cell import DEFAULT_CLAIM_CEILING, SignatureCell


@dataclass
class InterferenceHit:
    a_id: str
    b_id: str
    a_title: str
    b_title: str
    domain: str
    distance: float
    similarity: float
    shared_axes: list[str]
    divergences: list[dict[str, Any]]
    relation: str  # close | mid | far | cross-domain

    def to_dict(self) -> dict[str, Any]:
        return {
            "a_id": self.a_id,
            "b_id": self.b_id,
            "a_title": self.a_title,
            "b_title": self.b_title,
            "domain": self.domain,
            "distance": self.distance,
            "similarity": self.similarity,
            "shared_axes": self.shared_axes,
            "divergences": self.divergences,
            "relation": self.relation,
            "claim_ceiling": dict(DEFAULT_CLAIM_CEILING),
            "note": "Interference is not identity. Do not average cells into one.",
        }


def _aligned_vectors(a: SignatureCell, b: SignatureCell) -> tuple[np.ndarray, np.ndarray, list[str]]:
    ka = list(a.body.get("vector_keys") or [])
    kb = list(b.body.get("vector_keys") or [])
    va = list(a.body.get("vector") or [])
    vb = list(b.body.get("vector") or [])
    if not ka or not kb:
        n = min(len(va), len(vb))
        return np.array(va[:n], float), np.array(vb[:n], float), [f"dim{i}" for i in range(n)]
    keys = [k for k in ka if k in set(kb)]
    map_a = dict(zip(ka, va))
    map_b = dict(zip(kb, vb))
    aa = np.array([float(map_a[k]) for k in keys], dtype=float)
    bb = np.array([float(map_b[k]) for k in keys], dtype=float)
    return aa, bb, keys


def pair_interfere(a: SignatureCell, b: SignatureCell, top_div: int = 8) -> InterferenceHit:
    same_domain = a.domain == b.domain
    va, vb, keys = _aligned_vectors(a, b)
    if len(keys) == 0:
        return InterferenceHit(
            a.id, b.id, a.title, b.title, f"{a.domain}|{b.domain}",
            1.0, 0.0, [], [], "far" if same_domain else "cross-domain",
        )

    # Relative L1 per axis — stable for pair comparisons (unlike 2-sample z-scores,
    # which collapse to a near-constant distance whenever axes differ).
    denom = np.abs(va) + np.abs(vb) + 1e-9
    rel = np.abs(va - vb) / denom
    dist = float(np.mean(rel))

    # Cosine similarity support
    na = float(np.linalg.norm(va))
    nb = float(np.linalg.norm(vb))
    if na > 1e-12 and nb > 1e-12:
        cos = float(np.dot(va, vb) / (na * nb))
        cos = max(-1.0, min(1.0, cos))
        cos_dist = 1.0 - cos
    else:
        cos_dist = 1.0
    # blend
    dist = float(0.65 * dist + 0.35 * cos_dist)
    sim = float(np.exp(-3.0 * dist))

    order = np.argsort(-rel)
    divergences = []
    for i in order[:top_div]:
        divergences.append(
            {
                "axis": keys[int(i)],
                "a": float(va[int(i)]),
                "b": float(vb[int(i)]),
                "rel_gap": float(rel[int(i)]),
            }
        )
    shared = [keys[int(i)] for i in np.argsort(rel)[: min(5, len(keys))]]

    if not same_domain:
        relation = "cross-domain"
    elif dist < 0.12:
        relation = "close"
    elif dist < 0.35:
        relation = "mid"
    else:
        relation = "far"

    return InterferenceHit(
        a_id=a.id,
        b_id=b.id,
        a_title=a.title,
        b_title=b.title,
        domain=a.domain if same_domain else f"{a.domain}|{b.domain}",
        distance=dist,
        similarity=sim,
        shared_axes=shared,
        divergences=divergences,
        relation=relation,
    )


def interfere_set(cells: Iterable[SignatureCell], *, same_domain_only: bool = True) -> list[dict[str, Any]]:
    cells = list(cells)
    hits: list[InterferenceHit] = []
    for i in range(len(cells)):
        for j in range(i + 1, len(cells)):
            if same_domain_only and cells[i].domain != cells[j].domain:
                continue
            hits.append(pair_interfere(cells[i], cells[j]))
    hits.sort(key=lambda h: h.distance)
    return [h.to_dict() for h in hits]


def cluster_soft(cells: list[SignatureCell], threshold: float = 0.2) -> list[dict[str, Any]]:
    """
    Soft clusters by single-linkage on distance < threshold.
    Does NOT merge feature vectors — only groups IDs.
    """
    n = len(cells)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        for j in range(i + 1, n):
            if cells[i].domain != cells[j].domain:
                continue
            hit = pair_interfere(cells[i], cells[j])
            if hit.distance < threshold:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    out = []
    for gi, idxs in groups.items():
        out.append(
            {
                "members": [
                    {"id": cells[i].id, "title": cells[i].title, "domain": cells[i].domain}
                    for i in idxs
                ],
                "size": len(idxs),
                "claim_ceiling": dict(DEFAULT_CLAIM_CEILING),
                "note": "Cluster groups related signatures; it does not average them into one essence.",
            }
        )
    out.sort(key=lambda g: -g["size"])
    return out


def minority_signals(hits: list[dict[str, Any]], far_threshold: float = 0.4) -> list[dict[str, Any]]:
    """Pairs that refuse to collapse — productive difference."""
    return [h for h in hits if h["distance"] >= far_threshold]
